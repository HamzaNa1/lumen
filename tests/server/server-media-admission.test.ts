import { describe, expect, test } from "bun:test";
import { Effect } from "../../apps/server/node_modules/effect/dist/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { createLogger } from "../../apps/server/src/core/Logger";
import { clientKey, normalizeAddress } from "../../apps/server/src/http/ClientIdentity";
import { isMediaRequest, MediaAdmission } from "../../apps/server/src/http/MediaAdmission";
import { makeHttpHandler, type HttpServices } from "../../apps/server/src/http/HttpApp";

const request = (headers: HeadersInit = {}) =>
  new Request("http://lumen.test/api/v1/media/track?grant=private-grant", { headers });
const context = (peerAddress: string | null) => ({ peerAddress });

describe("socket-derived request identity", () => {
  test("untrusted forwarding cannot merge peers or manufacture new rate keys", () => {
    const forged = request({ "x-forwarded-for": "192.0.2.3", "x-real-ip": "192.0.2.4" });
    expect(clientKey(forged, context("192.0.2.1"))).toBe("peer:192.0.2.1");
    expect(clientKey(forged, context("192.0.2.2"))).toBe("peer:192.0.2.2");
    expect(clientKey(forged, context(null), ["192.0.2.3"])).toBe("peer:unknown");
  });
  test("resolves trusted chains from the socket side and fails closed on malformed chains", () => {
    const trusted = ["127.0.0.1", "192.0.2.10"];
    expect(
      clientKey(
        request({ "x-forwarded-for": "203.0.113.9, 192.0.2.20, 192.0.2.10" }),
        context("127.0.0.1"),
        trusted,
      ),
    ).toBe("peer:192.0.2.20");
    expect(
      clientKey(
        request({ "x-forwarded-for": "203.0.113.9, 192.0.2.10" }),
        context("::ffff:127.0.0.1"),
        trusted,
      ),
    ).toBe("peer:203.0.113.9");
    expect(
      clientKey(request({ "x-forwarded-for": "not-an-ip" }), context("127.0.0.1"), trusted),
    ).toBe("peer:127.0.0.1");
    expect(normalizeAddress("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(() => decodeConfig({ LUMEN_TRUSTED_PROXIES: "hostname.test" })).toThrow();
  });
});

describe("media response setup admission", () => {
  test("route matching is exact and excludes control/API traffic and extra path segments", () => {
    expect(isMediaRequest(request())).toBe(true);
    expect(isMediaRequest(new Request("http://x/api/v1/media/track", { method: "HEAD" }))).toBe(
      true,
    );
    for (const path of [
      "/api/v1/media/track/extra",
      "/api/v1/media/",
      "/api/v1/playback/sessions/start",
      "/api/v1/playback/sessions/id/heartbeat",
    ])
      expect(isMediaRequest(new Request(`http://x${path}`))).toBe(false);
    expect(isMediaRequest(new Request("http://x/api/v1/media/track", { method: "POST" }))).toBe(
      false,
    );
  });
  test("managed artifacts use media admission only for exact GET/HEAD routes", () => {
    const root = `http://x/api/v1/managed-media/track/${"a".repeat(64)}`;
    for (const name of ["index.m3u8", "init.mp4", "segment-0.m4s"])
      for (const method of ["GET", "HEAD"])
        expect(isMediaRequest(new Request(`${root}/${name}`, { method }))).toBe(true);
    for (const suffix of ["init.mp4/extra", "../private", "unknown.m4s"])
      expect(isMediaRequest(new Request(`${root}/${suffix}`))).toBe(false);
    expect(isMediaRequest(new Request(`${root}/index.m3u8`, { method: "POST" }))).toBe(false);
  });

  test("managed media bypasses exhausted control allowance and holds body permits by trusted peer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "managed-admission-"));
    const path = join(workspace, "init.mp4");
    await writeFile(path, "abcdefghij");
    let releases = 0;
    const handler = makeHttpHandler(
      {
        playback: {
          managedGrant: () => Effect.succeed({ sessionId: "session", userId: "user" }),
        },
        managedStreaming: {
          available: true,
          artifact: async () => ({
            path,
            size: 10,
            modifiedAtMs: 0,
            mimeType: "video/mp4",
            release: () => {
              releases += 1;
            },
          }),
        },
      } as unknown as HttpServices,
      {
        ...decodeConfig({}),
        maxRequestsPerMinute: 1,
        streamMaxOpenBodies: 2,
        streamMaxOpenBodiesPerIp: 1,
      },
      createLogger({ level: "error", destination: { write() {} } }),
    );
    const url = `http://x/api/v1/managed-media/track/${"a".repeat(64)}/init.mp4`;
    const media = () =>
      new Request(url, {
        headers: { authorization: "Bearer private-grant", "x-forwarded-for": "192.0.2.99" },
      });
    let first: Response | undefined;
    let other: Response | undefined;
    try {
      expect(
        (await handler(new Request("http://x/health/live"), context("192.0.2.1"))).status,
      ).toBe(200);
      expect(
        (await handler(new Request("http://x/health/live"), context("192.0.2.1"))).status,
      ).toBe(429);
      first = await handler(media(), context("192.0.2.1"));
      expect(first.status).toBe(200);
      expect((await handler(media(), context("192.0.2.1"))).status).toBe(429);
      other = await handler(media(), context("192.0.2.2"));
      expect(other.status).toBe(200);
      await first.body?.cancel();
      first = undefined;
      expect(releases).toBe(1);
      expect(await other.text()).toBe("abcdefghij");
      other = undefined;
      expect(releases).toBe(2);
      const next = await handler(media(), context("192.0.2.1"));
      expect(next.status).toBe(200);
      await next.body?.cancel();
      expect(releases).toBe(3);
    } finally {
      await first?.body?.cancel();
      await other?.body?.cancel();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("permits startup/seek bursts across concurrent viewers, refills rates and bounds authenticated identities", () => {
    const admission = new MediaAdmission({
      ...decodeConfig({}),
      mediaBurst: 4,
      mediaRequestsPerMinute: 60,
    });
    for (let index = 0; index < 4; index += 1) {
      admission.enterAuthenticated("user-a", "session-a", 0)();
      admission.enterAuthenticated("user-b", "session-b", 0)();
    }
    expect(() => admission.enterAuthenticated("user-a", "forged-session", 0)).toThrow();
    admission.enterAuthenticated("user-a", "session-a", 1000)();
    admission.enterAuthenticated("user-a", "session-a", 121_000)();
  });

  test("exhausted API allowance does not reject valid media and logs safe parsed ranges/session identity", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "media-admission-"));
    const path = join(workspace, "private-media");
    await writeFile(path, "abcdefghij");
    const records: Array<Record<string, unknown>> = [];
    const handler = makeHttpHandler(
      {
        playback: {
          authorizeGrant: () =>
            Effect.succeed({
              absolutePath: path,
              size: 10,
              modifiedAtMs: 0,
              mimeType: "video/mp4",
              sessionId: "session-id",
              userId: "user-id",
            }),
        },
      } as unknown as HttpServices,
      { ...decodeConfig({}), maxRequestsPerMinute: 1, mediaBurst: 2 },
      createLogger({
        level: "debug",
        format: "json",
        destination: { write: (line) => records.push(JSON.parse(line)) },
      }),
    );
    try {
      expect(
        (await handler(new Request("http://x/health/live"), context("192.0.2.1"))).status,
      ).toBe(200);
      expect(
        (await handler(new Request("http://x/health/live"), context("192.0.2.1"))).status,
      ).toBe(429);
      const media = await handler(
        request({ range: "bytes=2-5", "x-playback-session": "private-forgery" }),
        context("192.0.2.1"),
      );
      expect(media.status).toBe(206);
      expect(await media.text()).toBe("cdef");
      expect(records.at(-1)).toMatchObject({
        range: { kind: "bounded", start: 2, end: 5 },
        playbackSessionId: "session-id",
        expectedResponseBytes: 4,
        admission: "accepted",
      });
      expect((await handler(request(), context("192.0.2.2"))).status).toBe(200);
      const limited = await handler(
        request({ "x-forwarded-for": "192.0.2.99", "x-playback-session": "new-session" }),
        context("192.0.2.3"),
      );
      expect(limited.status).toBe(429);
      expect(limited.headers.get("x-admission-reason")).toBe("media_user_rate");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(JSON.stringify(records)).not.toContain("private-");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("global authorization ceiling spans peers and does not block API or count live file bodies", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const handler = makeHttpHandler(
      {
        playback: {
          authorizeGrant: () =>
            Effect.promise(async () => {
              entered();
              await held;
              return {
                absolutePath: join(import.meta.dir, "../fixtures/playback.mp4"),
                size: 10,
                modifiedAtMs: 0,
                mimeType: "video/mp4",
                sessionId: "session",
                userId: "user",
              };
            }),
        },
      } as unknown as HttpServices,
      { ...decodeConfig({}), mediaMaxGlobalSetups: 1 },
      createLogger({ level: "error", destination: { write: () => undefined } }),
    );
    const pending = handler(request(), context("192.0.2.1"));
    await started;
    try {
      const overloaded = await handler(request(), context("192.0.2.2"));
      expect(overloaded.status).toBe(429);
      expect(overloaded.headers.get("x-admission-reason")).toBe("media_global_setup_capacity");
      expect(
        (await handler(new Request("http://x/health/live"), context("192.0.2.2"))).status,
      ).toBe(200);
    } finally {
      release();
    }
    const first = await pending;
    // Keeping the first body unread must not hold response-creation admission.
    expect((await handler(request(), context("192.0.2.2"))).status).toBe(200);
    await first.body?.cancel();
  });
});

test("preauthorization guard bounds peer identities and reclaims idle buckets", () => {
  const admission = new MediaAdmission(decodeConfig({}));
  for (let index = 0; index < 10_000; index += 1) admission.enterPeer(`peer-${index}`, 0)();
  expect(() => admission.enterPeer("overflow", 0)).toThrow();
  admission.enterPeer("overflow", 120_000)();
});

test("default budgets admit concurrent viewers' startup/seek bursts and release setup slots idempotently", () => {
  const admission = new MediaAdmission(decodeConfig({}));
  for (let burst = 0; burst < 16; burst += 1) {
    const releases: Array<() => void> = [];
    for (let viewer = 0; viewer < 8; viewer += 1) {
      releases.push(admission.enterPeer("shared-peer", 0));
      releases.push(admission.enterAuthenticated(`user-${viewer}`, `session-${viewer}`, 0));
    }
    expect(() => admission.enterPeer("shared-peer", 0)).toThrow();
    for (const release of releases) {
      release();
      release();
    }
  }
});

test("invalid media aliases cannot bypass global admission or enter authorization", async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const handler = makeHttpHandler(
    {
      playback: {
        authorizeGrant: () =>
          Effect.promise(async () => {
            calls += 1;
            entered();
            await held;
            return {
              absolutePath: join(import.meta.dir, "../fixtures/playback.mp4"),
              size: 10,
              modifiedAtMs: 0,
              mimeType: "video/mp4",
              sessionId: "session",
              userId: "user",
            };
          }),
      },
    } as unknown as HttpServices,
    { ...decodeConfig({}), mediaMaxGlobalSetups: 1 },
    createLogger({ level: "error", destination: { write: () => undefined } }),
  );
  const pending = handler(request(), context("192.0.2.1"));
  await started;
  try {
    for (const path of [
      "/api/v1/media/track/",
      "/api//v1/media/track",
      "/api/v1/media//track",
      "/api/v1/media/track/extra",
    ])
      expect(
        (await handler(new Request(`http://x${path}?grant=secret`), context("192.0.2.2"))).status,
      ).not.toBe(200);
    expect(calls).toBe(1);
  } finally {
    release();
    await pending;
  }
});

test("idle expiration never regenerates a partially refilled burst", () => {
  const admission = new MediaAdmission({
    ...decodeConfig({}),
    mediaRequestsPerMinute: 1,
    mediaBurst: 4,
  });
  for (let index = 0; index < 4; index += 1) admission.enterAuthenticated("user", "session", 0)();
  admission.enterAuthenticated("user", "session", 121_000)();
  admission.enterAuthenticated("user", "session", 121_000)();
  expect(() => admission.enterAuthenticated("user", "session", 121_000)).toThrow();
});

test("authenticated setup slots span asynchronous file validation and release after failures", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "setup-slots-"));
  const path = join(workspace, "media");
  await writeFile(path, "abcdefghij");
  const handler = makeHttpHandler(
    {
      playback: {
        authorizeGrant: () =>
          Effect.succeed({
            absolutePath: path,
            size: 10,
            modifiedAtMs: 0,
            mimeType: "video/mp4",
            sessionId: "session",
            userId: "user",
          }),
      },
    } as unknown as HttpServices,
    { ...decodeConfig({}), mediaMaxConcurrentSetups: 1 },
    createLogger({ level: "error", destination: { write: () => undefined } }),
  );
  try {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) => handler(request(), context(`192.0.2.${index + 1}`))),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(
      responses.filter(
        (response) =>
          response.headers.get("x-admission-reason") === "media_authenticated_setup_capacity",
      ),
    ).toHaveLength(3);
    expect((await handler(request(), context("192.0.2.5"))).status).toBe(200);
    await rm(path);
    expect((await handler(request(), context("192.0.2.6"))).status).toBe(404);
    await writeFile(path, "abcdefghij");
    expect((await handler(request(), context("192.0.2.7"))).status).toBe(200);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("only successful authorized media GETs are exempt from transport idle timeouts", async () => {
  let exemptions = 0;
  const transport = {
    peerAddress: "192.0.2.1",
    disableIdleTimeout: () => {
      exemptions += 1;
    },
  };
  const handler = makeHttpHandler(
    {
      playback: {
        authorizeGrant: () =>
          Effect.succeed({
            absolutePath: join(import.meta.dir, "../fixtures/playback.mp4"),
            size: 10,
            modifiedAtMs: 0,
            mimeType: "video/mp4",
            sessionId: "session",
            userId: "user",
          }),
      },
    } as unknown as HttpServices,
    { ...decodeConfig({}), mediaBurst: 2 },
    createLogger({ level: "error", destination: { write: () => undefined } }),
  );
  expect((await handler(new Request("http://x/health/live"), transport)).status).toBe(200);
  expect((await handler(new Request("http://x/api/v1/media/track"), transport)).status).toBe(401);
  expect((await handler(new Request("http://x/api/v1/media/track/"), transport)).status).toBe(404);
  expect(
    (
      await handler(
        new Request("http://x/api/v1/media/track?grant=secret", { method: "HEAD" }),
        transport,
      )
    ).status,
  ).toBe(200);
  expect(exemptions).toBe(0);
  expect((await handler(request(), transport)).status).toBe(200);
  expect(exemptions).toBe(1);
  expect((await handler(request(), transport)).status).toBe(429);
  expect(exemptions).toBe(1);
});
