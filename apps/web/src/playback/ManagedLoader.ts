import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "hls.js";
import { type DeliveryRecovery, abortableDelay } from "./DeliveryRecovery";

const MAX_FRAGMENT_BYTES = 16 * 1024 ** 2;
const REQUEST_TIMEOUT_MS = 7_000;

export const managedUrl = (raw: string, manifestUrl: string, origin: string): URL => {
  const url = new URL(raw, origin);
  const manifest = new URL(manifestUrl, origin);
  const directory = manifest.pathname.slice(0, manifest.pathname.lastIndexOf("/") + 1);
  if (
    url.origin !== new URL(origin).origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(directory) ||
    !/^(index\.m3u8|init\.mp4|segment-\d+\.m4s)$/u.test(url.pathname.slice(directory.length))
  )
    throw new Error("The managed media URL is invalid");
  return url;
};

const retryAfterMs = (value: string | null): number => {
  if (value === null) return 0;
  const seconds = Number(value);
  const delay = /^\d+$/u.test(value) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
};

export const createManagedLoader = (
  origin: string,
  manifestUrl: string,
  grant: string,
  recovery: DeliveryRecovery,
  fetchImpl: typeof fetch = fetch,
): { new (): Loader<LoaderContext> } =>
  class ManagedLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    readonly stats: LoaderStats = {
      aborted: false,
      loaded: 0,
      total: 0,
      retry: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };
    private readonly controller = new AbortController();
    private response: Response | null = null;

    abort(): void {
      this.stats.aborted = true;
      this.controller.abort();
    }
    destroy(): void {
      this.abort();
      this.context = null;
    }
    getResponseHeader(name: string): string | null {
      return this.response?.headers.get(name) ?? null;
    }

    load(
      context: LoaderContext,
      _config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      this.context = context;
      this.stats.loading.start = performance.now();
      void this.request(context, callbacks).catch(() => {
        if (!this.controller.signal.aborted)
          callbacks.onError(
            { code: 0, text: "Managed delivery failed" },
            context,
            null,
            this.stats,
          );
      });
    }

    private async request(
      context: LoaderContext,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): Promise<void> {
      let url: URL;
      try {
        url = managedUrl(context.url, manifestUrl, origin);
      } catch {
        callbacks.onError(
          { code: 400, text: "Invalid managed media URL" },
          context,
          null,
          this.stats,
        );
        return;
      }
      const { signal } = this.controller;
      const requestStartedAtMs = Date.now();
      for (let attempt = 0; attempt < 4 && !signal.aborted; attempt += 1) {
        let status = 0;
        let delay = 0;
        let response: Response | null = null;
        const remaining = recovery.remaining();
        if (remaining <= 0) break;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
        try {
          const headers = new Headers({ authorization: `Bearer ${grant}` });
          if (context.rangeStart !== undefined && context.rangeEnd !== undefined)
            headers.set("range", `bytes=${context.rangeStart}-${context.rangeEnd - 1}`);
          response = await fetchImpl(url, {
            headers,
            signal: AbortSignal.any([signal, timeout.signal]),
            redirect: "error",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-cache",
          });
          this.response = response;
          status = response.status;
          this.stats.loading.first = performance.now();
          if (response.ok) {
            const limit =
              context.responseType === "arraybuffer" ? MAX_FRAGMENT_BYTES : 2 * 1024 ** 2;
            const chunks: Uint8Array[] = [];
            let size = 0;
            const reader = response.body?.getReader();
            if (reader === undefined) throw new Error("Missing managed media body");
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.byteLength;
                if (size > limit) {
                  status = 400;
                  throw new Error("Managed response exceeds limit");
                }
                chunks.push(next.value);
              }
            } finally {
              await reader.cancel().catch(() => undefined);
            }
            if (signal.aborted) return;
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            this.stats.loaded = this.stats.total = size;
            this.stats.loading.end = performance.now();
            const data =
              context.responseType === "arraybuffer"
                ? bytes.buffer
                : new TextDecoder().decode(bytes);
            callbacks.onSuccess(
              { url: url.href, data, code: status },
              this.stats,
              context,
              response,
            );
            return;
          }
          delay = retryAfterMs(response.headers.get("retry-after"));
          await response.body?.cancel();
        } catch {
          if (signal.aborted) return;
          // A failure while reading an otherwise successful body is a transport failure.
          if (status >= 200 && status < 300) status = 0;
        } finally {
          clearTimeout(timer);
        }
        if (signal.aborted) return;
        // In particular, 404 is grant/package reconciliation, never a missing segment retry.
        const retriable =
          status === 0 ||
          status === 408 ||
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504;
        const retry =
          retriable && attempt < 3 ? recovery.retry(Date.now(), requestStartedAtMs) : null;
        if (retry === null) {
          callbacks.onError(
            { code: status, text: "Managed delivery could not continue" },
            context,
            response,
            this.stats,
          );
          return;
        }
        this.stats.retry += 1;
        delay = Math.max(
          delay,
          Math.min(4_000, 500 * 2 ** (retry - 1)) * (0.75 + Math.random() * 0.5),
        );
        if (delay >= recovery.remaining()) break;
        await abortableDelay(delay, signal);
      }
      if (!signal.aborted)
        callbacks.onError(
          { code: 0, text: "Managed delivery recovery deadline exceeded" },
          context,
          this.response,
          this.stats,
        );
    }
  };
