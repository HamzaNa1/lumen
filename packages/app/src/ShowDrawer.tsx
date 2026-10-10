import type { CatalogItem } from "@lumen/contracts";
import { Button, MediaCard } from "@lumen/ui";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, ListVideo, LoaderCircle, X } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { episodeCode, episodeSubtitle } from "./format";
import { useRuntime } from "./Runtime";
import { type EpisodeGroup, episodesOfShow, type ShowSummary, showOfEpisode } from "./ShowEpisodes";
import { useArtwork, watchedFraction } from "./Workspace";

const DRAWER_ID = "show-drawer";

// The player's controls may live in a window of their own, with no workspace to scope a cache by.
const playerScope = ["player"] as const;

/** The show whose episode is playing; null while unknown and for anything that is not an episode. */
export const usePlayingShow = (itemId: string | null): ShowSummary | null => {
  const runtime = useRuntime();
  const show = useQuery({
    queryKey: [...playerScope, "show", itemId],
    queryFn: () => showOfEpisode(runtime.catalog, itemId ?? ""),
    enabled: itemId !== null,
  });
  return show.data ?? null;
};

/**
 * Every episode of a show. The player reads it as soon as it knows the show, so the drawer opens
 * with its episodes already listed.
 */
export const useShowEpisodes = (showId: string | null) => {
  const runtime = useRuntime();
  return useQuery({
    queryKey: [...playerScope, "episodes", showId],
    queryFn: () => episodesOfShow(runtime.catalog, showId ?? ""),
    enabled: showId !== null,
    // Watch progress moves while the viewer watches, so every opening reads it afresh, behind the
    // episodes it already has.
    staleTime: 0,
  });
};

export const ShowDrawerButton = ({
  open,
  onToggle,
  buttonRef,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
}): React.ReactElement => (
  <Button
    ref={buttonRef}
    variant="icon"
    aria-label="Episodes"
    aria-expanded={open}
    aria-controls={DRAWER_ID}
    onClick={onToggle}
  >
    <ListVideo aria-hidden="true" size={19} />
  </Button>
);

const EpisodeCard = ({
  episode,
  seasonNumber,
  current,
  onSelect,
}: {
  readonly episode: CatalogItem;
  readonly seasonNumber: number | null;
  readonly current: boolean;
  readonly onSelect: () => void;
}): React.ReactElement => {
  const artwork = useArtwork(episode.artworkId, playerScope);
  return (
    <MediaCard
      title={episode.title}
      subtitle={
        current
          ? [episodeCode(seasonNumber, episode.indexNumber), "Now playing"]
              .filter(Boolean)
              .join(" · ")
          : episodeSubtitle(episode, seasonNumber)
      }
      kind={episode.kind}
      landscape
      imageUrl={artwork.data ?? null}
      progress={watchedFraction(episode)}
      current={current}
      onOpen={onSelect}
      onPlay={onSelect}
    />
  );
};

const groupTitle = (group: EpisodeGroup, groups: ReadonlyArray<EpisodeGroup>): string | null =>
  group.season !== null ? group.season.title : groups.length > 1 ? "Other episodes" : null;

/**
 * Every episode of the show being watched, opened at the one that is playing. Choosing another
 * plays it in place.
 */
export const ShowDrawer = ({
  show,
  currentItemId,
  returnFocus,
  onPlay,
  onClose,
}: {
  readonly show: ShowSummary;
  readonly currentItemId: string;
  /** Takes the keyboard's focus back when the drawer closes. */
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onPlay: (episode: CatalogItem) => void;
  readonly onClose: () => void;
}): React.ReactElement => {
  const episodes = useShowEpisodes(show.id);
  const panel = useRef<HTMLElement>(null);
  const groups = episodes.data;
  const loaded = groups !== undefined;

  useLayoutEffect(() => {
    if (!loaded) return;
    const current = panel.current?.querySelector('[aria-current="true"]');
    current?.scrollIntoView({ block: "center" });
    // A viewer who opened the drawer from the keyboard carries on from the playing episode. A
    // pointer leaves focus alone, so Space still pauses.
    if (returnFocus.current?.matches(":focus-visible") === true)
      current?.querySelector("button")?.focus({ preventScroll: true });
  }, [loaded, returnFocus]);

  useLayoutEffect(() => {
    const element = panel.current;
    const opener = returnFocus.current;
    return () => {
      const focused = document.activeElement;
      if (focused !== null && element?.contains(focused) && focused.matches(":focus-visible"))
        opener?.focus();
    };
  }, [returnFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="show-drawer-scrim" aria-hidden="true" onClick={onClose} />
      {/* `data-popup-open` marks an open popup to the player's shortcuts, which leave Escape to it. */}
      <aside className="show-drawer" id={DRAWER_ID} aria-label="Episodes" ref={panel} data-popup-open>
        <header className="show-drawer-header">
          <div className="show-drawer-title">
            <h2>{show.title}</h2>
            <p>Episodes</p>
          </div>
          <Button variant="icon" aria-label="Close episodes" onClick={onClose}>
            <X aria-hidden="true" size={19} />
          </Button>
        </header>
        <div className="show-drawer-body">
          {groups !== undefined ? (
            groups.map((group) => {
              const title = groupTitle(group, groups);
              return (
                <section className="show-drawer-season" key={group.season?.id ?? "show"}>
                  {title === null ? null : <h3>{title}</h3>}
                  <ul>
                    {group.episodes.map((episode) => (
                      <li key={episode.id}>
                        <EpisodeCard
                          episode={episode}
                          seasonNumber={group.season?.indexNumber ?? null}
                          current={episode.id === currentItemId}
                          onSelect={() =>
                            episode.id === currentItemId ? onClose() : onPlay(episode)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          ) : episodes.isError ? (
            <div className="show-drawer-status" role="alert">
              <CircleAlert aria-hidden="true" size={20} />
              <span>Couldn’t load episodes</span>
              <Button onClick={() => void episodes.refetch()}>Try again</Button>
            </div>
          ) : (
            <div className="show-drawer-status" role="status">
              <LoaderCircle className="spinner" aria-hidden="true" size={20} />
              <span>Loading episodes…</span>
            </div>
          )}
        </div>
      </aside>
    </>
  );
};
