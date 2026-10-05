import { Data, Effect } from "effect";

type RequestKind = "request" | "login";

interface RateWindow {
  count: number;
  resetAt: number;
}

interface Bucket {
  readonly windows: Partial<Record<RequestKind, RateWindow>>;
  active: number;
}

export class LimitExceeded extends Data.TaggedError("LimitExceeded")<{
  readonly retryAfterSeconds: number;
}> {}

export class RequestLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxRequests: number;
  readonly #loginRequests: number;
  readonly #maxActive: number;

  constructor(options: {
    readonly maxRequests: number;
    readonly loginRequests: number;
    readonly maxActive: number;
  }) {
    this.#maxRequests = options.maxRequests;
    this.#loginRequests = options.loginRequests;
    this.#maxActive = options.maxActive;
  }

  readonly check = (key: string, nowMs: number, kind: RequestKind = "request") =>
    Effect.suspend(() => {
      const bucket: Bucket = this.#buckets.get(key) ?? { windows: {}, active: 0 };
      const existing = bucket.windows[kind];
      const window = existing && existing.resetAt > nowMs
        ? existing
        : { count: 0, resetAt: nowMs + 60_000 };
      const limit = kind === "login" ? this.#loginRequests : this.#maxRequests;
      if (window.count >= limit) {
        return Effect.fail(new LimitExceeded({ retryAfterSeconds: Math.ceil((window.resetAt - nowMs) / 1000) }));
      }
      window.count += 1;
      bucket.windows[kind] = window;
      this.#buckets.set(key, bucket);
      return Effect.void;
    });

  readonly run = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        const bucket: Bucket = this.#buckets.get(key) ?? { windows: {}, active: 0 };
        if (bucket.active >= this.#maxActive) {
          return Effect.fail(new LimitExceeded({ retryAfterSeconds: 1 }));
        }
        bucket.active += 1;
        this.#buckets.set(key, bucket);
        return Effect.succeed(bucket);
      }),
      () => effect,
      (bucket) =>
        Effect.sync(() => {
          bucket.active -= 1;
        }),
    );

  sweep(nowMs: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.active === 0 && Object.values(bucket.windows).every((window) => window.resetAt <= nowMs))
        this.#buckets.delete(key);
    }
  }
}
