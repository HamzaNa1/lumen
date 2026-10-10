import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveArtwork } from "../../apps/server/src/http/ServeArtwork";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const artwork = async () => {
  const directory = await mkdtemp(join(tmpdir(), "lumen-artwork-response-"));
  directories.push(directory);
  const path = join(directory, "poster.png");
  const bytes = Buffer.from("artwork fixture");
  await writeFile(path, bytes);
  const details = await stat(path);
  return {
    request: new Request("http://localhost/api/v1/artwork/example"),
    asset: { path, size: details.size, modifiedAtMs: details.mtimeMs, mimeType: "image/png" },
    revision: createHash("sha256").update(bytes).digest("hex"),
  };
};

test("artwork that grows past the limit after its metadata was read is rejected", async () => {
  const options = await artwork();
  await truncate(options.asset.path, 20 * 1024 * 1024 + 1);
  await expect(serveArtwork(options)).rejects.toMatchObject({ status: 404 });
});

test("artwork replaced by a symlink after its metadata was read is rejected", async () => {
  const options = await artwork();
  const target = `${options.asset.path}.replacement`;
  await writeFile(target, "artwork fixture");
  await rm(options.asset.path);
  await symlink(target, options.asset.path);
  await expect(serveArtwork(options)).rejects.toMatchObject({ status: 404 });
});

test("immutable and revalidated artwork keep authentication in the HTTP cache key", async () => {
  const options = await artwork();
  const immutable = await serveArtwork(options);
  expect(immutable.status).toBe(200);
  expect(immutable.headers.get("cache-control")).toContain("immutable");
  expect(immutable.headers.get("vary")).toBe("Cookie, Authorization");
  expect(await immutable.text()).toBe("artwork fixture");

  for (const revision of [null, "0".repeat(64)]) {
    const response = await serveArtwork({ ...options, revision });
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
    const request = new Request(options.request, {
      headers: { "if-none-match": response.headers.get("etag") ?? "" },
    });
    const unchanged = await serveArtwork({ ...options, request, revision });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("vary")).toBe("Cookie, Authorization");
    await response.body?.cancel();
  }
});
