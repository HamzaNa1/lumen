import type { IpcItem } from "@lumen/contracts";
import { Button, Modal, PosterFallback, posterHue, SegmentedControl } from "@lumen/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Play, Star } from "lucide-react";
import { useRef, useState } from "react";
import { formatClock, formatReleaseDate, formatRuntime, kindLabel, metadataList } from "./format";
import { bridge, useArtwork, useWorkspace, WatchedButton } from "./Workspace";

const playableKinds = new Set(["movie", "episode", "track"]);

const useChildren = (scope: readonly unknown[], parentId: string | null) =>
  useInfiniteQuery({
    queryKey: [...scope, "children", parentId],
    queryFn: ({ pageParam }) => bridge.library.itemChildren(parentId ?? "", pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: parentId !== null,
  });

const episodeCode = (seasonNumber: number | null | undefined, episode: IpcItem): string =>
  [
    seasonNumber == null ? null : `S${seasonNumber}`,
    episode.indexNumber == null ? null : `E${episode.indexNumber}`,
  ]
    .filter(Boolean)
    .join(" · ");

const DetailsContent = ({
  item,
  onPlay,
}: {
  readonly item: IpcItem;
  readonly onPlay: (item: IpcItem) => void;
}): React.ReactElement => {
  const { scope, account } = useWorkspace();
  const [failedImages, setFailedImages] = useState<ReadonlyArray<string>>([]);
  const [chosenSeasonId, setChosenSeasonId] = useState<string | null>(null);
  const isShow = item.kind === "show";
  const isSeason = item.kind === "season";
  const playable = playableKinds.has(item.kind);
  const details = useQuery({
    queryKey: [...scope, "item", item.id],
    queryFn: () => bridge.library.itemDetails(item.id),
  });
  const nextUp = useQuery({
    queryKey: [...scope, "next-up", item.id],
    queryFn: () => bridge.library.nextUp(item.id),
    enabled: isShow,
  });
  const seasons = useChildren(scope, isShow ? item.id : null);
  const seasonList = seasons.data?.pages.flatMap((page) => page.items) ?? [];
  const nextUpSeasonId = nextUp.data?.parentId ?? null;
  const activeSeasonId = isSeason
    ? item.id
    : (chosenSeasonId ??
      (seasonList.some((season) => season.id === nextUpSeasonId) ? nextUpSeasonId : null) ??
      seasonList[0]?.id ??
      null);
  const activeSeason = seasonList.find((season) => season.id === activeSeasonId);
  const episodes = useChildren(scope, isShow || isSeason ? activeSeasonId : null);
  const episodeList = episodes.data?.pages.flatMap((page) => page.items) ?? [];
  const metadata = details.data?.item;
  const poster = useArtwork(metadata?.artworkId ?? item.artworkId, scope);
  const backdrop = useArtwork(metadata?.backdropId, scope);
  const usable = (url: string | null | undefined): url is string =>
    url != null && !failedImages.includes(url);
  const markFailed = (url: string | null | undefined): void => {
    if (url != null) setFailedImages((previous) => [...previous, url]);
  };
  const posterUrl = usable(poster.data) ? poster.data : null;
  const heroUrl = usable(backdrop.data) ? backdrop.data : posterUrl;
  const title = metadata?.title ?? item.title;
  const year = metadata?.year ?? item.year;
  const runtimeSeconds =
    metadata?.durationSeconds ?? (item.durationMs === null ? null : item.durationMs / 1_000);
  const seasonNumber = (seasonId: string | null | undefined): number | null =>
    (isSeason
      ? item.indexNumber
      : seasonList.find((season) => season.id === seasonId)?.indexNumber) ?? null;
  const metaParts = [
    year === null ? null : String(year),
    item.kind === "movie"
      ? null
      : item.kind === "episode" || item.kind === "season"
        ? `${kindLabel(item.kind)}${item.indexNumber == null ? "" : ` ${item.indexNumber}`}`
        : kindLabel(item.kind),
    isShow && seasonList.length > 0
      ? `${seasonList.length} ${seasonList.length === 1 ? "season" : "seasons"}`
      : null,
    runtimeSeconds === null || runtimeSeconds <= 0 ? null : formatRuntime(runtimeSeconds),
  ].filter((part): part is string => part !== null);
  const genres = metadataList(metadata?.genresJson);
  const studios = metadataList(metadata?.studiosJson);
  const tags = metadataList(metadata?.tagsJson);
  const facts = [
    metadata?.releaseDate ? (["Released", formatReleaseDate(metadata.releaseDate)] as const) : null,
    studios.length > 0
      ? ([studios.length === 1 ? "Studio" : "Studios", studios.join(", ")] as const)
      : null,
    tags.length > 0 ? (["Tags", tags.join(", ")] as const) : null,
  ].filter((fact) => fact !== null);
  const currentItem: IpcItem = {
    ...item,
    completed: metadata?.completed ?? details.data?.watchState?.completed ?? item.completed,
    resumePositionSeconds:
      details.data === undefined
        ? item.resumePositionSeconds
        : details.data.watchState?.completed
          ? null
          : (details.data.watchState?.positionSeconds ?? null),
  };
  const resume = currentItem.resumePositionSeconds ?? 0;
  const next = nextUp.data ?? null;

  return (
    <div className="details">
      <div
        className={`details-hero${heroUrl === null ? " is-tinted" : ""}`}
        style={{ "--poster-hue": posterHue(title) } as React.CSSProperties}
      >
        {heroUrl === null ? null : (
          <img
            className={`details-hero-image${heroUrl === posterUrl ? " is-poster" : ""}`}
            src={heroUrl}
            alt=""
            draggable={false}
            onError={() => markFailed(heroUrl)}
          />
        )}
      </div>
      <div className="details-body">
        <div className="details-poster">
          {posterUrl === null ? (
            <PosterFallback title={title} kind={item.kind} />
          ) : (
            <img src={posterUrl} alt="" draggable={false} onError={() => markFailed(posterUrl)} />
          )}
        </div>
        <div className="details-main">
          <h2 className="details-title">{title}</h2>
          <div className="details-meta">
            {metaParts.map((part) => (
              <span className="details-meta-part" key={part}>
                {part}
              </span>
            ))}
            {metadata?.contentRating ? (
              <span className="rating-badge">{metadata.contentRating}</span>
            ) : null}
            {metadata?.communityRating == null ? null : (
              <span className="details-score">
                <Star aria-hidden="true" size={13} fill="currentColor" strokeWidth={0} />
                {metadata.communityRating.toFixed(1)}
              </span>
            )}
          </div>
          {genres.length === 0 ? null : (
            <ul className="details-genres" aria-label="Genres">
              {genres.map((genre) => (
                <li key={genre}>{genre}</li>
              ))}
            </ul>
          )}
          <div className="details-actions">
            {playable ? (
              <Button variant="primary" size="lg" onClick={() => onPlay(currentItem)}>
                <Play aria-hidden="true" size={16} fill="currentColor" strokeWidth={0} />
                {resume > 0 ? `Resume from ${formatClock(resume)}` : "Play"}
              </Button>
            ) : null}
            {isShow && next !== null ? (
              <>
                <Button variant="primary" size="lg" onClick={() => onPlay(next)}>
                  <Play aria-hidden="true" size={16} fill="currentColor" strokeWidth={0} />
                  {(next.resumePositionSeconds ?? 0) > 0 ? "Resume" : "Play"}
                </Button>
                <span className="details-next-up">
                  <span>Next up · {episodeCode(seasonNumber(next.parentId), next)}</span>
                  <strong>{next.title}</strong>
                </span>
              </>
            ) : null}
            {isSeason || item.kind === "movie" || item.kind === "episode" ? (
              <WatchedButton item={currentItem} />
            ) : null}
          </div>
        </div>
      </div>
      <div className="details-info">
        {details.isLoading ? (
          <div className="details-overview-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : metadata?.overview ? (
          <p className="details-overview">{metadata.overview}</p>
        ) : (
          <p className="details-overview is-empty">
            {details.data?.metadataProviderConfigured === false && account.role === "admin"
              ? "No description yet. Add a TMDb API key under Administration → Libraries to fetch descriptions and artwork."
              : "No description available."}
          </p>
        )}
        {facts.length === 0 ? null : (
          <dl className="details-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {isShow || isSeason ? (
        <section className="details-episodes" aria-label="Episodes">
          <header className="details-episodes-header">
            <h3>Episodes</h3>
            {isShow && activeSeason !== undefined ? (
              <WatchedButton key={activeSeasonId} item={activeSeason} />
            ) : null}
            {isShow && seasonList.length > 1 && activeSeasonId !== null ? (
              <SegmentedControl
                label="Season"
                value={activeSeasonId}
                options={seasonList.map((season) => ({ value: season.id, label: season.title }))}
                onValueChange={setChosenSeasonId}
              />
            ) : isShow && seasonList.length === 1 ? (
              <span className="details-episodes-season">{seasonList[0]?.title}</span>
            ) : null}
          </header>
          {seasons.isLoading || episodes.isLoading ? (
            <div className="episode-list-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : episodeList.length === 0 ? (
            <p className="details-episodes-empty">No episodes have been scanned yet.</p>
          ) : (
            <ol className="episode-list">
              {episodeList.map((episode) => (
                <li className="episode-list-item" key={episode.id}>
                  <button
                    className="episode-row"
                    type="button"
                    onClick={() => onPlay(episode)}
                    aria-label={`Play ${episode.title}`}
                  >
                    <span className="episode-number">{episode.indexNumber ?? "–"}</span>
                    <span className="episode-title">{episode.title}</span>
                    <span className="episode-meta">
                      {(episode.resumePositionSeconds ?? 0) > 0
                        ? `Resume at ${formatClock(episode.resumePositionSeconds ?? 0)}`
                        : episode.durationMs === null
                          ? null
                          : formatRuntime(episode.durationMs / 1_000)}
                    </span>
                    <span className="episode-play" aria-hidden="true">
                      <Play size={14} fill="currentColor" strokeWidth={0} />
                    </span>
                  </button>
                  <WatchedButton item={episode} compact />
                </li>
              ))}
            </ol>
          )}
          {episodes.hasNextPage ? (
            <Button
              variant="ghost"
              disabled={episodes.isFetchingNextPage}
              onClick={() => void episodes.fetchNextPage()}
            >
              {episodes.isFetchingNextPage ? "Loading…" : "Show more episodes"}
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
};

export const ItemDetails = ({
  item,
  onClose,
  onPlay,
}: {
  readonly item: IpcItem | null;
  readonly onClose: () => void;
  readonly onPlay: (item: IpcItem) => void;
}): React.ReactElement => {
  // Keep the last item rendered while the dialog animates closed.
  const lastItem = useRef(item);
  if (item !== null) lastItem.current = item;
  const shown = item ?? lastItem.current;
  return (
    <Modal
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={shown?.title ?? "Details"}
      description={shown === null ? undefined : kindLabel(shown.kind)}
      className="details-dialog"
      hideHeader
    >
      {shown === null ? null : <DetailsContent key={shown.id} item={shown} onPlay={onPlay} />}
    </Modal>
  );
};
