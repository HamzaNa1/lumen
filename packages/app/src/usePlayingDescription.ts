import type { LumenRuntime } from "@lumen/client/runtime";
import {
  type AdjacentEpisodes,
  type CatalogItem,
  type PlayingDescription,
  posterOf,
  type ShowSummary,
} from "@lumen/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { episodeContext, playingContext } from "./format";
import { namedShow, showOfEpisode } from "./ShowEpisodes";
import { itemDetailsQuery } from "./Workspace";

/**
 * How long the player waits for every detail before it shows what it has and fills in the rest
 * as it arrives, so a stalled lookup never leaves it blank.
 */
const describeWithinMs = 1_500;

export interface Playing {
  /** Null until every part of it is known or the wait for it runs out. */
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
  // Starting playback in a watch group hands it to the group, which forgets the item it was
  // started from. The item still describes what plays, so it is kept for as long as that plays.
  const [startedItem, setStartedItem] = useState(playingItem);
  if (playingItem !== null && playingItem !== startedItem) setStartedItem(playingItem);
  const startedFrom = playingItem ?? (startedItem?.id === playingId ? startedItem : null);
  const describedByItem = startedFrom !== null && startedFrom.kind !== "episode";
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

  const [waitedOutFor, setWaitedOutFor] = useState<string | null>(null);
  useEffect(() => {
    if (lookupId === null) return;
    const timer = setTimeout(() => setWaitedOutFor(lookupId), describeWithinMs);
    return () => clearTimeout(timer);
  }, [lookupId]);

  // Each lookup that fails leaves its part out, so a failure never holds the rest back.
  const described =
    lookupId === null || waitedOutFor === lookupId || (!details.isPending && !adjacent.isPending);
  const title = startedFrom?.title ?? watchTitle ?? "Now playing";
  const description = useMemo<PlayingDescription | null>(() => {
    if (!described) return null;
    // An episode's details say more of where it sits than the item it was started from, which
    // still says something while they are missing.
    const contextOf = describedByItem ? startedFrom : (detailsItem ?? startedFrom);
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
  }, [adjacent.data, described, describedByItem, detailsItem, startedFrom, title]);

  const show =
    description === null ? null : named !== undefined ? named : (walkedShow.data ?? null);
  return { description, show, adjacentEpisodes: adjacent.data };
};
