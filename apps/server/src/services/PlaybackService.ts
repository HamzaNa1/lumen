import { mediaMimeType } from "../features/playback/MediaType";
import { probeFile, type FfprobeResult } from "../media/Ffprobe";
import { decodeConfig, type ServerConfig } from "../config/Config";
import type { ManagedSource } from "../features/playback/ManagedProfile";
import type { PlayableStream, PlaybackProgress, PlaybackSession } from "@lumen/contracts";
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
  serverPlaybackWatchVersions,
  streams as streamTable,
  tracks,
  users,
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

const playbackLifetimeMs = 3_600_000;

export type PlaybackStream = PlayableStream;

export interface PlaybackStartResponse {
  readonly session: PlaybackSession;
  readonly grantToken: string;
  readonly itemId: string;
  readonly sourceId: string;
  readonly sourceGeneration: number;
  readonly title: string;
  readonly streamPath: string;
  readonly directMimeType: string;
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
  readonly managedSource: (
    principal: AuthPrincipal,
    sessionId: string,
    nowMs: number,
  ) => Effect.Effect<ManagedSource, unknown>;
  readonly managedGrant: (
    grantToken: string,
    trackId: string,
    nowMs: number,
  ) => Effect.Effect<ManagedSource & { readonly userId: string }, unknown>;
  readonly authorizeGrant: (
    grantToken: string,
    trackId: string,
    nowMs: number,
  ) => Effect.Effect<
    {
      absolutePath: string;
      size: number;
      modifiedAtMs: number;
      mimeType: string;
      sessionId: string;
      userId: string;
    },
    unknown
  >;
}

export const makePlaybackServiceWithConfig = (config: ServerConfig) =>
  Effect.gen(function* () {
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
        if (input.trackId === null)
          return yield* badRequest("A source is required for direct play");
        const trackId = yield* resolveTrack(input.trackId);
        yield* access.requireTrack(principal, trackId, "playback:control", nowMs);
        const watchVersion = yield* database
          .select({
            itemId: catalogItems.id,
            manualVersion: sql<number>`coalesce(${itemWatchStates.manualVersion}, 0)`,
          })
          .from(catalogItems)
          .innerJoin(catalogItemSources, eq(catalogItemSources.itemId, catalogItems.id))
          .innerJoin(tracks, eq(tracks.sourceId, catalogItemSources.sourceId))
          .leftJoin(
            itemWatchStates,
            and(
              eq(itemWatchStates.itemId, catalogItems.id),
              eq(itemWatchStates.userId, principal.user.id),
            ),
          )
          .where(eq(tracks.id, trackId))
          .limit(1)
          .get();
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
            expiresAtMs: nowMs + playbackLifetimeMs,
          })
          .pipe(
            Effect.mapError((cause) =>
              conflict(cause instanceof Error ? cause.message : "Playback could not start"),
            ),
          );
        if (watchVersion != null) {
          yield* database.insert(serverPlaybackWatchVersions).values({
            sessionId,
            trackId,
            ...watchVersion,
          });
        }
        yield* repositories.activity
          .upsertGrant({
            id: newUuid(),
            sessionId: session.id,
            trackId,
            canSeek: true,
            canSkip: false,
            maxBitrateKbps: null,
            expiresAtMs: nowMs + playbackLifetimeMs,
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
            absolutePath: mediaSources.absolutePath,
          })
          .from(tracks)
          .innerJoin(mediaSources, eq(mediaSources.id, tracks.sourceId))
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
          directMimeType: mediaMimeType(source.absolutePath),
          durationSeconds: source.durationMs === null ? null : Math.round(source.durationMs / 1000),
          streams,
          grantExpiresInSeconds: playbackLifetimeMs / 1000,
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
        const grants = yield* database
          .select({ id: playbackGrants.id, trackId: playbackGrants.trackId })
          .from(playbackGrants)
          .where(
            and(eq(playbackGrants.sessionId, sessionId), gt(playbackGrants.expiresAtMs, nowMs)),
          );
        const trackIds = new Set(grants.map((grant) => grant.trackId));
        if (activeTrackId !== null) trackIds.add(activeTrackId);
        for (const trackId of trackIds)
          yield* access.requireTrack(principal, trackId, "playback:control", nowMs);
        return yield* database.transaction((transaction) =>
          Effect.gen(function* () {
            const [updated] = yield* transaction
              .update(playbackSessions)
              .set({
                state: input.state,
                activeTrackId,
                lastSeenAtMs: nowMs,
                expiresAtMs: sql`max(${playbackSessions.expiresAtMs}, ${nowMs + playbackLifetimeMs})`,
                errorCode: input.errorCode ?? null,
              })
              .where(
                and(
                  eq(playbackSessions.id, sessionId),
                  eq(playbackSessions.userId, principal.user.id),
                  isNull(playbackSessions.closedAtMs),
                  gt(playbackSessions.expiresAtMs, nowMs),
                ),
              )
              .returning();
            if (updated == null) return yield* conflict("Playback session is closed");
            yield* transaction
              .update(playbackGrants)
              .set({ expiresAtMs: updated.expiresAtMs })
              .where(
                and(
                  eq(playbackGrants.sessionId, sessionId),
                  inArray(
                    playbackGrants.id,
                    grants.map((grant) => grant.id),
                  ),
                  gt(playbackGrants.expiresAtMs, nowMs),
                ),
              );
            return { ...updated, state: input.state };
          }),
        );
      },
    );

    const stop: PlaybackServiceShape["stop"] = Effect.fn("Playback.stop")(
      function* (principal, sessionId, nowMs) {
        const owned = yield* database
          .select({ userId: playbackSessions.userId })
          .from(playbackSessions)
          .where(eq(playbackSessions.id, sessionId))
          .get();
        if (owned == null) return yield* notFound("Playback session not found");
        if (owned.userId !== principal.user.id)
          return yield* forbidden("Playback session belongs to another user");
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
        const result = yield* database.transaction((transaction) =>
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
            const watchVersion = yield* transaction
              .select()
              .from(serverPlaybackWatchVersions)
              .where(
                and(
                  eq(serverPlaybackWatchVersions.sessionId, sessionId),
                  eq(serverPlaybackWatchVersions.trackId, trackId),
                ),
              )
              .get();
            if (watchVersion != null) {
              const positionSeconds = Math.round(input.positionMs / 1000);
              const completed =
                input.positionMs > 0 &&
                input.durationMs !== null &&
                input.positionMs / input.durationMs >= 0.9;
              yield* transaction
                .insert(itemWatchStates)
                .values({
                  userId: principal.user.id,
                  itemId: watchVersion.itemId,
                  positionSeconds,
                  completed,
                  ownershipGeneration: 1,
                  manualVersion: watchVersion.manualVersion,
                  updatedAtMs: nowMs,
                })
                .onConflictDoUpdate({
                  target: [itemWatchStates.userId, itemWatchStates.itemId],
                  set: { positionSeconds, completed, updatedAtMs: nowMs },
                  setWhere: eq(itemWatchStates.manualVersion, watchVersion.manualVersion),
                });
            }
            return updated;
          }),
        );
        return result;
      },
    );

    const authorizeGrant: PlaybackServiceShape["authorizeGrant"] = Effect.fn(
      "Playback.authorizeGrant",
    )(function* (grantToken, trackId, nowMs) {
      const row = yield* database
        .select({
          sessionId: playbackSessions.id,
          userId: playbackSessions.userId,
          absolutePath: mediaSources.absolutePath,
          rootPath: libraryRoots.path,
          size: mediaSources.fileSizeBytes,
          modifiedAtMs: sql<number>`coalesce(${mediaSources.modifiedAtMs}, 0)`,
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
        Effect.tryPromise({
          try: () => canonicalPath(row.rootPath),
          catch: () => notFound("Media source is unavailable"),
        }),
        Effect.tryPromise({
          try: () => canonicalPath(row.absolutePath),
          catch: () => notFound("Media source is unavailable"),
        }),
      ]);
      if (!isPathWithin(root, file)) return yield* notFound("Playback grant is invalid or expired");
      return { ...row, size: row.size, absolutePath: file, mimeType: mediaMimeType(file) };
    });

    const metadataProbes = new Map<string, Promise<FfprobeResult>>();
    const metadataAbort = new AbortController();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        metadataAbort.abort();
        await Promise.allSettled(metadataProbes.values());
      }),
    );
    const repairProbe = (path: string): Promise<FfprobeResult> => {
      metadataAbort.signal.throwIfAborted();
      const existing = metadataProbes.get(path);
      if (existing !== undefined) return existing;
      if (metadataProbes.size > 0)
        return Promise.reject(badRequest("Stream metadata verification is busy; try again"));
      const probe = probeFile(
        config.ffprobePath,
        path,
        config.ffprobeTimeoutMs,
        config.ffprobeMaxOutputBytes,
        metadataAbort.signal,
      ).finally(() => metadataProbes.delete(path));
      metadataProbes.set(path, probe);
      return probe;
    };

    const resolveManagedSource = Effect.fn("Playback.resolveManagedSource")(function* (
      sessionId: string,
      trackId: string,
    ) {
      const row = yield* database
        .select({
          sourceId: tracks.sourceId,
          absolutePath: mediaSources.absolutePath,
          rootPath: libraryRoots.path,
          videoId: tracks.primaryStreamId,
        })
        .from(tracks)
        .innerJoin(mediaSources, eq(mediaSources.id, tracks.sourceId))
        .innerJoin(libraryRoots, eq(libraryRoots.id, mediaSources.rootId))
        .leftJoin(mediaSourceAvailability, eq(mediaSourceAvailability.sourceId, mediaSources.id))
        .where(
          and(eq(tracks.id, trackId), sql`coalesce(${mediaSourceAvailability.isAvailable}, 1) = 1`),
        )
        .get();
      if (row == null) return yield* notFound("Media source is unavailable");
      const [root, file] = yield* Effect.all([
        Effect.tryPromise({
          try: () => canonicalPath(row.rootPath),
          catch: () => notFound("Media source is unavailable"),
        }),
        Effect.tryPromise({
          try: () => canonicalPath(row.absolutePath),
          catch: () => notFound("Media source is unavailable"),
        }),
      ]);
      if (!isPathWithin(root, file)) return yield* notFound("Media source is unavailable");
      const available = yield* database
        .select({
          id: streamTable.id,
          kind: streamTable.kind,
          ordinal: streamTable.ordinal,
          isDefault: streamTable.isDefault,
          codec: streamTable.codec,
          language: streamTable.language,
        })
        .from(streamTable)
        .where(eq(streamTable.sourceId, row.sourceId))
        .orderBy(asc(streamTable.ordinal));
      let video = available.find((stream) => stream.id === row.videoId && stream.kind === "video");
      const audioStreams = available.filter((stream) => stream.kind === "audio");
      let audio = audioStreams.find((stream) => stream.isDefault) ?? audioStreams[0];
      if (video === undefined) return yield* badRequest("The selected video stream is unavailable");
      if (video.ordinal === null || (audio !== undefined && audio.ordinal === null)) {
        const probe = yield* Effect.tryPromise({
          try: () => repairProbe(file),
          catch: () => badRequest("The source stream metadata could not be verified"),
        });
        const videos = probe.streams.filter((stream) => stream.kind === "video");
        const audios = probe.streams.filter((stream) => stream.kind === "audio");
        const intended = audios.find((stream) => stream.isDefault) ?? audios[0];
        if (
          videos.length !== 1 ||
          audios.length !== audioStreams.length ||
          (audio !== undefined &&
            (audio.codec !== intended?.codec ||
              (audio.ordinal !== null && audio.ordinal !== intended?.ordinal) ||
              (audio.ordinal === null &&
                audio.language !== null &&
                audio.language !== intended?.language)))
        )
          return yield* badRequest(
            "The intended streams could not be verified; rescan this source",
          );
        const ordinal = videos[0]?.ordinal;
        if (ordinal === undefined)
          return yield* badRequest("The selected video stream is unavailable");
        yield* database.update(streamTable).set({ ordinal }).where(eq(streamTable.id, video.id));
        video = { ...video, ordinal };
        if (audio !== undefined && audio.ordinal === null && intended !== undefined) {
          yield* database
            .update(streamTable)
            .set({ ordinal: intended.ordinal })
            .where(eq(streamTable.id, audio.id));
          audio = { ...audio, ordinal: intended.ordinal };
        }
      }
      if (video.ordinal === null)
        return yield* badRequest("The selected video ordinal could not be verified");
      let selectedAudio: ManagedSource["audio"] = null;
      if (audio !== undefined) {
        if (audio.ordinal === null)
          return yield* badRequest("The intended audio ordinal could not be verified");
        selectedAudio = { id: audio.id, ordinal: audio.ordinal };
      }
      return {
        sessionId,
        trackId,
        sourceId: row.sourceId,
        absolutePath: file,
        rootPath: root,
        video: { id: video.id, ordinal: video.ordinal },
        audio: selectedAudio,
      } satisfies ManagedSource;
    });

    const managedSource: PlaybackServiceShape["managedSource"] = Effect.fn(
      "Playback.managedSource",
    )(function* (principal, sessionId, nowMs) {
      const session = yield* database
        .select()
        .from(playbackSessions)
        .where(eq(playbackSessions.id, sessionId))
        .get();
      if (session == null) return yield* notFound("Playback session not found");
      if (session.userId !== principal.user.id)
        return yield* forbidden("Playback session belongs to another user");
      if (
        session.closedAtMs !== null ||
        session.expiresAtMs <= nowMs ||
        session.activeTrackId === null
      )
        return yield* conflict("Playback session is closed");
      yield* access.requireTrack(principal, session.activeTrackId, "playback:control", nowMs);
      const grant = yield* database
        .select({ id: playbackGrants.id })
        .from(playbackGrants)
        .where(
          and(
            eq(playbackGrants.sessionId, sessionId),
            eq(playbackGrants.trackId, session.activeTrackId),
            gt(playbackGrants.expiresAtMs, nowMs),
          ),
        )
        .get();
      if (grant == null) return yield* notFound("Playback grant is invalid or expired");
      return yield* resolveManagedSource(sessionId, session.activeTrackId);
    });

    const managedGrant: PlaybackServiceShape["managedGrant"] = Effect.fn("Playback.managedGrant")(
      function* (grantToken, trackId, nowMs) {
        // Direct and managed media share grant expiry, source availability, and canonical path checks.
        const media = yield* authorizeGrant(grantToken, trackId, nowMs);
        const session = yield* database
          .select({ id: playbackSessions.id, user: users, deviceId: playbackSessions.deviceId })
          .from(playbackSessions)
          .innerJoin(users, eq(users.id, playbackSessions.userId))
          .innerJoin(
            devices,
            and(eq(devices.id, playbackSessions.deviceId), isNull(devices.revokedAtMs)),
          )
          .where(
            and(
              eq(users.isActive, true),
              eq(playbackSessions.grantTokenHash, hashToken(grantToken)),
              eq(playbackSessions.activeTrackId, trackId),
              isNull(playbackSessions.closedAtMs),
              gt(playbackSessions.expiresAtMs, nowMs),
            ),
          )
          .get();
        if (session == null) return yield* notFound("Playback grant is invalid or expired");
        yield* access.requireTrack(
          {
            user: { ...session.user, role: session.user.role as AuthPrincipal["user"]["role"] },
            deviceId: session.deviceId,
            sessionId: session.id,
          },
          trackId,
          "playback:control",
          nowMs,
        );
        return { ...(yield* resolveManagedSource(session.id, trackId)), userId: media.userId };
      },
    );

    return { start, heartbeat, stop, progress, authorizeGrant, managedSource, managedGrant };
  });

export class PlaybackService extends Context.Service<PlaybackService, PlaybackServiceShape>()(
  "@lumen/server/Playback",
) {}
export const makePlaybackService = makePlaybackServiceWithConfig(decodeConfig({}));
export const PlaybackServiceLive = Layer.effect(PlaybackService, makePlaybackService);
export const PlaybackServiceLiveWithConfig = (config: ServerConfig) =>
  Layer.effect(PlaybackService, makePlaybackServiceWithConfig(config));
