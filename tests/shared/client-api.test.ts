import { describe, expect, test } from "bun:test";
import {
  bearerCredentials,
  cookieCredentials,
  IncompatibleServerError,
  parseRetryAfterSeconds,
  PlaybackSessionReporter,
  RequestCancelledError,
  ServerApi,
  ServerHttpError,
  ServerUnreachableError,
  TrackSelectionController,
} from "../../packages/client/src/index.ts";
import { defaultTrackMemory, type PlayerState } from "../../packages/contracts/src/index.ts";
import { errorMessage } from "../../packages/app/src/format.ts";

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("HTTP retry feedback", () => {
  const input = { username: "admin", password: "password" };
  const device = { deviceId: "test", deviceName: "Test", platform: "web" as const };

  test.each(["tokenLogin", "tokenRegister", "browserLogin", "browserRegister", "migrateLegacyToken"] as const)(
    "%s exposes retry timing without retrying authentication",
    async (method) => {
      let attempts = 0;
      const api = new ServerApi({
        origin: "https://media.example",
        credentials: cookieCredentials(),
        fetchImpl: async () => {
          attempts += 1;
          return Response.json({ message: "Rate limit exceeded" }, {
            status: 429, headers: { "retry-after": "42" },
          });
        },
      });
      const failure = await (method === "migrateLegacyToken"
        ? api[method]("legacy-token")
        : api[method](input, device)).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ServerHttpError);
      expect(failure).toMatchObject({ status: 429, retryAfterSeconds: 42 });
      expect(errorMessage(failure, "Could not sign in"))
        .toBe("Rate limit exceeded Try again in 42 seconds.");
      expect(attempts).toBe(1);
    },
  );

  test("HTTP dates are relative to the response time, rounded up and never negative", () => {
    const nowMs = Date.parse("Mon, 05 Oct 2026 12:00:00 GMT") + 100;
    expect(parseRetryAfterSeconds("Mon, 05 Oct 2026 12:00:42 GMT", nowMs)).toBe(42);
    expect(parseRetryAfterSeconds("Mon, 05 Oct 2026 11:59:59 GMT", nowMs)).toBe(0);
    expect(parseRetryAfterSeconds("Monday, 05-Oct-26 12:00:42 GMT", nowMs)).toBe(42);
    expect(parseRetryAfterSeconds("Mon Oct  5 12:00:42 2026", nowMs)).toBe(42);
    expect(new ServerHttpError("Rate limit exceeded", 429, 1).message).toContain("in 1 second.");
    expect(new ServerHttpError("Rate limit exceeded", 429, 0).message).toContain("Try again now.");
  });

  test.each([
    ["Asia/Damascus", -180],
    ["America/New_York", 240],
  ] as const)("asctime retry dates use UTC when the client timezone is %s", (timezone, offset) => {
    const errorsModule = new URL("../../packages/client/src/errors.ts", import.meta.url).href;
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { parseRetryAfterSeconds, ServerHttpError } from ${JSON.stringify(errorsModule)};
      const nowMs = Date.parse("2026-10-05T12:00:00.100Z");
      const retryAfterSeconds = parseRetryAfterSeconds("Mon Oct  5 12:00:42 2026", nowMs);
      console.log(JSON.stringify({
        offset: new Date(nowMs).getTimezoneOffset(),
        retryAfterSeconds,
        message: new ServerHttpError("Rate limit exceeded", 429, retryAfterSeconds).message,
      }));
    `], { env: { ...process.env, TZ: timezone } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      offset,
      retryAfterSeconds: 42,
      message: "Rate limit exceeded Try again in 42 seconds.",
    });
  });

  test.each([null, "", "invalid", "-1", "1.5", "Infinity", "1e2", "99999999999999999999"])(
    "missing or invalid Retry-After %s keeps the server's error message",
    async (header) => {
      const api = new ServerApi({
        origin: "https://media.example",
        credentials: cookieCredentials(),
        fetchImpl: async () => Response.json({ message: "Rate limit exceeded" }, {
          status: 429, headers: header === null ? {} : { "retry-after": header },
        }),
      });
      const failure = await api.browserLogin(input, device).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ retryAfterSeconds: null, message: "Rate limit exceeded" });
    },
  );

  test("a rate limit with a non-JSON body still exposes its retry duration", async () => {
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: cookieCredentials(),
      fetchImpl: async () => new Response("Too many requests", {
        status: 429, headers: { "retry-after": "10" },
      }),
    });
    await expect(api.browserLogin(input, device)).rejects
      .toThrow("Server request failed (429) Try again in 10 seconds.");
  });
});

describe("ServerApi sessions", () => {
  test("a response that arrives for a previous session never reaches the next one", async () => {
    const answer = deferred<Response>();
    let token = "first";
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: bearerCredentials(() => token),
      // A transport that ignores cancellation, as a slow proxy might.
      fetchImpl: () => answer.promise,
    });
    const libraries = api.libraries();
    token = "second";
    api.cancelPending();
    answer.resolve(Response.json([{ id: "a", name: "First account's library" }]));
    await expect(libraries).rejects.toBeInstanceOf(RequestCancelledError);
  });

  test("ending a session aborts its outstanding requests", async () => {
    const signals: AbortSignal[] = [];
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: bearerCredentials(() => "token"),
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    const pending = Promise.allSettled([api.home(), api.libraries()]);
    api.cancelPending();
    for (const outcome of await pending)
      expect(outcome).toMatchObject({ status: "rejected", reason: expect.any(RequestCancelledError) });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    // The next session's requests are unaffected.
    const next = new ServerApi({
      origin: "https://media.example",
      credentials: bearerCredentials(() => "token"),
      fetchImpl: async () => Response.json([]),
    });
    next.cancelPending();
    expect(await next.libraries()).toEqual([]);
  });

  test("a mutation that fails in transit is not sent again", async () => {
    let attempts = 0;
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: bearerCredentials(() => "token"),
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
    });
    await expect(api.startScan("library", "full")).rejects.toBeInstanceOf(ServerUnreachableError);
    expect(attempts).toBe(1);
  });

  test("errors do not assume which app is asking", async () => {
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: cookieCredentials(),
      fetchImpl: async () => Response.json({ serverId: "s", displayName: "Lumen", apiVersion: "2.0.0" }),
    });
    const failure = await api.identity().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(IncompatibleServerError);
    expect((failure as Error).message).not.toContain("Desktop");
  });

  test("a browser session sends the cookie and a CSRF header only on mutations", async () => {
    const seen: { method: string; csrf: string | null; credentials: unknown; auth: string | null }[] = [];
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: cookieCredentials(),
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init.headers);
        seen.push({
          method: init.method ?? "GET",
          csrf: headers.get("x-lumen-csrf"),
          credentials: init.credentials,
          auth: headers.get("authorization"),
        });
        return Response.json([]);
      },
    });
    await api.libraries();
    await api.setWatched("item", true);
    expect(seen).toEqual([
      { method: "GET", csrf: null, credentials: "same-origin", auth: null },
      { method: "PUT", csrf: "1", credentials: "same-origin", auth: null },
    ]);
  });

  test("a rejected session is reported, but a wrong password is not", async () => {
    let rejected = 0;
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: cookieCredentials(),
      onUnauthorized: () => {
        rejected += 1;
      },
      fetchImpl: async () => Response.json({ message: "Invalid username or password" }, { status: 401 }),
    });
    const device = { deviceId: "d", deviceName: "Browser", platform: "web" as const };
    await expect(api.browserLogin({ username: "a", password: "b" }, device)).rejects.toThrow(
      "Invalid username or password",
    );
    expect(await api.browserSession()).toBeNull();
    expect(rejected).toBe(0);
    await expect(api.libraries()).rejects.toThrow();
    expect(rejected).toBe(1);
  });
});

describe("track memory capability", () => {
  test.each([undefined, {}, { trackMemory: false }])(
    "an older server advertising %j receives no track memory requests",
    async (capabilities) => {
      const requests: string[] = [];
      const api = new ServerApi({
        origin: "https://media.example",
        credentials: cookieCredentials(),
        fetchImpl: async (url) => {
          requests.push(url.pathname);
          return url.pathname === "/api/v1/server"
            ? Response.json({ serverId: "s", displayName: "Old server", apiVersion: "1.0.0", capabilities })
            : Response.json({ message: "Not found" }, { status: 404 });
        },
      });
      await api.identity();
      expect(await api.trackPreferences()).toBeNull();
      await expect(api.updateTrackPreferences({ audioLanguage: "ja" })).rejects.toThrow("does not support");
      expect(await api.saveTrackChoice("session", { kind: "audio", choice: "audio" })).toBeNull();

      const applied: (string | null)[] = [];
      const errors: (string | null)[] = [];
      const controller = new TrackSelectionController({
        sourceId: "file",
        streams: [{ id: "audio", kind: "audio", ordinal: 1, language: "ja", title: null, codec: "aac", isDefault: false }],
        assertActive: () => undefined,
        apply: async (_kind, id) => { applied.push(id); },
        save: (input) => api.saveTrackChoice("session", input),
        onError: (message) => { errors.push(message); },
      });
      await controller.select("audio", "audio");
      await controller.select("subtitle", null);
      await controller.reset("audio");
      await controller.retry();
      expect(applied).toContain("audio");
      expect(errors.filter((message) => message !== null)).toEqual([]);
      expect(requests).toEqual(["/api/v1/server"]);
    },
  );

  test("advertised support enables reads and writes, and a refreshed handshake can remove it", async () => {
    let enabled = true;
    const requests: string[] = [];
    const memory = defaultTrackMemory();
    const api = new ServerApi({
      origin: "https://media.example",
      credentials: bearerCredentials(() => "token"),
      fetchImpl: async (url, init) => {
        requests.push(`${init.method ?? "GET"} ${url.pathname}`);
        if (url.pathname === "/api/v1/server")
          return Response.json({ serverId: "s", displayName: "Server", apiVersion: "1.0.0", capabilities: { trackMemory: enabled } });
        if (url.pathname.endsWith("track-preferences")) return Response.json(memory.preferences);
        return Response.json(memory);
      },
    });
    await api.identity();
    expect(await api.trackPreferences()).toEqual(memory.preferences);
    expect(await api.updateTrackPreferences({ subtitleLanguage: "en" })).toEqual(memory.preferences);
    expect(await api.saveTrackChoice("session", { kind: "subtitle", choice: "off" })).toEqual(memory);
    enabled = false;
    await api.identity();
    expect(await api.trackPreferences()).toBeNull();
    expect(await api.saveTrackChoice("session", { kind: "subtitle", choice: null })).toBeNull();
    expect(requests).toEqual([
      "GET /api/v1/server",
      "GET /api/v1/me/track-preferences",
      "PATCH /api/v1/me/track-preferences",
      "PUT /api/v1/playback/sessions/session/track-choice",
      "GET /api/v1/server",
    ]);
  });
});

describe("playback session reporting", () => {
  const state = { sessionId: "s", itemId: "i", positionSeconds: 1 } as PlayerState;
  const recorder = () => {
    const calls: string[] = [];
    const heartbeat = deferred<void>();
    return {
      calls,
      heartbeat,
      api: {
        heartbeat: async () => {
          calls.push("heartbeat");
          await heartbeat.promise;
        },
        progress: async (_session: string, _state: PlayerState, sequence: number) => {
          calls.push(`progress ${sequence}`);
        },
        stopPlayback: async () => {
          calls.push("stop");
        },
      },
    };
  };

  test("progress writes carry increasing sequence numbers, even around a slow heartbeat", async () => {
    const { api, calls, heartbeat } = recorder();
    const reporter = new PlaybackSessionReporter(api, "s", () => undefined);
    await reporter.tick(state);
    await reporter.tick(state);
    const third = reporter.tick(state); // heartbeat, held open
    await reporter.saveProgress(state); // the viewer paused meanwhile
    heartbeat.resolve();
    await third;
    for (let tick = 0; tick < 3; tick += 1) await reporter.tick(state);
    const sequences = calls.filter((call) => call.startsWith("progress")).map((call) => Number(call.split(" ")[1]));
    expect(sequences).toEqual([4, 7]);
    expect(calls.filter((call) => call === "heartbeat")).toHaveLength(2);
  });

  test("a retired session reports nothing more on its own, but can save its final position", async () => {
    const { api, calls, heartbeat } = recorder();
    const errors: unknown[] = [];
    const reporter = new PlaybackSessionReporter(api, "s", (cause) => errors.push(cause));
    for (let tick = 0; tick < 5; tick += 1) {
      if (tick === 2) heartbeat.resolve();
      await reporter.tick(state);
    }
    reporter.retire();
    await reporter.tick(state); // would have been the sixth tick's progress write
    expect(calls).toEqual(["heartbeat"]);
    await reporter.saveProgress(state);
    await reporter.end();
    expect(calls).toEqual(["heartbeat", "progress 6", "stop"]);
    expect(errors).toEqual([]);
  });
});

describe("ServerApi artwork", () => {
  const id = "0191f0c1-5b7a-7000-8000-000000000001";
  const revision = "a".repeat(64);
  const api = (fetchImpl: ConstructorParameters<typeof ServerApi>[0]["fetchImpl"]) =>
    new ServerApi({
      origin: "https://media.example",
      credentials: bearerCredentials(() => "token"),
      fetchImpl,
    });

  test("an image is addressed by its revision when the server gave one", () => {
    const paths = api(async () => new Response());
    expect(paths.artworkPath({ id, revision })).toBe(`/api/v1/artwork/${id}?revision=${revision}`);
    expect(paths.artworkPath({ id, revision: null })).toBe(`/api/v1/artwork/${id}`);
  });

  test("listings keep the revision, and tolerate a server that sends none", async () => {
    const item = {
      id,
      libraryId: id,
      title: "Film",
      kind: "movie",
      durationMs: null,
      year: null,
      artworkId: id,
      resumePositionSeconds: null,
    };
    const page = await api(async () =>
      Response.json({ items: [{ ...item, artworkRevision: revision }, item], nextCursor: null }),
    ).items(id, null);
    expect(page.items.map((listed) => listed.artworkRevision)).toEqual([revision, undefined]);
  });

  test("a caching transport carries the image request, with this session's token", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const image = await api(async () => {
      throw new Error("Artwork must not use the default transport");
    }).artworkImage({ id, revision }, async (input, init) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init.headers).get("authorization"),
      });
      return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/webp" } });
    });
    expect(image).toEqual({ mimeType: "image/webp", bytes: new Uint8Array([1, 2]) });
    expect(seen).toEqual([
      {
        url: `https://media.example/api/v1/artwork/${id}?revision=${revision}`,
        authorization: "Bearer token",
      },
    ]);
  });
});
