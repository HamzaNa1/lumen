import {
  DEFAULT_TRACK_PREFERENCES,
  describeTrack,
  SavedTrack,
  SubtitleChoice,
  type TrackChoiceInput,
  type TrackMemory,
  type TrackPreferencesPatch,
} from "@lumen/contracts";
import {
  Database,
  catalogItems,
  catalogItemSources,
  tracks,
  streams,
  userTrackPreferences,
  mediaTrackOverrides,
  playbackSessions,
} from "@lumen/database";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { badRequest, conflict, forbidden, notFound } from "../core/Errors";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";

export const makeTrackMemoryStore = Effect.gen(function* () {
  const database = yield* Database;
  const access = yield* AccessControl;
  const preferences = Effect.fn("TrackMemory.preferences")(function* (principal: AuthPrincipal) {
    const row = yield* database
      .select()
      .from(userTrackPreferences)
      .where(eq(userTrackPreferences.userId, principal.user.id))
      .get();
    return row === undefined
      ? DEFAULT_TRACK_PREFERENCES
      : {
          audioLanguage: row.audioLanguage,
          subtitleLanguage: row.subtitleLanguage,
        };
  });
  const updatePreferences = Effect.fn("TrackMemory.updatePreferences")(function* (
    principal: AuthPrincipal,
    patch: TrackPreferencesPatch,
  ) {
    yield* database
      .insert(userTrackPreferences)
      .values({ userId: principal.user.id, ...patch })
      .onConflictDoUpdate({
        target: userTrackPreferences.userId,
        set: { ...patch, userId: principal.user.id },
      });
    return yield* preferences(principal);
  });
  const scopeForTrack = Effect.fn("TrackMemory.scope")(function* (trackId: string) {
    const item = yield* database
      .select({ item: catalogItems })
      .from(catalogItemSources)
      .innerJoin(catalogItems, eq(catalogItems.id, catalogItemSources.itemId))
      .innerJoin(tracks, eq(tracks.sourceId, catalogItemSources.sourceId))
      .where(eq(tracks.id, trackId))
      .get();
    if (item === undefined) return null;
    let scope = item.item;
    const parentKinds =
      scope.kind === "episode" ? ["season", "show"] : scope.kind === "season" ? ["show"] : [];
    for (const kind of parentKinds) {
      const parent =
        scope.parentId === null
          ? undefined
          : yield* database
              .select()
              .from(catalogItems)
              .where(
                and(
                  eq(catalogItems.id, scope.parentId),
                  eq(catalogItems.libraryId, scope.libraryId),
                  eq(catalogItems.kind, kind),
                ),
              )
              .get();
      if (parent === undefined) return yield* conflict(`Media has no parent ${kind}`);
      scope = parent;
    }
    return scope.id;
  });
  const memory = Effect.fn("TrackMemory.read")(function* (
    principal: AuthPrincipal,
    trackId: string,
  ) {
    const preferred = yield* preferences(principal);
    const scope = yield* scopeForTrack(trackId);
    const row =
      scope === null
        ? undefined
        : yield* database
            .select()
            .from(mediaTrackOverrides)
            .where(
              and(
                eq(mediaTrackOverrides.userId, principal.user.id),
                eq(mediaTrackOverrides.itemId, scope),
              ),
            )
            .get();
    return {
      preferences: preferred,
      audio:
        row?.audioJson == null
          ? null
          : Schema.decodeUnknownSync(SavedTrack)(JSON.parse(row.audioJson)),
      subtitle:
        row?.subtitleJson == null
          ? null
          : Schema.decodeUnknownSync(SubtitleChoice)(JSON.parse(row.subtitleJson)),
    } satisfies TrackMemory;
  });
  const saveChoice = Effect.fn("TrackMemory.saveChoice")(function* (
    principal: AuthPrincipal,
    sessionId: string,
    input: TrackChoiceInput,
    nowMs: number,
  ) {
    const session = yield* database
      .select()
      .from(playbackSessions)
      .where(eq(playbackSessions.id, sessionId))
      .get();
    if (session === undefined) return yield* notFound("Playback session not found");
    if (session.userId !== principal.user.id || session.deviceId !== principal.deviceId)
      return yield* forbidden("Playback session belongs to another account or device");
    if (
      session.closedAtMs !== null ||
      session.expiresAtMs <= nowMs ||
      session.activeTrackId === null
    )
      return yield* conflict("Playback session is closed");
    yield* access.requireTrack(principal, session.activeTrackId, "playback:control", nowMs);
    const scope = yield* scopeForTrack(session.activeTrackId);
    if (scope === null) return yield* conflict("Media has no catalog identity");
    const track = yield* database
      .select()
      .from(tracks)
      .where(eq(tracks.id, session.activeTrackId))
      .get();
    if (track === undefined) return yield* notFound("Media source not found");
    let choice: string | null = null;
    if (input.choice === "off") {
      if (input.kind !== "subtitle") return yield* badRequest("Only subtitles can be Off");
      choice = JSON.stringify("off");
    } else if (input.choice !== null) {
      const stream = yield* database
        .select()
        .from(streams)
        .where(
          and(
            eq(streams.id, input.choice),
            eq(streams.sourceId, track.sourceId),
            eq(streams.kind, input.kind),
          ),
        )
        .get();
      if (stream === undefined || stream.ordinal === null)
        return yield* badRequest("Stream does not belong to this media");
      choice = JSON.stringify(
        describeTrack(track.sourceId, {
          ...stream,
          kind: input.kind,
          ordinal: stream.ordinal,
        }),
      );
    }
    const field = input.kind === "audio" ? { audioJson: choice } : { subtitleJson: choice };
    yield* database
      .insert(mediaTrackOverrides)
      .values({ userId: principal.user.id, itemId: scope, ...field })
      .onConflictDoUpdate({
        target: [mediaTrackOverrides.userId, mediaTrackOverrides.itemId],
        set: field,
      });
    return yield* memory(principal, session.activeTrackId);
  });
  return { preferences, updatePreferences, memory, saveChoice };
});
