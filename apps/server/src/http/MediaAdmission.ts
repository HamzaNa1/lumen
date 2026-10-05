import { LimitExceeded } from "../core/Limits";
import type { ServerConfig } from "../config/Config";

interface Budget {
  tokens: number;
  updatedAt: number;
  active: number;
  readonly rate: number;
  readonly burst: number;
}

export const mediaTrackIdFor = (request: Request): string | null => {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  return /^\/api\/v1\/media\/([^/]+)$/u.exec(new URL(request.url).pathname)?.[1] ?? null;
};

export const managedMediaArtifactFor = (
  request: Request,
): {
  readonly trackId: string;
  readonly packageId: string;
  readonly artifact: string;
} | null => {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const match =
    /^\/api\/v1\/managed-media\/([^/]+)\/([a-f0-9]{64})\/(index\.m3u8|init\.mp4|segment-\d+\.m4s)$/u.exec(
      new URL(request.url).pathname,
    );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { trackId: match[1], packageId: match[2], artifact: match[3] };
};

export const isMediaRequest = (request: Request): boolean =>
  mediaTrackIdFor(request) !== null || managedMediaArtifactFor(request) !== null;

/** Covers grant authorization and response creation. Live Bun.file transfers are not counted. */
export class MediaAdmission {
  private readonly peers = new Map<string, Budget>();
  private readonly users = new Map<string, Budget>();
  private readonly sessions = new Map<string, Budget>();
  private activeSetups = 0;
  private sweptAt = 0;

  constructor(private readonly config: ServerConfig) {}

  private budget(
    map: Map<string, Budget>,
    key: string,
    rate: number,
    burst: number,
    now: number,
    reason: string,
  ): Budget {
    if (now - this.sweptAt >= 60_000) {
      for (const buckets of [this.peers, this.users, this.sessions])
        for (const [id, bucket] of buckets)
          if (
            bucket.active === 0 &&
            now - bucket.updatedAt >= 120_000 &&
            bucket.tokens + (Math.max(0, now - bucket.updatedAt) * bucket.rate) / 60_000 >=
              bucket.burst
          )
            buckets.delete(id);
      this.sweptAt = now;
    }
    if (!map.has(key) && map.size >= 10_000)
      throw new LimitExceeded({ retryAfterSeconds: 60, reason: "media_identity_capacity" });
    const bucket = map.get(key) ?? { tokens: burst, updatedAt: now, active: 0, rate, burst };
    bucket.tokens = Math.min(
      burst,
      bucket.tokens + (Math.max(0, now - bucket.updatedAt) * rate) / 60_000,
    );
    bucket.updatedAt = now;
    map.set(key, bucket);
    if (bucket.tokens < 1)
      throw new LimitExceeded({
        retryAfterSeconds: Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / rate)),
        reason,
      });
    bucket.tokens -= 1;
    return bucket;
  }

  enterPeer(key: string, now: number): () => void {
    const peer = this.budget(
      this.peers,
      key,
      this.config.mediaPeerRequestsPerMinute,
      Math.max(this.config.mediaBurst, this.config.mediaPeerRequestsPerMinute / 4),
      now,
      "media_peer_rate",
    );
    if (this.activeSetups >= this.config.mediaMaxGlobalSetups)
      throw new LimitExceeded({ retryAfterSeconds: 1, reason: "media_global_setup_capacity" });
    if (peer.active >= this.config.mediaMaxConcurrentSetups)
      throw new LimitExceeded({ retryAfterSeconds: 1, reason: "media_peer_setup_capacity" });
    this.activeSetups += 1;
    peer.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSetups -= 1;
      peer.active -= 1;
    };
  }

  enterAuthenticated(userId: string, sessionId: string, now: number): () => void {
    const user = this.budget(
      this.users,
      userId,
      this.config.mediaRequestsPerMinute,
      this.config.mediaBurst,
      now,
      "media_user_rate",
    );
    const session = this.budget(
      this.sessions,
      sessionId,
      this.config.mediaRequestsPerMinute,
      this.config.mediaBurst,
      now,
      "media_session_rate",
    );
    if (
      user.active >= this.config.mediaMaxConcurrentSetups ||
      session.active >= this.config.mediaMaxConcurrentSetups
    )
      throw new LimitExceeded({
        retryAfterSeconds: 1,
        reason: "media_authenticated_setup_capacity",
      });
    user.active += 1;
    session.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      user.active -= 1;
      session.active -= 1;
    };
  }
}
