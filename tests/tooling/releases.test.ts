import { describe, expect, test } from "bun:test";
import {
  assertCanPromote,
  isReleaseVersion,
  latestStableTag,
  planRelease,
  releasePaths,
} from "../../scripts/lib/releases";
import { parseProduct } from "../../scripts/lib/products";

describe("independent release policy", () => {
  test("validates product names and versions before using them in commands or paths", () => {
    expect(() => parseProduct("../server")).toThrow();
    for (const version of ["0.0.8", "1.2.3-rc.1", "1.2.3-alpha-1"])
      expect(isReleaseVersion(version)).toBe(true);
    for (const version of [
      undefined,
      "01.2.3",
      "1.2",
      "v1.2.3",
      "1.2.3-rc.01",
      "1.2.3\n",
      "1.2.3+build",
      "1.2.3;echo bad",
    ]) {
      expect(isReleaseVersion(version)).toBe(false);
    }
  });

  test("uses the legacy combined tag as the initial baseline", () => {
    expect(planRelease("server", "0.0.8", ["v0.0.7", "v0.0.6"])).toEqual({
      version: "0.0.8",
      tag: "server-v0.0.8",
      prerelease: false,
      previousTag: "v0.0.7",
    });
    expect(() => planRelease("desktop", "0.0.7", ["v0.0.7"])).toThrow("must be newer");
  });

  test("ignores releases of the other product and compares versions numerically", () => {
    const tags = ["desktop-v3.0.0", "server-v0.0.9", "server-v0.0.10", "v0.0.7", "unrelated"];
    expect(planRelease("server", "0.0.11", tags).previousTag).toBe("server-v0.0.10");
    expect(() => planRelease("server", "0.0.9", tags)).toThrow("already exists");
    expect(() => planRelease("server", "0.0.8", tags)).toThrow("must be newer");
    expect(planRelease("desktop", "0.0.8", ["server-v0.0.8", "v0.0.7"]).tag).toBe("desktop-v0.0.8");
  });

  test("allows a stable release while a future prerelease exists", () => {
    const tags = ["server-v0.0.9-rc.1", "server-v0.0.7"];
    expect(planRelease("server", "0.0.8", tags).previousTag).toBe("server-v0.0.7");
    expect(latestStableTag("server", tags)).toBe("server-v0.0.7");
    expect(() => planRelease("server", "0.0.8-rc.1", tags)).toThrow("must be newer");
  });

  test("orders prereleases and excludes them from the stable compatibility baseline", () => {
    const tags = ["desktop-v0.0.8-rc.2", "desktop-v0.0.8-rc.10", "v0.0.7"];
    expect(planRelease("desktop", "0.0.8-rc.11", tags).previousTag).toBe("desktop-v0.0.8-rc.10");
    expect(planRelease("desktop", "0.0.8", tags).prerelease).toBe(false);
    expect(latestStableTag("desktop", tags)).toBe("v0.0.7");
  });

  test("includes shared dependencies in each product's release notes", () => {
    expect(releasePaths("server")).toContain("packages/contracts");
    expect(releasePaths("server")).toContain("packages/database");
    expect(releasePaths("server")).not.toContain("apps/desktop");
    expect(releasePaths("desktop")).toContain("packages/contracts");
    expect(releasePaths("desktop")).toContain("packages/ui");
    expect(releasePaths("desktop")).not.toContain("packages/database");
  });

  test("retries promotion only while the published version is still the newest stable release", () => {
    expect(() =>
      assertCanPromote("server", "0.0.8", [
        "v0.0.7",
        "server-v0.0.8",
        "server-v0.0.9-rc.1",
        "desktop-v1.0.0",
      ]),
    ).not.toThrow();
    expect(() => assertCanPromote("server", "0.0.8", ["server-v0.0.8", "server-v0.0.9"])).toThrow(
      "must be newer",
    );
    expect(() => assertCanPromote("server", "0.0.8", ["v0.0.7"])).toThrow("has not been published");
    expect(() => assertCanPromote("server", "0.0.9-rc.1", ["server-v0.0.9-rc.1"])).toThrow(
      "Prereleases cannot",
    );
  });
});
