import { Data, Effect } from "effect";

interface Bucket {
  count: number;
  resetAt: number;
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

  readonly check = (key: string, nowMs: number, kind: "request" | "login" = "request") =>
    Effect.suspend(() => {
      const existing = this.#buckets.get(key);
      const bucket = existing && existing.resetAt > nowMs
        ? existing
        : { count: 0, resetAt: nowMs + 60_000, active: 0 };
      const limit = kind === "login" ? this.#loginRequests : this.#maxRequests;
      if (bucket.count >= limit) {
        return Effect.fail(new LimitExceeded({ retryAfterSeconds: Math.ceil((bucket.resetAt - nowMs) / 1000) }));
      }
      bucket.count += 1;
      this.#buckets.set(key, bucket);
      return Effect.void;
    });

  readonly run = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const bucket = this.#buckets.get(key) ?? { count: 0, resetAt: 0, active: 0 };
        if (bucket.active >= this.#maxActive) {
          throw new LimitExceeded({ retryAfterSeconds: 1 });
        }
        bucket.active += 1;
        this.#buckets.set(key, bucket);
        return bucket;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          const bucket = this.#buckets.get(key);
          if (bucket !== undefined) bucket.active = Math.max(0, bucket.active - 1);
        }),
    );

  sweep(nowMs: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= nowMs && bucket.active === 0) this.#buckets.delete(key);
    }
  }
}
