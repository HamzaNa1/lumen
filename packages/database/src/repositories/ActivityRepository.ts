import {
  Favorite,
  PlaybackGrant,
  PlaybackProgress,
  PlaybackSession,
  SetFavorite,
  StartPlayback,
  UpdatePlaybackProgress,
  UpsertWatchState,
  Uuid,
  WatchState,
} from "@lumen/contracts";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
import {
  favorites,
  playbackGrants,
  playbackProgress,
  playbackSessions,
  watchStates,
} from "../tables/schema";
import { boundary, guard } from "./Boundary";

const watchSelection = {
  id: watchStates.id,
  userId: watchStates.userId,
  trackId: watchStates.trackId,
  positionMs: watchStates.positionMs,
  completed: watchStates.completed,
  updatedAtMs: watchStates.updatedAtMs,
};

const favoriteSelection = {
  userId: favorites.userId,
  trackId: favorites.trackId,
  createdAtMs: favorites.createdAtMs,
};

const sessionSelection = {
  id: playbackSessions.id,
  userId: playbackSessions.userId,
  deviceId: playbackSessions.deviceId,
  state: playbackSessions.state,
  grantTokenHash: playbackSessions.grantTokenHash,
  activeTrackId: playbackSessions.activeTrackId,
  startedAtMs: playbackSessions.startedAtMs,
  lastSeenAtMs: playbackSessions.lastSeenAtMs,
  expiresAtMs: playbackSessions.expiresAtMs,
  closedAtMs: playbackSessions.closedAtMs,
  errorCode: playbackSessions.errorCode,
};

const grantSelection = {
  id: playbackGrants.id,
  sessionId: playbackGrants.sessionId,
  trackId: playbackGrants.trackId,
  canSeek: playbackGrants.canSeek,
  canSkip: playbackGrants.canSkip,
  maxBitrateKbps: playbackGrants.maxBitrateKbps,
  expiresAtMs: playbackGrants.expiresAtMs,
};

const progressSelection = {
  sessionId: playbackProgress.sessionId,
  trackId: playbackProgress.trackId,
  positionMs: playbackProgress.positionMs,
  durationMs: playbackProgress.durationMs,
  updatedAtMs: playbackProgress.updatedAtMs,
};

const EntityId = Schema.Struct({ id: Uuid });
const SessionId = Schema.Struct({ sessionId: Uuid });
const UserTrack = Schema.Struct({ userId: Uuid, trackId: Uuid });

export const makeActivityRepository = (database: DatabaseClient) => {
  const upsertWatchState = Effect.fn("ActivityRepository.upsertWatchState")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(UpsertWatchState, input, "activity.upsertWatchState");
    const resultRows = yield* guard(
      database
        .insert(watchStates)
        .values({
          id: value.id,
          userId: value.userId,
          trackId: value.trackId,
          positionMs: value.positionMs,
          completed: value.completed,
          updatedAtMs: value.nowMs,
        })
        .onConflictDoUpdate({
          target: [watchStates.userId, watchStates.trackId],
          set: {
            positionMs: value.positionMs,
            completed: value.completed,
            updatedAtMs: value.nowMs,
          },
        })
        .returning(watchSelection),
      "activity.upsertWatchState",
    );
    const [row] = resultRows;
    return yield* boundary(WatchState, row, "activity.upsertWatchState.result");
  });

  const getWatchState = Effect.fn("ActivityRepository.getWatchState")(function* (input: unknown) {
    const value = yield* boundary(UserTrack, input, "activity.getWatchState");
    const row = yield* guard(
      database
        .select(watchSelection)
        .from(watchStates)
        .where(and(eq(watchStates.userId, value.userId), eq(watchStates.trackId, value.trackId)))
        .get(),
      "activity.getWatchState",
    );
    return yield* boundary(WatchState, row, "activity.getWatchState.result");
  });

  const setFavorite = Effect.fn("ActivityRepository.setFavorite")(function* (input: unknown) {
    const value = yield* boundary(SetFavorite, input, "activity.setFavorite");
    if (!value.isFavorite) {
      yield* guard(
        database
          .delete(favorites)
          .where(and(eq(favorites.userId, value.userId), eq(favorites.trackId, value.trackId))),
        "activity.setFavorite.delete",
      );
      return null;
    }
    const resultRows = yield* guard(
      database
        .insert(favorites)
        .values({
          userId: value.userId,
          trackId: value.trackId,
          createdAtMs: value.nowMs,
        })
        .onConflictDoUpdate({
          target: [favorites.userId, favorites.trackId],
          set: { userId: value.userId },
        })
        .returning(favoriteSelection),
      "activity.setFavorite.insert",
    );
    const [row] = resultRows;
    return yield* boundary(Favorite, row, "activity.setFavorite.result");
  });

  const isFavorite = Effect.fn("ActivityRepository.isFavorite")(function* (input: unknown) {
    const value = yield* boundary(UserTrack, input, "activity.isFavorite");
    const row = yield* guard(
      database
        .select({ userId: favorites.userId })
        .from(favorites)
        .where(and(eq(favorites.userId, value.userId), eq(favorites.trackId, value.trackId)))
        .get(),
      "activity.isFavorite",
    );
    return row !== undefined;
  });

  const startPlayback = Effect.fn("ActivityRepository.startPlayback")(function* (input: unknown) {
    const value = yield* boundary(StartPlayback, input, "activity.startPlayback");
    const resultRows = yield* guard(
      database
        .insert(playbackSessions)
        .values({
          id: value.sessionId,
          userId: value.userId,
          deviceId: value.deviceId,
          state: value.activeTrackId === null ? "idle" : "paused",
          grantTokenHash: value.grantTokenHash,
          activeTrackId: value.activeTrackId,
          startedAtMs: value.nowMs,
          lastSeenAtMs: value.nowMs,
          expiresAtMs: value.expiresAtMs,
        })
        .returning(sessionSelection),
      "activity.startPlayback",
    );
    const [row] = resultRows;
    return yield* boundary(PlaybackSession, row, "activity.startPlayback.result");
  });

  const getPlaybackSession = Effect.fn("ActivityRepository.getPlaybackSession")(function* (
    input: unknown,
  ) {
    const value = yield* boundary(EntityId, input, "activity.getPlaybackSession");
    const row = yield* guard(
      database
        .select(sessionSelection)
        .from(playbackSessions)
        .where(eq(playbackSessions.id, value.id))
        .get(),
      "activity.getPlaybackSession",
    );
    return yield* boundary(PlaybackSession, row, "activity.getPlaybackSession.result");
  });

  const upsertGrant = Effect.fn("ActivityRepository.upsertGrant")(function* (input: unknown) {
    const value = yield* boundary(PlaybackGrant, input, "activity.upsertGrant");
    const resultRows = yield* guard(
      database
        .insert(playbackGrants)
        .values({
          id: value.id,
          sessionId: value.sessionId,
          trackId: value.trackId,
          canSeek: value.canSeek,
          canSkip: value.canSkip,
          maxBitrateKbps: value.maxBitrateKbps,
          expiresAtMs: value.expiresAtMs,
        })
        .onConflictDoUpdate({
          target: [playbackGrants.sessionId, playbackGrants.trackId],
          set: {
            canSeek: value.canSeek,
            canSkip: value.canSkip,
            maxBitrateKbps: value.maxBitrateKbps,
            expiresAtMs: value.expiresAtMs,
          },
        })
        .returning(grantSelection),
      "activity.upsertGrant",
    );
    const [row] = resultRows;
    return yield* boundary(PlaybackGrant, row, "activity.upsertGrant.result");
  });

  const updateProgress = Effect.fn("ActivityRepository.updateProgress")(function* (input: unknown) {
    const value = yield* boundary(UpdatePlaybackProgress, input, "activity.updateProgress");
    const resultRows = yield* guard(
      database
        .insert(playbackProgress)
        .values({
          sessionId: value.sessionId,
          trackId: value.trackId,
          positionMs: value.positionMs,
          durationMs: value.durationMs,
          updatedAtMs: value.nowMs,
        })
        .onConflictDoUpdate({
          target: [playbackProgress.sessionId, playbackProgress.trackId],
          set: {
            positionMs: value.positionMs,
            durationMs: value.durationMs,
            updatedAtMs: value.nowMs,
          },
        })
        .returning(progressSelection),
      "activity.updateProgress",
    );
    const [row] = resultRows;
    return yield* boundary(PlaybackProgress, row, "activity.updateProgress.result");
  });

  const getProgress = Effect.fn("ActivityRepository.getProgress")(function* (input: unknown) {
    const value = yield* boundary(SessionId, input, "activity.getProgress");
    const rows = yield* guard(
      database
        .select(progressSelection)
        .from(playbackProgress)
        .where(eq(playbackProgress.sessionId, value.sessionId)),
      "activity.getProgress",
    );
    return yield* boundary(Schema.Array(PlaybackProgress), rows, "activity.getProgress.result");
  });

  return {
    upsertWatchState,
    getWatchState,
    setFavorite,
    isFavorite,
    startPlayback,
    getPlaybackSession,
    upsertGrant,
    updateProgress,
    getProgress,
  };
};

export type ActivityRepository = ReturnType<typeof makeActivityRepository>;
