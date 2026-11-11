import type { LumenRuntime } from "@lumen/client/runtime";
import {
  type AdjacentEpisodes,
  type CatalogItem,
  type CatalogItemBase,
  type CatalogItemDetails,
  type EpisodePlacement,
  type PlayingDescription,
  posterOf,
  type ShowSummary,
} from "@lumen/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { episodeContext, playingContext } from "./format";
import { showOfEpisode } from "./ShowEpisodes";
import { itemDetailsQuery } from "./Workspace";

/**
 * How long the player waits for every detail it has to look up before it shows what it has and
 * fills in the rest as it arrives, so a stalled lookup never leaves it blank.
 */
const describeWithinMs = 1_500;

export interface Playing {
  /** Null until every part of it is known or the wait for it runs out. */
  readonly description: PlayingDescription | null;
  /** Null until the description is known, and for anything that is not an episode of a show. */
  readonly show: ShowSummary | null;
  /** Where Previous and Next lead. */
  readonly adjacentEpisodes: AdjacentEpisodes | undefined;
}

type Describable = CatalogItem | CatalogItemDetails["item"];

/** What the player says of an item, and of an episode the place in its show it was given. */
const describe = (
  title: string,
  item: Describable | undefined,
  placement: EpisodePlacement | undefined,
  neighbours: { readonly previous: CatalogItemBase | null; readonly next: CatalogItemBase | null },
): PlayingDescription => ({
  title,
  context:
    item === undefined
      ? ""
      : playingContext(
          placement === undefined
            ? item
            : {
                ...item,
                seriesTitle: placement.show.title,
                seasonNumber: placement.seasonNumber,
                seasonYear: placement.seasonYear,
              },
        ),
  artwork: item === undefined ? null : posterOf(item),
  hasPreviousEpisode: neighbours.previous !== null,
  nextEpisode:
    neighbours.next === null
      ? null
      : {
          title: neighbours.next.title,
          // The show is the one already playing, so only the episode's place in it is said.
          context: episodeContext({ ...neighbours.next, seriesTitle: null }),
          artwork: posterOf(neighbours.next),
        },
});

/**
 * What the player says about what is playing. The item playback was started from describes it
 * at once: anything but an episode by itself, and an episode by the place in its show the server
 * sent with it. Only playback that starts without one, such as a watch group's, or an episode
 * from a server too old to place it, is looked up while playback starts.
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
  const knownAtOnce =
    startedFrom !== null && (startedFrom.kind !== "episode" || startedFrom.placement !== undefined);
  const mayBeEpisode = startedFrom === null || startedFrom.kind === "episode";

  // An episode's neighbours, each placed in turn, so moving on to one is described at once too.
  const neighboursOf = scope !== null && mayBeEpisode ? playingId : null;
  const adjacent = useQuery({
    queryKey: [...(scope ?? []), "adjacent-episodes", neighboursOf],
    queryFn: () => runtime.catalog.adjacentEpisodes(neighboursOf ?? ""),
    enabled: neighboursOf !== null,
  });
  const lookupId = scope === null || knownAtOnce ? null : playingId;
  const details = useQuery(itemDetailsQuery(runtime, scope ?? [], lookupId));
  const detailsItem = details.data?.item;
  const walkedShow = useQuery({
    queryKey: [...(scope ?? []), "show-of", lookupId],
    queryFn: () => (detailsItem === undefined ? null : showOfEpisode(runtime.catalog, detailsItem)),
    enabled: detailsItem !== undefined && detailsItem.placement === undefined,
  });

  const [waitedOutFor, setWaitedOutFor] = useState<string | null>(null);
  useEffect(() => {
    if (lookupId === null) return;
    const timer = setTimeout(() => setWaitedOutFor(lookupId), describeWithinMs);
    return () => clearTimeout(timer);
  }, [lookupId]);

  // Details that place the episode say all there is; without a placement its neighbours are a
  // lookup of their own. Each lookup that fails leaves its part out.
  const lookedUp =
    !details.isPending && (detailsItem?.placement !== undefined || !adjacent.isPending);
  const described = knownAtOnce || lookupId === null || waitedOutFor === lookupId || lookedUp;
  // An episode's details say more of where it sits than the item it was started from, which
  // still says something while they are missing.
  const describedItem = knownAtOnce
    ? (startedFrom ?? undefined)
    : (detailsItem ?? startedFrom ?? undefined);
  const placement = describedItem?.placement;
  const title = startedFrom?.title ?? watchTitle ?? "Now playing";
  const description = useMemo<PlayingDescription | null>(
    () =>
      described
        ? describe(
            title,
            describedItem,
            placement,
            placement ?? {
              previous: adjacent.data?.previous ?? null,
              next: adjacent.data?.next ?? null,
            },
          )
        : null,
    [adjacent.data, described, describedItem, placement, title],
  );

  const show =
    description === null
      ? null
      : (placement?.show ?? (lookupId === null ? null : (walkedShow.data ?? null)));
  const adjacentEpisodes: AdjacentEpisodes | undefined =
    adjacent.data ??
    (placement === undefined ? undefined : { previous: placement.previous, next: placement.next });
  return { description, show, adjacentEpisodes };
};
