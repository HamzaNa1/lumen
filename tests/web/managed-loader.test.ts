import { describe, expect, test } from "bun:test";
import type {
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "../../apps/web/node_modules/hls.js";
import { createManagedLoader, managedUrl } from "../../apps/web/src/playback/ManagedLoader";
import { DeliveryRecovery } from "../../apps/web/src/playback/DeliveryRecovery";
import { managedHlsConfig, managedSeekPosition } from "../../apps/web/src/playback/HlsSource";
import type { MediaElementLike } from "../../apps/web/src/HtmlMediaPlayer";
import type { ManagedDelivery } from "../../packages/contracts/src";

const origin = "https://lumen.test";
const manifest = `${origin}/api/v1/managed-media/track/${"a".repeat(64)}/index.m3u8`;
const fragment = new URL("segment-2.m4s", manifest).href;
const configuration = {
  loadPolicy: {
    maxTimeToFirstByteMs: 7000,
    maxLoadTimeMs: 7000,
    timeoutRetry: null,
    errorRetry: null,
  },
} as LoaderConfiguration;

const load = (fetchImpl: typeof fetch, recovery = new DeliveryRecovery(), url = fragment) => {
  const Loader = createManagedLoader(origin, manifest, "private-grant", recovery, fetchImpl);
  const loader = new Loader();
  const context = { url, responseType: "arraybuffer", type: "media-fragment" } as LoaderContext;
  let stats: LoaderStats | null = null;
  const result = new Promise<{ ok: boolean; code: number; data?: unknown }>((resolve) =>
    loader.load(context, configuration, {
      onSuccess: (response, nextStats) => {
        stats = nextStats;
        resolve({ ok: true, code: response.code ?? 0, data: response.data });
      },
      onError: (error) => resolve({ ok: false, code: error.code }),
      onTimeout: () => resolve({ ok: false, code: 0 }),
    }),
  );
  return {
    result,
    loader,
    get stats() {
      return stats;
    },
  };
};

describe("managed grant transport and bounded recovery", () => {
  test("injects grants in headers, rejects redirects, and retries 429/503 locally", async () => {
    const requests: RequestInit[] = [];
    const urls: string[] = [];
    const mock: typeof fetch = (async (input: URL | string, init: RequestInit) => {
      requests.push(init);
      urls.push(String(input));
      return requests.length === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "0" } })
        : requests.length === 2
          ? new Response(null, { status: 503 })
          : new Response("fragment");
    }) as typeof fetch;
    const pending = load(mock);
    expect(await pending.result).toMatchObject({ ok: true });
    expect(pending.stats?.retry).toBe(2);
    expect(urls).toEqual([fragment, fragment, fragment]);
    expect(urls.some((url) => url.includes("private-grant"))).toBe(false);
    for (const request of requests) {
      expect(new Headers(request.headers).get("authorization")).toBe("Bearer private-grant");
      expect(request.redirect).toBe("error");
      expect(request.credentials).toBe("omit");
      expect(request.referrerPolicy).toBe("no-referrer");
    }
    pending.loader.destroy();
  });

  for (const status of [401, 403, 404]) {
    test(`never retries authorization or package status ${status}`, async () => {
      let count = 0;
      const mock = (async () => {
        count += 1;
        return new Response(null, { status });
      }) as typeof fetch;
      const pending = load(mock);
      expect(await pending.result).toEqual({ ok: false, code: status });
      expect(count).toBe(1);
      pending.loader.destroy();
    });
  }

  test("at most three retries are shared across loaders and stop at the deadline", async () => {
    const recovery = new DeliveryRecovery();
    let count = 0;
    const mock = (async () => {
      count += 1;
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    const pending = load(mock, recovery);
    expect(await pending.result).toEqual({ ok: false, code: 500 });
    expect(count).toBe(4);
    const next = load(mock, recovery);
    expect(await next.result).toEqual({ ok: false, code: 500 });
    expect(count).toBe(5);
    const timed = new DeliveryRecovery();
    timed.retry(Date.now() - 30_001);
    const expired = load(mock, timed);
    expect(await expired.result).toEqual({ ok: false, code: 0 });
    expect(count).toBe(5);
    for (const entry of [pending, next, expired]) entry.loader.destroy();
  });

  test("Retry-After beyond the remaining budget cannot create a timer or immediate retry loop", async () => {
    let count = 0;
    const pending = load((async () => {
      count += 1;
      return new Response(null, { status: 503, headers: { "retry-after": "3600" } });
    }) as typeof fetch);
    expect(await pending.result).toEqual({ ok: false, code: 0 });
    expect(count).toBe(1);
    pending.loader.destroy();
  });

  test("abandoning an obsolete seek request aborts transport without reporting failure or spending retries", async () => {
    let aborted = false;
    let arrived: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const mock = ((_input: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("cancelled", "AbortError"));
        });
        arrived();
      })) as typeof fetch;
    const recovery = new DeliveryRecovery();
    const pending = load(mock, recovery);
    let reported = false;
    void pending.result.then(() => {
      reported = true;
    });
    await requested;
    pending.loader.abort();
    await Bun.sleep(10);
    expect(aborted).toBe(true);
    expect(reported).toBe(false);
    expect(recovery.retry()).toBe(1);
  });

  test("validates every URL and never forwards a grant to another origin, path, or credential-bearing URL", async () => {
    for (const url of [
      "https://other.test/segment-2.m4s",
      `${fragment}?grant=oops`,
      `${fragment}#hash`,
      new URL("../private", manifest).href,
      `${manifest}/extra`,
      fragment.replace("https://", "https://user:password@"),
    ]) {
      let requested = false;
      const pending = load(
        (async () => {
          requested = true;
          return new Response("bytes");
        }) as typeof fetch,
        undefined,
        url,
      );
      expect(await pending.result).toEqual({ ok: false, code: 400 });
      expect(requested).toBe(false);
      pending.loader.destroy();
      expect(() => managedUrl(url, manifest, origin)).toThrow("invalid");
    }
  });

  test("oversized artifacts are refused without another fetch", async () => {
    let requested = 0;
    const pending = load((async () => {
      requested += 1;
      return new Response(new Uint8Array(16 * 1024 ** 2 + 1));
    }) as typeof fetch);
    expect(await pending.result).toEqual({ ok: false, code: 400 });
    expect(requested).toBe(1);
    pending.loader.destroy();
  });
});

test("recovery resets after sustained observed playback, never on byte download or pause", () => {
  const recovery = new DeliveryRecovery();
  expect(recovery.retry(0)).toBe(1);
  expect(recovery.retry(1)).toBe(2);
  expect(recovery.retry(2)).toBe(3);
  expect(recovery.retry(3)).toBeNull();
  recovery.observe(0, true, 0);
  recovery.observe(1, true, 1);
  recovery.observe(40, false, 40_000);
  expect(recovery.retry(40_001)).toBeNull();
  recovery.observe(40, true, 40_000);
  recovery.observe(41, true, 41_000);
  recovery.observe(75, true, 75_000);
  expect(recovery.retry(75_001)).toBe(1);
});

test("hls policies pin finite forward/back buffers and disable library retries to avoid a second budget", () => {
  const config = managedHlsConfig(
    { forwardBufferSeconds: 20, backBufferSeconds: 8 } as ManagedDelivery,
    97,
  );
  expect(config).toMatchObject({
    autoStartLoad: false,
    startPosition: 97,
    maxBufferLength: 20,
    maxMaxBufferLength: 20,
    backBufferLength: 8,
    frontBufferFlushThreshold: 20,
    maxBufferSize: 64 * 1024 ** 2,
    appendErrorMaxRetry: 0,
  });
  expect(config.fragLoadPolicy?.default).toMatchObject({
    errorRetry: null,
    timeoutRetry: null,
    maxLoadTimeMs: 7000,
  });
});

test("stream-copy timeline alignment lands inside held media without jumping unbuffered gaps", () => {
  const element = { buffered: { length: 1, start: () => 0.083 } } as MediaElementLike;
  expect(managedSeekPosition(element, 0)).toBe(0.083);
  expect(managedSeekPosition(element, 105)).toBe(105);
  const distant = { buffered: { length: 1, start: () => 10 } } as MediaElementLike;
  expect(managedSeekPosition(distant, 0)).toBe(0);
  const empty = { buffered: { length: 0 } } as MediaElementLike;
  expect(managedSeekPosition(empty, 0)).toBe(0);
});

test("the recovery deadline includes the failed initial request and stalled playback cannot reset it", () => {
  const recovery = new DeliveryRecovery();
  expect(recovery.retry(7000, 0)).toBe(1);
  expect(recovery.remaining(7000)).toBe(23_000);
  recovery.observe(0, true, 7000);
  recovery.observe(1, true, 8000);
  recovery.observe(1, true, 28_000);
  recovery.observe(2, true, 40_000);
  expect(recovery.retry(40_000)).toBeNull();
});
