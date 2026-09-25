import type { IpcPlayableStream, PlaybackProgress, PlaybackSession } from "@lumen/contracts";
import {
  catalogItems,
  catalogItemSources,
  Database,
  devices,
  itemWatchStates,
  libraryRoots,
  mediaSourceAvailability,
  mediaSources,
  playbackGrants,
  playbackProgress,
  playbackSessions,
  Repositories,
  serverPlaybackSequences,
  streams as streamTable,
  tracks,
} from "@lumen/database";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { badRequest, conflict, forbidden, notFound } from "../core/Errors";
import { hashToken, newOpaqueToken, newUuid } from "../core/Security";
import { canonicalPath, isPathWithin } from "../core/Paths";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";
import type { HeartbeatBody, ProgressBody, StartPlaybackBody } from "../http/Schemas";
import type { Schema } from "effect";

type PlaybackInput = Schema.Schema.Type<typeof StartPlaybackBody>;
type HeartbeatInput = Schema.Schema.Type<typeof HeartbeatBody>;
type ProgressInput = Schema.Schema.Type<typeof ProgressBody>;

export type PlaybackStream = IpcPlayableStream;

export interface PlaybackStartResponse {
  readonly session: PlaybackSession;
  readonly grantToken: string;
  readonly itemId: string;
  readonly sourceId: string;
  readonly sourceGeneration: number;
  readonly title: string;
  readonly streamPath: string;
  readonly durationSeconds: number | null;
  readonly streams: ReadonlyArray<PlaybackStream>;
  readonly grantExpiresInSeconds: number;
}

export interface PlaybackServiceShape {
  readonly start: (
    principal: AuthPrincipal,
    input: PlaybackInput,
    nowMs: number,
  ) => Effect.Effect<PlaybackStartResponse, unknown>;
  readonly heartbeat: (
    principal: AuthPrincipal,
    sessionId: string,
    input: HeartbeatInput,
    nowMs: number,
  ) => Effect.Effect<PlaybackSession, unknown>;
  readonly stop: (
    principal: AuthPrincipal,
    sessionId: string,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly progress: (
    principal: AuthPrincipal,
    sessionId: string,
    input: ProgressInput,
    nowMs: number,
  ) => Effect.Effect<PlaybackProgress, unknown>;
  readonly authorizeGrant: (
    grantToken: string,
    trackId: string,
    nowMs: number,
  ) => Effect.Effect<
    { absolutePath: string; size: number; modifiedAtMs: number; mimeType: string },
    unknown
  >;
}

export const makePlaybackService = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const access = yield* AccessControl;
  const resolveTrack = Effect.fn("Playback.resolveTrack")(function* (requestedId: string) {
    const row = yield* database
      .select({ id: tracks.id })
      .from(tracks)
      .leftJoin(catalogItemSources, eq(catalogItemSources.sourceId, tracks.sourceId))
      .where(or(eq(tracks.id, requestedId), eq(catalogItemSources.itemId, requestedId)))
      .limit(1)
      .get();
    if (row == null) return yield* notFound("Media source not found");
    return row.id;
  });

  const start: PlaybackServiceShape["start"] = Effect.fn("Playback.start")(
    function* (principal, input, nowMs) {
      const device = yield* database
        .select({ id: devices.id, revokedAtMs: devices.revokedAtMs })
        .from(devices)
        .where(and(eq(devices.id, principal.deviceId), eq(devices.userId, principal.user.id)))
        .get();
      if (device == null || device.revokedAtMs !== null)
        return yield* forbidden("Device is unavailable");
      if (input.trackId === null) return yield* badRequest("A source is required for direct play");
      const trackId = yield* resolveTrack(input.trackId);
      yield* access.requireTrack(principal, trackId, "playback:control", nowMs);
      const grantToken = newOpaqueToken();
      const sessionId = newUuid();
      const session = yield* repositories.activity
        .startPlayback({
          sessionId,
          userId: principal.user.id,
          deviceId: principal.deviceId,
          grantTokenHash: hashToken(grantToken),
          activeTrackId: trackId,
          nowMs,
          expiresAtMs: nowMs + 3_600_000,
        })
        .pipe(
          Effect.mapError((cause) =>
            conflict(cause instanceof Error ? cause.message : "Playback could not start"),
          ),
        );
      yield* repositories.activity
        .upsertGrant({
          id: newUuid(),
          sessionId: session.id,
          trackId,
          canSeek: true,
          canSkip: false,
          maxBitrateKbps: null,
          expiresAtMs: nowMs + 3_600_000,
        })
        .pipe(
          Effect.mapError((cause) =>
            conflict(cause instanceof Error ? cause.message : "Grant could not be created"),
          ),
        );
      const source = yield* database
        .select({
          sourceId: tracks.sourceId,
          title: tracks.title,
          durationMs: tracks.durationMs,
        })
        .from(tracks)
        .where(eq(tracks.id, trackId))
        .get();
      if (source == null) return yield* notFound("Media source not found");
      const streams = (yield* database
        .select({
          id: streamTable.id,
          kind: streamTable.kind,
          ordinal: streamTable.ordinal,
          codec: streamTable.codec,
          language: streamTable.language,
          title: streamTable.title,
          isDefault: streamTable.isDefault,
        })
        .from(streamTable)
        .where(
          and(
            eq(streamTable.sourceId, source.sourceId),
            inArray(streamTable.kind, ["audio", "subtitle"]),
            sql`${streamTable.ordinal} is not null`,
          ),
        )
        .orderBy(asc(streamTable.ordinal))) as ReadonlyArray<PlaybackStream>;
      return {
        session,
        grantToken,
        itemId: input.trackId,
        sourceId: source.sourceId,
        sourceGeneration: 1,
        title: source.title,
        streamPath: `/api/v1/media/${encodeURIComponent(trackId)}`,
        durationSeconds: source.durationMs === null ? null : Math.round(source.durationMs / 1000),
        streams,
        grantExpiresInSeconds: 3_600,
      };
    },
  );

  const heartbeat: PlaybackServiceShape["heartbeat"] = Effect.fn("Playback.heartbeat")(
    function* (principal, sessionId, input, nowMs) {
      const session = (yield* database
        .select()
        .from(playbackSessions)
        .where(eq(playbackSessions.id, sessionId))
        .get()) as (PlaybackSession & { userId: string }) | undefined;
      if (session == null) return yield* notFound("Playback session not found");
      if (session.userId !== principal.user.id)
        return yield* forbidden("Playback session belongs to another user");
      if (session.closedAtMs !== null || session.expiresAtMs <= nowMs)
        return yield* conflict("Playback session is closed");
      const activeTrackId =
        input.activeTrackId === null ? null : yield* resolveTrack(input.activeTrackId);
      if (activeTrackId !== null)
        yield* access.requireTrack(principal, activeTrackId, "playback:control", nowMs);
      yield* database
        .update(playbackSessions)
        .set({
          state: input.state,
          activeTrackId,
          lastSeenAtMs: nowMs,
          errorCode: input.errorCode ?? null,
        })
        .where(
          and(
            eq(playbackSessions.id, sessionId),
            eq(playbackSessions.userId, principal.user.id),
            isNull(playbackSessions.closedAtMs),
            gt(playbackSessions.expiresAtMs, nowMs),
          ),
        );
      return {
        ...session,
        state: input.state,
        activeTrackId,
        lastSeenAtMs: nowMs,
        errorCode: input.errorCode ?? null,
      };
    },
  );

  const stop: PlaybackServiceShape["stop"] = Effect.fn("Playback.stop")(
    function* (principal, sessionId, nowMs) {
      yield* database
        .update(playbackSessions)
        .set({
          state: "ended",
          closedAtMs: nowMs,
          lastSeenAtMs: nowMs,
        })
        .where(
          and(
            eq(playbackSessions.id, sessionId),
            eq(playbackSessions.userId, principal.user.id),
            isNull(playbackSessions.closedAtMs),
          ),
        );
    },
  );

  const progress: PlaybackServiceShape["progress"] = Effect.fn("Playback.progress")(
    function* (principal, sessionId, input, nowMs) {
      if (input.durationMs !== null && input.positionMs > input.durationMs)
        return yield* badRequest("Position exceeds duration");
      const session = yield* database
        .select({
          userId: playbackSessions.userId,
          expiresAtMs: playbackSessions.expiresAtMs,
          closedAtMs: playbackSessions.closedAtMs,
        })
        .from(playbackSessions)
        .where(eq(playbackSessions.id, sessionId))
        .get();
      if (session == null) return yield* notFound("Playback session not found");
      if (session.userId !== principal.user.id)
        return yield* forbidden("Playback session belongs to another user");
      if (session.closedAtMs !== null || session.expiresAtMs <= nowMs)
        return yield* conflict("Playback session is closed");
      const trackId = yield* resolveTrack(input.trackId);
      yield* access.requireTrack(principal, trackId, "playback:control", nowMs);
      const progress = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          const sequence = yield* transaction
            .select({ sequence: serverPlaybackSequences.sequence })
            .from(serverPlaybackSequences)
            .where(
              and(
                eq(serverPlaybackSequences.sessionId, sessionId),
                eq(serverPlaybackSequences.trackId, trackId),
              ),
            )
            .get();
          if (sequence != null && input.sequence <= sequence.sequence) {
            const existing = yield* transaction
              .select()
              .from(playbackProgress)
              .where(
                and(
                  eq(playbackProgress.sessionId, sessionId),
                  eq(playbackProgress.trackId, trackId),
                ),
              )
              .get();
            if (existing != null) return existing;
          }
          yield* transaction
            .insert(serverPlaybackSequences)
            .values({
              sessionId,
              trackId,
              sequence: input.sequence,
            })
            .onConflictDoUpdate({
              target: [serverPlaybackSequences.sessionId, serverPlaybackSequences.trackId],
              set: { sequence: input.sequence },
            });
          const [updated] = yield* transaction
            .insert(playbackProgress)
            .values({
              sessionId,
              trackId,
              positionMs: input.positionMs,
              durationMs: input.durationMs,
              updatedAtMs: nowMs,
            })
            .onConflictDoUpdate({
              target: [playbackProgress.sessionId, playbackProgress.trackId],
              set: {
                positionMs: input.positionMs,
                durationMs: input.durationMs,
                updatedAtMs: nowMs,
              },
            })
            .returning();
          return updated;
        }),
      );
      const item = yield* database
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .innerJoin(catalogItemSources, eq(catalogItemSources.itemId, catalogItems.id))
        .innerJoin(tracks, eq(tracks.sourceId, catalogItemSources.sourceId))
        .where(eq(tracks.id, trackId))
        .limit(1)
        .get();
      if (item != null) {
        const positionSeconds = Math.round(input.positionMs / 1000);
        const completed =
          input.positionMs > 0 &&
          input.durationMs !== null &&
          input.positionMs / input.durationMs >= 0.9;
        yield* database
          .insert(itemWatchStates)
          .values({
            userId: principal.user.id,
            itemId: item.id,
            positionSeconds,
            completed,
            ownershipGeneration: 1,
            updatedAtMs: nowMs,
          })
          .onConflictDoUpdate({
            target: [itemWatchStates.userId, itemWatchStates.itemId],
            set: { positionSeconds, completed, updatedAtMs: nowMs },
          });
      }
      return progress;
    },
  );

  const authorizeGrant: PlaybackServiceShape["authorizeGrant"] = Effect.fn(
    "Playback.authorizeGrant",
  )(function* (grantToken, trackId, nowMs) {
    const row = yield* database
      .select({
        absolutePath: mediaSources.absolutePath,
        rootPath: libraryRoots.path,
        size: mediaSources.fileSizeBytes,
        modifiedAtMs: sql<number>`coalesce(${mediaSources.modifiedAtMs}, 0)`,
        mimeType: sql<string>`case
        when lower(${mediaSources.absolutePath}) like '%.mkv' then 'video/x-matroska'
        when lower(${mediaSources.absolutePath}) like '%.mp4' or lower(${mediaSources.absolutePath}) like '%.m4v' or lower(${mediaSources.absolutePath}) like '%.webm' then 'video/mp4'
        when lower(${mediaSources.absolutePath}) like '%.flac' then 'audio/flac'
        when lower(${mediaSources.absolutePath}) like '%.ogg' or lower(${mediaSources.absolutePath}) like '%.oga' then 'audio/ogg'
        when lower(${mediaSources.absolutePath}) like '%.wav' then 'audio/wav'
        else 'application/octet-stream' end`,
      })
      .from(playbackGrants)
      .innerJoin(playbackSessions, eq(playbackSessions.id, playbackGrants.sessionId))
      .innerJoin(tracks, eq(tracks.id, playbackGrants.trackId))
      .innerJoin(mediaSources, eq(mediaSources.id, tracks.sourceId))
      .innerJoin(libraryRoots, eq(libraryRoots.id, mediaSources.rootId))
      .leftJoin(mediaSourceAvailability, eq(mediaSourceAvailability.sourceId, mediaSources.id))
      .where(
        and(
          sql`coalesce(${mediaSourceAvailability.isAvailable}, 1) = 1`,
          eq(playbackSessions.grantTokenHash, hashToken(grantToken)),
          eq(playbackGrants.trackId, trackId),
          isNull(playbackSessions.closedAtMs),
          gt(playbackSessions.expiresAtMs, nowMs),
          gt(playbackGrants.expiresAtMs, nowMs),
        ),
      )
      .get();
    if (row == null || row.size == null)
      return yield* notFound("Playback grant is invalid or expired");
    const [root, file] = yield* Effect.all([
      Effect.promise(() => canonicalPath(row.rootPath)),
      Effect.promise(() => canonicalPath(row.absolutePath)),
    ]);
    if (!isPathWithin(root, file)) return yield* notFound("Playback grant is invalid or expired");
    return { ...row, size: row.size, absolutePath: file };
  });

  return { start, heartbeat, stop, progress, authorizeGrant };
});

export class PlaybackService extends Context.Service<PlaybackService, PlaybackServiceShape>()(
  "@lumen/server/Playback",
) {}
export const PlaybackServiceLive = Layer.effect(PlaybackService, makePlaybackService);
