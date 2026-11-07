import type { LumenRuntime } from "@lumen/client/runtime";
import {
  type AdjacentEpisodes,
  type CatalogItem,
  type PlayingDescription,
  posterOf,
  type ShowSummary,
} from "@lumen/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { episodeContext, playingContext } from "./format";
import { namedShow, showOfEpisode } from "./ShowEpisodes";
import { itemDetailsQuery } from "./Workspace";

export interface Playing {
  /** Null until every part of it is known, so the player never shows part of it. */
  readonly description: PlayingDescription | null;
  /** Null until the description is known, and for anything that is not an episode of a show. */
  readonly show: ShowSummary | null;
  readonly adjacentEpisodes: AdjacentEpisodes | undefined;
}

/**
 * What the player says about what is playing. Anything but an episode is described by the item
 * it was started from; an episode waits for its details and its neighbours, which are looked up
 * together while playback starts.
 */
export const usePlayingDescription = ({
  runtime,
  scope,
  playingId,
  playingItem,
  watchTitle,
}: {
  readonly runtime: LumenRuntime;
  /** Null without an account, when nothing can be looked up. */
  readonly scope: readonly unknown[] | null;
  readonly playingId: string | null;
  /** The item playback was started from here; null for playback a watch group started. */
  readonly playingItem: CatalogItem | null;
  readonly watchTitle: string | undefined;
}): Playing => {
  const describedByItem = playingItem !== null && playingItem.kind !== "episode";
  const lookupId = scope === null || describedByItem ? null : playingId;
  const details = useQuery(itemDetailsQuery(runtime, scope ?? [], lookupId));
  const adjacent = useQuery({
    queryKey: [...(scope ?? []), "adjacent-episodes", lookupId],
    queryFn: () => runtime.catalog.adjacentEpisodes(lookupId ?? ""),
    enabled: lookupId !== null,
  });
  const detailsItem = details.data?.item;
  const named = detailsItem === undefined ? undefined : namedShow(detailsItem);
  // Older servers leave the show unnamed, which takes a walk up the episode's parents.
  const walkedShow = useQuery({
    queryKey: [...(scope ?? []), "show-of", lookupId],
    queryFn: () => (detailsItem === undefined ? null : showOfEpisode(runtime.catalog, detailsItem)),
    enabled: detailsItem !== undefined && named === undefined,
  });

  // Each lookup that fails leaves its part out, so a failure never holds the rest back.
  const described = lookupId === null || (!details.isPending && !adjacent.isPending);
  const title = playingItem?.title ?? watchTitle ?? "Now playing";
  const description = useMemo<PlayingDescription | null>(() => {
    if (!described) return null;
    const contextOf = describedByItem ? playingItem : detailsItem;
    const next = adjacent.data?.next ?? null;
    return {
      title,
      context: contextOf == null ? "" : playingContext(contextOf),
      hasPreviousEpisode: adjacent.data?.previous != null,
      nextEpisode:
        next === null
          ? null
          : {
              title: next.title,
              // The show is the one already playing, so only the episode's place in it is said.
              context: episodeContext({ ...next, seriesTitle: null }),
              artwork: posterOf(next),
            },
    };
  }, [adjacent.data, described, describedByItem, detailsItem, playingItem, title]);

  const show =
    description === null ? null : named !== undefined ? named : (walkedShow.data ?? null);
  return { description, show, adjacentEpisodes: adjacent.data };
};
