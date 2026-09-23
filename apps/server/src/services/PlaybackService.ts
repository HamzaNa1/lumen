import type { PlaybackGrant, PlaybackProgress, PlaybackSession } from "@lumen/contracts";
import { Database, Repositories, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { badRequest, conflict, forbidden, notFound } from "../core/Errors";
import { hashToken, newOpaqueToken, newUuid } from "../core/Security";
import { canonicalPath, isPathWithin } from "../core/Paths";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";
import type { HeartbeatBody, ProgressBody, StartPlaybackBody } from "../http/Schemas";
import { Schema } from "effect";

type PlaybackInput = Schema.Schema.Type<typeof StartPlaybackBody>;
type HeartbeatInput = Schema.Schema.Type<typeof HeartbeatBody>;
type ProgressInput = Schema.Schema.Type<typeof ProgressBody>;

export interface PlaybackStartResponse {
  readonly session: PlaybackSession;
  readonly grantToken: string;
  readonly itemId: string;
  readonly sourceId: string;
  readonly sourceGeneration: number;
  readonly title: string;
  readonly streamPath: string;
  readonly durationSeconds: number | null;
  readonly grantExpiresInSeconds: number;
}

export interface PlaybackServiceShape {
  readonly start: (principal: AuthPrincipal, input: PlaybackInput, nowMs: number) => Effect.Effect<PlaybackStartResponse, unknown>;
  readonly heartbeat: (principal: AuthPrincipal, sessionId: string, input: HeartbeatInput, nowMs: number) => Effect.Effect<PlaybackSession, unknown>;
  readonly stop: (principal: AuthPrincipal, sessionId: string, nowMs: number) => Effect.Effect<void, unknown>;
  readonly progress: (principal: AuthPrincipal, sessionId: string, input: ProgressInput, nowMs: number) => Effect.Effect<PlaybackProgress, unknown>;
  readonly authorizeGrant: (grantToken: string, trackId: string, nowMs: number) => Effect.Effect<{ absolutePath: string; size: number; modifiedAtMs: number; mimeType: string }, unknown>;
}

export const makePlaybackService = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const access = yield* AccessControl;
  const resolveTrack = Effect.fn("Playback.resolveTrack")(function* (requestedId: string) {
    const row = yield* database.get<{ id: string }>(sql`
      SELECT t.id
      FROM tracks t
      LEFT JOIN catalog_item_sources cs ON cs.source_id = t.source_id
      WHERE t.id = ${requestedId} OR cs.item_id = ${requestedId}
      LIMIT 1
    `);
    if (row == null) return yield* notFound("Media source not found");
    return row.id;
  });

  const start: PlaybackServiceShape["start"] = Effect.fn("Playback.start")(function* (principal, input, nowMs) {
    const device = yield* database.get<{ id: string; revokedAtMs: number | null }>(sql`
      SELECT id, revoked_at_ms AS revokedAtMs FROM devices WHERE id = ${input.deviceId} AND user_id = ${principal.user.id}
    `);
    if (device == null || device.revokedAtMs !== null) return yield* forbidden("Device is unavailable");
    if (input.trackId === null) return yield* badRequest("A source is required for direct play");
    const trackId = yield* resolveTrack(input.trackId);
    yield* access.requireTrack(principal, trackId, "playback:control", nowMs);
    const grantToken = newOpaqueToken();
    const sessionId = newUuid();
    const session = yield* repositories.activity.startPlayback({
      sessionId,
      userId: principal.user.id,
      deviceId: input.deviceId,
      grantTokenHash: hashToken(grantToken),
      activeTrackId: trackId,
      nowMs,
      expiresAtMs: nowMs + 3_600_000,
    }).pipe(Effect.mapError((cause) => conflict(cause instanceof Error ? cause.message : "Playback could not start")));
    {
      yield* repositories.activity.upsertGrant({
        id: newUuid(), sessionId: session.id, trackId, canSeek: true, canSkip: false, maxBitrateKbps: null, expiresAtMs: nowMs + 3_600_000,
      }).pipe(Effect.mapError((cause) => conflict(cause instanceof Error ? cause.message : "Grant could not be created")));
    }
    const source = yield* database.get<{ sourceId: string; title: string; durationMs: number | null }>(sql`
      SELECT t.source_id AS sourceId, t.title, t.duration_ms AS durationMs
      FROM tracks t WHERE t.id = ${trackId}
    `);
    if (source == null) return yield* notFound("Media source not found");
    return {
      session,
      grantToken,
      itemId: input.trackId,
      sourceId: source.sourceId,
      sourceGeneration: 1,
      title: source.title,
      streamPath: `/api/v1/media/${encodeURIComponent(trackId)}`,
      durationSeconds: source.durationMs === null ? null : Math.round(source.durationMs / 1000),
      grantExpiresInSeconds: 3_600,
    };
  });

  const heartbeat: PlaybackServiceShape["heartbeat"] = Effect.fn("Playback.heartbeat")(function* (principal, sessionId, input, nowMs) {
    const session = yield* database.get<PlaybackSession & { userId: string }>(sql`
      SELECT id, user_id AS userId, device_id AS deviceId, state, grant_token_hash AS grantTokenHash, active_track_id AS activeTrackId,
        started_at_ms AS startedAtMs, last_seen_at_ms AS lastSeenAtMs, expires_at_ms AS expiresAtMs, closed_at_ms AS closedAtMs, error_code AS errorCode
      FROM playback_sessions WHERE id = ${sessionId}
    `);
    if (session == null) return yield* notFound("Playback session not found");
    if (session.userId !== principal.user.id) return yield* forbidden("Playback session belongs to another user");
    if (session.closedAtMs !== null || session.expiresAtMs <= nowMs) return yield* conflict("Playback session is closed");
    const activeTrackId = input.activeTrackId === null ? null : yield* resolveTrack(input.activeTrackId);
    if (activeTrackId !== null) yield* access.requireTrack(principal, activeTrackId, "playback:control", nowMs);
    yield* database.run(sql`
      UPDATE playback_sessions SET state = ${input.state}, active_track_id = ${activeTrackId}, last_seen_at_ms = ${nowMs}, error_code = ${input.errorCode ?? null}
      WHERE id = ${sessionId} AND user_id = ${principal.user.id} AND closed_at_ms IS NULL AND expires_at_ms > ${nowMs}
    `);
    return { ...session, state: input.state, activeTrackId, lastSeenAtMs: nowMs, errorCode: input.errorCode ?? null };
  });

  const stop: PlaybackServiceShape["stop"] = Effect.fn("Playback.stop")(function* (principal, sessionId, nowMs) {
    const result = yield* database.run(sql`
      UPDATE playback_sessions
      SET state = 'ended', closed_at_ms = ${nowMs}, last_seen_at_ms = ${nowMs}
      WHERE id = ${sessionId} AND user_id = ${principal.user.id} AND closed_at_ms IS NULL
    `);
    void result;
  });

  const progress: PlaybackServiceShape["progress"] = Effect.fn("Playback.progress")(function* (principal, sessionId, input, nowMs) {
    if (input.durationMs !== null && input.positionMs > input.durationMs) return yield* badRequest("Position exceeds duration");
    const session = yield* database.get<{ userId: string; expiresAtMs: number; closedAtMs: number | null }>(sql`
      SELECT user_id AS userId, expires_at_ms AS expiresAtMs, closed_at_ms AS closedAtMs FROM playback_sessions WHERE id = ${sessionId}
    `);
    if (session == null) return yield* notFound("Playback session not found");
    if (session.userId !== principal.user.id) return yield* forbidden("Playback session belongs to another user");
    if (session.closedAtMs !== null || session.expiresAtMs <= nowMs) return yield* conflict("Playback session is closed");
    const trackId = yield* resolveTrack(input.trackId);
    yield* access.requireTrack(principal, trackId, "playback:control", nowMs);
    const progress = yield* database.transaction((transaction) => Effect.gen(function* () {
      const sequence = yield* transaction.get<{ sequence: number }>(sql`
        SELECT sequence FROM server_playback_sequences WHERE session_id = ${sessionId} AND track_id = ${trackId}
      `);
      if (sequence !== null && input.sequence <= sequence.sequence) {
        const existing = yield* transaction.get<PlaybackProgress>(sql`
          SELECT session_id AS sessionId, track_id AS trackId, position_ms AS positionMs, duration_ms AS durationMs, updated_at_ms AS updatedAtMs
          FROM playback_progress WHERE session_id = ${sessionId} AND track_id = ${trackId}
        `);
        return existing;
      }
      yield* transaction.run(sql`
        INSERT INTO server_playback_sequences(session_id, track_id, sequence) VALUES (${sessionId}, ${trackId}, ${input.sequence})
        ON CONFLICT(session_id, track_id) DO UPDATE SET sequence = excluded.sequence
      `);
      return yield* transaction.get<PlaybackProgress>(sql`
        INSERT INTO playback_progress(session_id, track_id, position_ms, duration_ms, updated_at_ms)
        VALUES (${sessionId}, ${trackId}, ${input.positionMs}, ${input.durationMs}, ${nowMs})
        ON CONFLICT(session_id, track_id) DO UPDATE SET position_ms = excluded.position_ms, duration_ms = excluded.duration_ms, updated_at_ms = excluded.updated_at_ms
        RETURNING session_id AS sessionId, track_id AS trackId, position_ms AS positionMs, duration_ms AS durationMs, updated_at_ms AS updatedAtMs
      `);
    }));
    const item = yield* database.get<{ id: string }>(sql`
      SELECT i.id FROM catalog_items i
      JOIN catalog_item_sources s ON s.item_id = i.id
      JOIN tracks t ON t.source_id = s.source_id
      WHERE t.id = ${trackId}
      LIMIT 1
    `);
    if (item != null) {
      yield* database.run(sql`
        INSERT INTO item_watch_states(user_id, item_id, position_seconds, completed, ownership_generation, updated_at_ms)
        VALUES (${principal.user.id}, ${item.id}, ${Math.round(input.positionMs / 1000)}, ${input.positionMs > 0 && input.durationMs !== null && input.positionMs / input.durationMs >= 0.9 ? 1 : 0}, 1, ${nowMs})
        ON CONFLICT(user_id, item_id) DO UPDATE SET position_seconds = excluded.position_seconds, completed = excluded.completed, updated_at_ms = excluded.updated_at_ms
      `);
    }
    return progress;
  });

  const authorizeGrant: PlaybackServiceShape["authorizeGrant"] = Effect.fn("Playback.authorizeGrant")(function* (grantToken, trackId, nowMs) {
    const row = yield* database.get<{ absolutePath: string; rootPath: string; size: number; modifiedAtMs: number; mimeType: string }>(sql`
      SELECT s.absolute_path AS absolutePath, r.path AS rootPath, s.file_size_bytes AS size, s.modified_at_ms AS modifiedAtMs,
        CASE
          WHEN lower(s.absolute_path) LIKE '%.mp4' OR lower(s.absolute_path) LIKE '%.m4v' OR lower(s.absolute_path) LIKE '%.webm' THEN 'video/mp4'
          WHEN lower(s.absolute_path) LIKE '%.flac' THEN 'audio/flac'
          WHEN lower(s.absolute_path) LIKE '%.ogg' OR lower(s.absolute_path) LIKE '%.oga' THEN 'audio/ogg'
          WHEN lower(s.absolute_path) LIKE '%.wav' THEN 'audio/wav'
          ELSE 'application/octet-stream'
        END AS mimeType
      FROM playback_grants g
      JOIN playback_sessions ps ON ps.id = g.session_id
      JOIN tracks t ON t.id = g.track_id
      JOIN media_sources s ON s.id = t.source_id
      JOIN library_roots r ON r.id = s.root_id
      LEFT JOIN media_source_availability a ON a.source_id = s.id
      WHERE COALESCE(a.is_available, 1) = 1
        AND ps.grant_token_hash = ${hashToken(grantToken)} AND g.track_id = ${trackId}
        AND ps.closed_at_ms IS NULL AND ps.expires_at_ms > ${nowMs} AND g.expires_at_ms > ${nowMs}
    `);
    if (row == null || row.size == null) return yield* notFound("Playback grant is invalid or expired");
    const [root, file] = yield* Effect.all([Effect.promise(() => canonicalPath(row.rootPath)), Effect.promise(() => canonicalPath(row.absolutePath))]);
    if (!isPathWithin(root, file)) return yield* notFound("Playback grant is invalid or expired");
    return { ...row, absolutePath: file };
  });

  return { start, heartbeat, stop, progress, authorizeGrant };
});

export class PlaybackService extends Context.Service<PlaybackService, PlaybackServiceShape>()("@lumen/server/Playback") {}
export const PlaybackServiceLive = Layer.effect(PlaybackService, makePlaybackService);
