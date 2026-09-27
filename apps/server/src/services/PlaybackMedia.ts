import type { GroupMedia } from "@lumen/contracts";
import {
  catalogItems,
  catalogItemSources,
  Database,
  mediaSourceAvailability,
  tracks,
} from "@lumen/database";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { notFound } from "../core/Errors";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";

export const makePlaybackMedia = Effect.gen(function* () {
  const database = yield* Database;
  const access = yield* AccessControl;
  const resolve = Effect.fn("PlaybackMedia.resolve")(function* (
    principal: AuthPrincipal,
    requestedId: string,
    nowMs: number,
    exact?: GroupMedia,
  ) {
    const row = yield* database
      .select({
        itemId: catalogItemSources.itemId,
        trackId: tracks.id,
        sourceId: tracks.sourceId,
        sourceGeneration: catalogItemSources.sourceGeneration,
        durationMs: tracks.durationMs,
        title: tracks.title,
      })
      .from(tracks)
      .leftJoin(catalogItemSources, eq(catalogItemSources.sourceId, tracks.sourceId))
      .leftJoin(catalogItems, eq(catalogItems.id, catalogItemSources.itemId))
      .leftJoin(mediaSourceAvailability, eq(mediaSourceAvailability.sourceId, tracks.sourceId))
      .where(
        and(
          exact === undefined
            ? or(eq(tracks.id, requestedId), eq(catalogItemSources.itemId, requestedId))
            : and(
                eq(tracks.id, exact.trackId),
                eq(tracks.sourceId, exact.sourceId),
                eq(catalogItemSources.itemId, exact.itemId),
                eq(catalogItemSources.sourceGeneration, exact.sourceGeneration),
              ),
          or(
            isNull(mediaSourceAvailability.sourceId),
            eq(mediaSourceAvailability.isAvailable, true),
          ),
          or(
            isNull(catalogItems.id),
            eq(catalogItems.kind, "movie"),
            eq(catalogItems.kind, "episode"),
          ),
        ),
      )
      .orderBy(
        desc(catalogItemSources.isPrimary),
        asc(tracks.sourceId),
        asc(tracks.id),
        asc(catalogItemSources.itemId),
      )
      .limit(1)
      .get();
    if (row == null) return yield* notFound("Media source is unavailable or has been replaced");
    yield* access.requireTrack(principal, row.trackId, "playback:control", nowMs);
    return {
      ...row,
      itemId: row.itemId ?? row.trackId,
      sourceGeneration: row.sourceGeneration ?? 1,
    };
  });
  return { resolve };
});
export class PlaybackMedia extends Context.Service<
  PlaybackMedia,
  Effect.Success<typeof makePlaybackMedia>
>()("@lumen/server/PlaybackMedia") {}
export const PlaybackMediaLive = Layer.effect(PlaybackMedia, makePlaybackMedia);
