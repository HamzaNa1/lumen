import { describe, expect, test } from "bun:test";
import {
  assertCanPromote,
  isReleaseVersion,
  latestStableTag,
  planRelease,
  releaseTag,
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
      tag: "v0.0.8+server",
      prerelease: false,
      previousTag: "v0.0.7",
    });
    expect(() => planRelease("desktop", "0.0.7", ["v0.0.7"])).toThrow("already exists");
  });

  test("ignores releases of the other product and compares versions numerically", () => {
    const tags = ["desktop-v3.0.0", "server-v0.0.9", "server-v0.0.10", "v0.0.7", "unrelated"];
    expect(planRelease("server", "0.0.11", tags).previousTag).toBe("server-v0.0.10");
    expect(() => planRelease("server", "0.0.9", tags)).toThrow("already exists");
    expect(() => planRelease("server", "0.0.8", tags)).toThrow("must be newer");
    expect(planRelease("desktop", "0.0.8", ["server-v0.0.8", "v0.0.7"]).tag).toBe("v0.0.8+desktop");
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
    // The server release ships the web app, so its frontend is the server's to announce.
    for (const path of ["apps/web", "packages/client", "packages/app", "packages/ui"])
      expect(releasePaths("server")).toContain(path);
    for (const path of ["packages/client", "packages/app"])
      expect(releasePaths("desktop")).toContain(path);
    expect(releasePaths("desktop")).not.toContain("apps/web");
    expect(releasePaths("desktop")).toContain("packages/contracts");
    expect(releasePaths("desktop")).toContain("packages/ui");
    expect(releasePaths("desktop")).not.toContain("packages/database");
  });

  test("uses version-first tags without treating the product as a prerelease", () => {
    expect(releaseTag("server", "0.0.10")).toBe("v0.0.10+server");
    expect(releaseTag("desktop", "0.0.10-rc.2")).toBe("v0.0.10-rc.2+desktop");
    expect(planRelease("server", "0.0.10", ["server-v0.0.9"]).prerelease).toBe(false);
    expect(planRelease("desktop", "0.0.10-rc.2", []).prerelease).toBe(true);
  });

  test("continues each product's history across all tag formats", () => {
    const tags = [
      "v0.0.8",
      "server-v0.0.9",
      "desktop-v0.0.9",
      "v0.0.10+server",
      "v2.0.0+desktop",
      "v0.0.11-rc.1+server",
    ];
    expect(latestStableTag("server", tags)).toBe("v0.0.10+server");
    expect(latestStableTag("desktop", tags)).toBe("v2.0.0+desktop");
    expect(planRelease("server", "0.0.11", tags).previousTag).toBe("v0.0.10+server");
    expect(planRelease("desktop", "2.0.1", tags).previousTag).toBe("v2.0.0+desktop");
    expect(() => planRelease("server", "0.0.9", tags)).toThrow("already exists");
    expect(() => planRelease("server", "0.0.10", tags)).toThrow("already exists");
    expect(() => planRelease("server", "0.0.7", tags)).toThrow("must be newer");
    expect(
      latestStableTag("server", ["v5.0.0+desktop", "v3.0.0+server.extra", "server-vinvalid"]),
    ).toBeUndefined();
  });

  test("promotes only the newest stable product release with either product tag format", () => {
    expect(() =>
      assertCanPromote("server", "0.0.10", ["server-v0.0.9", "v0.0.10+server", "v9.0.0+desktop"]),
    ).not.toThrow();
    expect(() => assertCanPromote("server", "0.0.9", ["server-v0.0.9", "v0.0.10+server"])).toThrow(
      "must be newer",
    );
    expect(() => assertCanPromote("server", "0.0.11-rc.1", ["v0.0.11-rc.1+server"])).toThrow(
      "Prereleases cannot",
    );
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
