import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer, type RunningServer } from "../../apps/server/src/Runtime";
import { seedPlaybackFixture } from "../helpers/playback";
import { newUuid } from "../../apps/server/src/core/Security";
import { PlayerSession, type ManagedDelivery } from "../../packages/contracts/src";
import { Schema } from "../../packages/contracts/node_modules/effect/dist/index.js";
import { ServerApi, bearerCredentials } from "../../packages/client/src";
import { MediaResponseLimiter } from "../../apps/server/src/http/MediaResponseLimiter";

const servers: RunningServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const fixture = async (enabled = true) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-managed-http-"));
  directories.push(root);
  const media = join(root, "media");
  const dataDir = join(root, "data");
  await Promise.all([mkdir(media), mkdir(dataDir)]);
  const databasePath = join(dataDir, "server.sqlite");
  const seeded = await seedPlaybackFixture(media, databasePath, 20_000);
  const movie = join(media, "clip.mp4");
  await copyFile(resolve("tests/fixtures/playback.mp4"), movie);
  const sqlite = new Database(databasePath);
  const info = await stat(movie);
  sqlite.run(
    "UPDATE media_sources SET absolute_path = ?, relative_path = 'clip.mp4', file_size_bytes = ?, modified_at_ms = ?",
    [movie, info.size, info.mtimeMs],
  );
  sqlite.close();
  const server = await startServer({
    dataDir,
    databasePath,
    managedStreaming: enabled,
    streamFreeReserveBytes: 0,
    host: "127.0.0.1",
    port: 0,
    maxRequestsPerMinute: 100_000,
    logLevel: "error",
  });
  servers.push(server);
  const origin = server.server.url.origin;
  const deviceId = newUuid();
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "correct horse battery staple",
      deviceId,
      deviceName: "Managed tests",
      platform: "web",
      platformDeviceId: deviceId,
    }),
  });
  expect(login.status).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const api = new ServerApi({ origin, credentials: bearerCredentials(() => accessToken) });
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const ready = async (sessionId: string): Promise<ManagedDelivery> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await api.managedPlaybackStatus(sessionId);
      if (state.state !== "queued" && state.state !== "preparing") return state;
      await Bun.sleep(25);
    }
    throw new Error("Managed package did not finish");
  };
  return { origin, api, headers, ready, seeded, databasePath, movie, dataDir };
};

describe("managed playback HTTP contract", () => {
  test("old and Auto clients keep the direct URL; managed preparation is separate and idempotent", async () => {
    const { api, seeded, ready } = await fixture();
    expect((await api.identity()).capabilities).toMatchObject({
      managedStreaming: true,
      directPlayOnly: false,
    });
    for (const option of [undefined, "auto", "direct"] as const) {
      const direct = await api.startPlayback(seeded.itemId, option);
      expect(direct.streamUrl).toBe(`/api/v1/media/${seeded.trackId}`);
      expect(direct.managedDelivery).toBeUndefined();
      await api.stopPlayback(direct.sessionId);
    }
    const session = await api.startPlayback(seeded.itemId, "managed");
    expect(Schema.decodeUnknownSync(PlayerSession)(session).streamUrl).toBe(
      `/api/v1/media/${seeded.trackId}`,
    );
    expect(session.managedDelivery?.state).toBe("queued");
    const [first, second] = await Promise.all([
      api.preparePlayback(session.sessionId),
      api.preparePlayback(session.sessionId),
    ]);
    expect(first.packageId).toBe(second.packageId);
    expect((await ready(session.sessionId)).state).toBe("ready");
  });

  test("disabled configuration retains direct-only discovery and reports managed unavailability", async () => {
    const { api, seeded } = await fixture(false);
    expect((await api.identity()).capabilities).toMatchObject({
      managedStreaming: false,
      directPlayOnly: true,
    });
    const session = await api.startPlayback(seeded.itemId, "managed");
    expect(session.managedDelivery?.state).toBe("failed");
    expect((await api.preparePlayback(session.sessionId)).state).toBe("failed");
  });

  test("missing ordinals are repaired only when the intended streams can be verified", async () => {
    const { api, seeded, ready, databasePath } = await fixture();
    const sqlite = new Database(databasePath);
    sqlite.run("UPDATE streams SET ordinal = NULL WHERE kind = 'video'");
    const session = await api.startPlayback(seeded.itemId, "managed");
    await api.preparePlayback(session.sessionId);
    expect((await ready(session.sessionId)).state).toBe("ready");
    expect(
      sqlite
        .query<{ ordinal: number }, []>("SELECT ordinal FROM streams WHERE kind = 'video'")
        .get()?.ordinal,
    ).toBe(0);
    await api.stopPlayback(session.sessionId);
    sqlite.run("UPDATE streams SET ordinal = NULL, language = 'fra' WHERE kind = 'audio'");
    const ambiguous = await api.startPlayback(seeded.itemId, "managed");
    await expect(api.preparePlayback(ambiguous.sessionId)).rejects.toHaveProperty("status", 400);
    expect(
      sqlite
        .query<{ ordinal: number | null }, []>("SELECT ordinal FROM streams WHERE kind = 'audio'")
        .get()?.ordinal,
    ).toBeNull();
    sqlite.close();
  });

  test("a ready cache cannot bypass current source availability or user activity", async () => {
    const { origin, api, seeded, ready, databasePath } = await fixture();
    const session = await api.startPlayback(seeded.itemId, "managed");
    await api.preparePlayback(session.sessionId);
    const delivery = await ready(session.sessionId);
    const url = new URL(delivery.manifestUrl ?? "", origin);
    const headers = { authorization: `Bearer ${session.grantToken}` };
    const sqlite = new Database(databasePath);
    sqlite.run(
      "INSERT INTO media_source_availability(source_id, is_available, updated_at_ms) SELECT source_id, 0, unixepoch() * 1000 FROM tracks WHERE id = ?",
      [seeded.trackId],
    );
    expect((await fetch(url, { method: "HEAD", headers })).status).toBe(404);
    sqlite.run("UPDATE media_source_availability SET is_available = 1");
    expect((await fetch(url, { method: "HEAD", headers })).status).toBe(200);
    sqlite.run("UPDATE users SET is_active = 0 WHERE id = ?", [seeded.userId]);
    expect((await fetch(url, { method: "HEAD", headers })).status).toBe(404);
    sqlite.close();
  });

  test("each artifact is grant-bound before GET, HEAD, conditional, and range handling", async () => {
    const { origin, api, seeded, ready, databasePath } = await fixture();
    const session = await api.startPlayback(seeded.itemId, "managed");
    await api.preparePlayback(session.sessionId);
    const delivery = await ready(session.sessionId);
    const manifest = new URL(delivery.manifestUrl ?? "", origin);
    const grant = { authorization: `Bearer ${session.grantToken}` };
    const response = await fetch(manifest, { headers: grant });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const text = await response.text();
    expect(text).not.toContain("grant");
    expect(text).not.toContain("/tmp");
    const names = ["index.m3u8", "init.mp4", "segment-0.m4s", "segment-1.m4s"];
    for (const name of names) {
      const url = new URL(name, manifest);
      const full = await fetch(url, { headers: grant });
      const etag = full.headers.get("etag") ?? "missing";
      expect(full.status).toBe(200);
      await full.arrayBuffer();
      const conditional = await fetch(url, { headers: { ...grant, "if-none-match": etag } });
      expect(conditional.status).toBe(304);
      const head = await fetch(url, { method: "HEAD", headers: grant });
      expect(head.status).toBe(200);
      const range = await fetch(url, { headers: { ...grant, range: "bytes=0-7" } });
      expect(range.status).toBe(206);
      expect((await range.arrayBuffer()).byteLength).toBe(8);
      for (const method of ["GET", "HEAD"]) {
        const denied = await fetch(url, {
          method,
          headers: { authorization: "Bearer invalid", "if-none-match": etag },
        });
        expect(denied.status).toBe(404);
        await denied.arrayBuffer();
      }
      const missingGrant = await fetch(url);
      expect(missingGrant.status).toBe(401);
      await missingGrant.arrayBuffer();
    }
    const other = await api.startPlayback(seeded.itemId, "managed");
    expect(
      (await fetch(manifest, { headers: { authorization: `Bearer ${other.grantToken}` } })).status,
    ).toBe(404);
    await api.preparePlayback(other.sessionId);
    expect((await ready(other.sessionId)).packageId).toBe(delivery.packageId);
    await api.stopPlayback(session.sessionId);
    for (const name of names) {
      const closed = await fetch(new URL(name, manifest), { method: "HEAD", headers: grant });
      expect(closed.status).toBe(404);
      const fresh = await fetch(new URL(name, manifest), {
        headers: { authorization: `Bearer ${other.grantToken}` },
      });
      expect(fresh.status).toBe(200);
      await fresh.arrayBuffer();
    }
    const wrongItem = manifest.href.replace(seeded.trackId, newUuid());
    expect(
      (await fetch(wrongItem, { headers: { authorization: `Bearer ${other.grantToken}` } })).status,
    ).toBe(404);
    for (const path of [
      "segment-00.m4s",
      "segment-999.m4s",
      "index.m3u8/extra",
      "%2e%2e%2fpackage.json",
    ]) {
      const denied = await fetch(new URL(path, manifest), {
        headers: { authorization: `Bearer ${other.grantToken}` },
      });
      expect(denied.status).toBe(404);
      await denied.arrayBuffer();
    }
    const directTrailing = await fetch(`${origin}${other.streamUrl}/unexpected`, {
      headers: { authorization: `Bearer ${other.grantToken}` },
    });
    expect(directTrailing.status).toBe(404);
    const sqlite = new Database(databasePath);
    sqlite.run("UPDATE playback_grants SET expires_at_ms = 0 WHERE session_id = ?", [
      other.sessionId,
    ]);
    sqlite.close();
    for (const name of names)
      expect(
        (
          await fetch(new URL(name, manifest), {
            method: "HEAD",
            headers: { authorization: `Bearer ${other.grantToken}` },
          })
        ).status,
      ).toBe(404);
  });

  test("missing ready files and source removal fail delivery without GET-triggered regeneration", async () => {
    const { origin, api, seeded, ready, movie, dataDir, databasePath } = await fixture();
    const session = await api.startPlayback(seeded.itemId, "managed");
    await api.preparePlayback(session.sessionId);
    const delivery = await ready(session.sessionId);
    const manifest = new URL(delivery.manifestUrl ?? "", origin);
    await rm(join(dataDir, "stream-cache", delivery.packageId ?? "", "init.mp4"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const missing = await fetch(new URL("init.mp4", manifest), {
        headers: { authorization: `Bearer ${session.grantToken}` },
      });
      expect(missing.status).toBe(404);
      await missing.arrayBuffer();
    }
    expect((await api.managedPlaybackStatus(session.sessionId)).state).toBe("failed");
    const sqlite = new Database(databasePath, { readonly: true });
    expect(
      sqlite.query<{ count: number }, []>("SELECT count(*) AS count FROM playback_progress").get()
        ?.count,
    ).toBe(0);
    sqlite.close();
    await rm(movie);
    expect(
      (
        await fetch(manifest, {
          method: "HEAD",
          headers: { authorization: `Bearer ${session.grantToken}` },
        })
      ).status,
    ).toBe(404);
  });
});

test("response permits cover open bodies, cancellation and HEAD while control admission remains independent", async () => {
  const limiter = new MediaResponseLimiter(2, 1);
  const request = new Request("http://lumen.test/media");
  let releases = 0;
  const body = () => new Response(new ReadableStream<Uint8Array>({ pull() {} }));
  const first = await limiter.run(
    "shared-ip",
    request,
    async () => body(),
    () => {
      releases += 1;
    },
  );
  await expect(limiter.run("shared-ip", request, async () => body())).rejects.toHaveProperty(
    "retryAfterSeconds",
    1,
  );
  const other = await limiter.run("another-ip", request, async () => body());
  await expect(limiter.run("third-ip", request, async () => body())).rejects.toHaveProperty(
    "retryAfterSeconds",
    1,
  );
  await first.body?.cancel();
  expect(releases).toBe(1);
  const head = await limiter.run(
    "shared-ip",
    request,
    async () => new Response(null),
    () => {
      releases += 1;
    },
  );
  expect(head.body).toBeNull();
  expect(releases).toBe(2);
  await other.body?.cancel();
  const completed = await limiter.run(
    "shared-ip",
    request,
    async () => new Response("bytes"),
    () => {
      releases += 1;
    },
  );
  expect(await completed.text()).toBe("bytes");
  expect(releases).toBe(3);
});
