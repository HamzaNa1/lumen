import type { IpcItem, IpcItemDetails } from "@lumen/contracts";
import { Button, PosterFallback, posterHue, StatusState } from "@lumen/ui";
import { type UseQueryResult, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useCanGoBack, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Play, Star } from "lucide-react";
import { type ReactNode, useState } from "react";
import { LoadMore } from "./BrowsePages";
import {
  formatClock,
  formatReleaseDate,
  formatRuntime,
  kindLabel,
  metadataList,
  plural,
} from "./format";
import { ShowSettings } from "./ShowSettings";
import {
  bridge,
  CatalogCard,
  itemPage,
  PosterGridSkeleton,
  useArtwork,
  useWorkspace,
  WatchedButton,
} from "./Workspace";

const playableKinds = new Set(["movie", "episode", "track"]);

const useItemDetails = (itemId: string | null | undefined) => {
  const { scope } = useWorkspace();
  return useQuery({
    queryKey: [...scope, "item", itemId],
    queryFn: () => bridge.library.itemDetails(itemId ?? ""),
    enabled: itemId != null,
  });
};

const useChildren = (parentId: string) => {
  const { scope } = useWorkspace();
  return useInfiniteQuery({
    queryKey: [...scope, "children", parentId],
    queryFn: ({ pageParam }) => bridge.library.itemChildren(parentId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
};

// Playback and watched controls take catalog items; build one from the details response.
const catalogItem = ({ item, watchState }: IpcItemDetails): IpcItem => ({
  id: item.id,
  libraryId: item.libraryId,
  parentId: item.parentId,
  title: item.title,
  kind: item.kind,
  year: item.year,
  indexNumber: item.indexNumber,
  artworkId: item.artworkId,
  durationMs: item.durationSeconds === null ? null : item.durationSeconds * 1_000,
  completed: item.completed ?? watchState?.completed ?? false,
  resumePositionSeconds:
    watchState === null || watchState.completed ? null : watchState.positionSeconds,
});

const yearOf = (year: number | null): string | null => (year === null ? null : String(year));

const runtimeOf = (seconds: number | null): string | null =>
  seconds === null || seconds <= 0 ? null : formatRuntime(seconds);

/** "S1 E3", or whichever part is known. */
const episodeCode = (
  seasonNumber: number | null | undefined,
  episodeNumber: number | null | undefined,
): string | null =>
  [
    seasonNumber == null ? null : `S${seasonNumber}`,
    episodeNumber == null ? null : `E${episodeNumber}`,
  ]
    .filter(Boolean)
    .join(" ") || null;

const episodeSubtitle = (episode: IpcItem, seasonNumber: number | null | undefined): string =>
  [
    episodeCode(seasonNumber, episode.indexNumber),
    (episode.resumePositionSeconds ?? 0) > 0
      ? `Resume at ${formatClock(episode.resumePositionSeconds ?? 0)}`
      : runtimeOf(episode.durationMs === null ? null : episode.durationMs / 1_000),
  ]
    .filter(Boolean)
    .join(" · ");

const PlayButton = ({ item }: { readonly item: IpcItem }): React.ReactElement => {
  const { playItem } = useWorkspace();
  const resume = item.resumePositionSeconds ?? 0;
  return (
    <Button variant="primary" size="lg" onClick={() => playItem(item)}>
      <Play aria-hidden="true" size={16} fill="currentColor" strokeWidth={0} />
      {resume > 0 ? `Resume from ${formatClock(resume)}` : "Play"}
    </Button>
  );
};

/** Returns to the previous page, or to `fallback` when this page was the first one opened. */
const BackButton = ({ fallback }: { readonly fallback: () => void }): React.ReactElement => {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return (
    <Button
      variant="icon"
      className="details-back"
      aria-label="Back"
      title="Back"
      onClick={() => (canGoBack ? router.history.back() : fallback())}
    >
      <ChevronLeft aria-hidden="true" size={18} />
    </Button>
  );
};

const DetailsHeader = ({
  details,
  meta,
  backdropId,
  landscape = false,
  eyebrow,
  actions,
  onBack,
}: {
  readonly details: IpcItemDetails;
  readonly meta: ReadonlyArray<string | null>;
  /** Hero artwork when the item has no backdrop of its own, such as its show's. */
  readonly backdropId?: string | null;
  /** Show the item's artwork as a 16:9 still instead of a poster. */
  readonly landscape?: boolean;
  /** Links to the item's parents. */
  readonly eyebrow?: ReactNode;
  readonly actions?: ReactNode;
  readonly onBack: () => void;
}): React.ReactElement => {
  const { scope } = useWorkspace();
  const { item } = details;
  const [failedImages, setFailedImages] = useState<ReadonlyArray<string>>([]);
  const poster = useArtwork(item.artworkId, scope);
  const backdrop = useArtwork(item.backdropId ?? backdropId, scope);
  const usable = (url: string | null | undefined): url is string =>
    url != null && !failedImages.includes(url);
  const markFailed = (url: string): void => setFailedImages((previous) => [...previous, url]);
  const posterUrl = usable(poster.data) ? poster.data : null;
  const heroUrl = usable(backdrop.data) ? backdrop.data : posterUrl;
  const genres = metadataList(item.genresJson);
  return (
    <header className={`details-header${landscape ? " is-landscape" : ""}`}>
      <div
        className={`details-hero${heroUrl === null ? " is-tinted" : ""}`}
        style={{ "--poster-hue": posterHue(item.title) } as React.CSSProperties}
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
      <BackButton fallback={onBack} />
      <div className="details-body">
        <div className="details-poster">
          {posterUrl === null ? (
            <PosterFallback title={item.title} kind={item.kind} />
          ) : (
            <img src={posterUrl} alt="" draggable={false} onError={() => markFailed(posterUrl)} />
          )}
        </div>
        <div className="details-main">
          {eyebrow === undefined ? null : (
            <nav className="details-eyebrow" aria-label="Breadcrumb">
              {eyebrow}
            </nav>
          )}
          <h1 className="details-title">{item.title}</h1>
          <div className="details-meta">
            {meta
              .filter((part): part is string => part !== null)
              .map((part) => (
                <span className="details-meta-part" key={part}>
                  {part}
                </span>
              ))}
            {item.contentRating ? <span className="rating-badge">{item.contentRating}</span> : null}
            {item.communityRating == null ? null : (
              <span className="details-score">
                <Star aria-hidden="true" size={13} fill="currentColor" strokeWidth={0} />
                {item.communityRating.toFixed(1)}
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
          <div className="details-actions">{actions}</div>
        </div>
      </div>
    </header>
  );
};

const DetailsInfo = ({ details }: { readonly details: IpcItemDetails }): React.ReactElement => {
  const { account } = useWorkspace();
  const { item } = details;
  const studios = metadataList(item.studiosJson);
  const tags = metadataList(item.tagsJson);
  const facts = [
    item.releaseDate ? (["Released", formatReleaseDate(item.releaseDate)] as const) : null,
    studios.length > 0
      ? ([studios.length === 1 ? "Studio" : "Studios", studios.join(", ")] as const)
      : null,
    tags.length > 0 ? (["Tags", tags.join(", ")] as const) : null,
  ].filter((fact) => fact !== null);
  return (
    <div className="details-info">
      {item.overview ? (
        <p className="details-overview">{item.overview}</p>
      ) : (
        <p className="details-overview is-empty">
          {!details.metadataProviderConfigured && account.role === "admin"
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
  );
};

const DetailsSection = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): React.ReactElement => (
  <section className="details-section" aria-label={title}>
    <h2>{title}</h2>
    {children}
  </section>
);

/** Placeholder while an item page loads, or the error when it can't. */
const DetailsPending = ({
  query,
  landscape = false,
}: {
  readonly query: UseQueryResult<IpcItemDetails>;
  readonly landscape?: boolean;
}): React.ReactElement =>
  query.isError ? (
    <div className="page">
      <StatusState
        title="Couldn’t load this title"
        message="It may have been removed, or the server may be unreachable."
        action={<Button onClick={() => void query.refetch()}>Try again</Button>}
      />
    </div>
  ) : (
    <div className="details-page is-loading" role="status" aria-label="Loading">
      <header className={`details-header${landscape ? " is-landscape" : ""}`}>
        <div className="details-hero" />
        <div className="details-body">
          <div className="details-poster" />
          <div className="details-main">
            <span className="details-title-skeleton" />
            <span className="details-meta-skeleton" />
          </div>
        </div>
      </header>
    </div>
  );

const ListError = ({ onRetry }: { readonly onRetry: () => void }): React.ReactElement => (
  <StatusState
    title="Couldn’t load episodes"
    message="Check your connection to the server, then try again."
    action={<Button onClick={onRetry}>Try again</Button>}
  />
);

const MovieDetails = ({ itemId }: { readonly itemId: string }): React.ReactElement => {
  const navigate = useNavigate();
  const details = useItemDetails(itemId);
  if (details.data === undefined) return <DetailsPending query={details} />;
  const { item } = details.data;
  const current = catalogItem(details.data);
  return (
    <div className="details-page">
      <DetailsHeader
        details={details.data}
        meta={[
          yearOf(item.year),
          item.kind === "movie" ? null : kindLabel(item.kind),
          runtimeOf(item.durationSeconds),
        ]}
        onBack={() =>
          void navigate({ to: "/library/$libraryId", params: { libraryId: item.libraryId } })
        }
        actions={
          <>
            {playableKinds.has(item.kind) ? <PlayButton item={current} /> : null}
            {item.kind === "movie" ? <WatchedButton item={current} /> : null}
          </>
        }
      />
      <DetailsInfo details={details.data} />
    </div>
  );
};

const ShowDetails = ({ itemId }: { readonly itemId: string }): React.ReactElement => {
  const { account, scope } = useWorkspace();
  const navigate = useNavigate();
  const details = useItemDetails(itemId);
  const nextUp = useQuery({
    queryKey: [...scope, "next-up", itemId],
    queryFn: () => bridge.library.nextUp(itemId),
  });
  const children = useChildren(itemId);
  if (details.data === undefined) return <DetailsPending query={details} />;
  const { item } = details.data;
  const childList = children.data?.pages.flatMap((page) => page.items) ?? [];
  const seasons = childList.filter((child) => child.kind === "season");
  // Episodes outside a season folder belong to the show itself.
  const looseEpisodes = childList.filter((child) => child.kind === "episode");
  const next = nextUp.data ?? null;
  const seasonNumber = (seasonId: string | null | undefined): number | null =>
    seasons.find((season) => season.id === seasonId)?.indexNumber ?? null;
  return (
    <div className="details-page">
      <DetailsHeader
        details={details.data}
        meta={[
          yearOf(item.year),
          kindLabel(item.kind),
          seasons.length === 0 ? null : plural(seasons.length, "season"),
        ]}
        onBack={() =>
          void navigate({ to: "/library/$libraryId", params: { libraryId: item.libraryId } })
        }
        actions={
          <>
            {next === null ? null : <PlayButton item={next} />}
            {account.role === "admin" ? (
              <ShowSettings
                itemId={item.id}
                title={item.title}
                metadataProviderConfigured={details.data.metadataProviderConfigured}
              />
            ) : null}
          </>
        }
      />
      <DetailsInfo details={details.data} />
      {next === null ? null : (
        <DetailsSection title="Next up">
          <div className="episode-grid">
            <CatalogCard
              item={next}
              subtitle={episodeSubtitle(next, seasonNumber(next.parentId))}
              landscape
            />
          </div>
        </DetailsSection>
      )}
      {children.isLoading ? (
        <DetailsSection title="Seasons">
          <PosterGridSkeleton count={6} />
        </DetailsSection>
      ) : children.isError ? (
        <DetailsSection title="Seasons">
          <ListError onRetry={() => void children.refetch()} />
        </DetailsSection>
      ) : childList.length === 0 ? (
        <DetailsSection title="Seasons">
          <p className="details-empty">No episodes have been scanned yet.</p>
        </DetailsSection>
      ) : (
        <>
          {seasons.length === 0 ? null : (
            <DetailsSection title="Seasons">
              <div className="media-grid">
                {seasons.map((season) => (
                  <CatalogCard key={season.id} item={season} subtitle={yearOf(season.year)} />
                ))}
              </div>
            </DetailsSection>
          )}
          {looseEpisodes.length === 0 ? null : (
            <DetailsSection title="Episodes">
              <div className="episode-grid">
                {looseEpisodes.map((episode) => (
                  <CatalogCard
                    key={episode.id}
                    item={episode}
                    subtitle={episodeSubtitle(episode, null)}
                    landscape
                  />
                ))}
              </div>
            </DetailsSection>
          )}
          <div className="details-section">
            <LoadMore query={children} />
          </div>
        </>
      )}
    </div>
  );
};

const SeasonDetails = ({ itemId }: { readonly itemId: string }): React.ReactElement => {
  const navigate = useNavigate();
  const details = useItemDetails(itemId);
  const show = useItemDetails(details.data?.item.parentId);
  const episodes = useChildren(itemId);
  if (details.data === undefined) return <DetailsPending query={details} />;
  const { item } = details.data;
  const showItem = show.data?.item;
  const list = episodes.data?.pages.flatMap((page) => page.items) ?? [];
  const more = episodes.hasNextPage;
  return (
    <div className="details-page">
      <DetailsHeader
        details={details.data}
        backdropId={showItem?.backdropId}
        eyebrow={
          showItem === undefined ? null : (
            <Link to="/show/$itemId" params={{ itemId: showItem.id }}>
              {showItem.title}
            </Link>
          )
        }
        meta={[
          yearOf(item.year),
          episodes.data === undefined
            ? null
            : `${list.length}${more ? "+" : ""} ${list.length === 1 && !more ? "episode" : "episodes"}`,
        ]}
        onBack={() =>
          void navigate(
            item.parentId === null
              ? { to: "/library/$libraryId", params: { libraryId: item.libraryId } }
              : { to: "/show/$itemId", params: { itemId: item.parentId } },
          )
        }
        actions={<WatchedButton item={catalogItem(details.data)} />}
      />
      <DetailsInfo details={details.data} />
      <DetailsSection title="Episodes">
        {episodes.isLoading ? (
          <PosterGridSkeleton count={6} landscape />
        ) : episodes.isError ? (
          <ListError onRetry={() => void episodes.refetch()} />
        ) : list.length === 0 ? (
          <p className="details-empty">No episodes have been scanned yet.</p>
        ) : (
          <>
            <div className="episode-grid">
              {list.map((episode) => (
                <CatalogCard
                  key={episode.id}
                  item={episode}
                  subtitle={episodeSubtitle(episode, item.indexNumber)}
                  landscape
                />
              ))}
            </div>
            <LoadMore query={episodes} />
          </>
        )}
      </DetailsSection>
    </div>
  );
};

const EpisodeDetails = ({ itemId }: { readonly itemId: string }): React.ReactElement => {
  const navigate = useNavigate();
  const details = useItemDetails(itemId);
  // Episodes usually sit in a season, but may belong to the show directly.
  const parent = useItemDetails(details.data?.item.parentId);
  const season = parent.data?.item.kind === "season" ? parent.data.item : undefined;
  const seasonShow = useItemDetails(season?.parentId);
  const show = season === undefined ? parent.data?.item : seasonShow.data?.item;
  if (details.data === undefined) return <DetailsPending query={details} landscape />;
  const { item } = details.data;
  const current = catalogItem(details.data);
  return (
    <div className="details-page">
      <DetailsHeader
        details={details.data}
        landscape
        backdropId={show?.backdropId}
        eyebrow={
          show?.kind !== "show" ? null : (
            <>
              <Link to="/show/$itemId" params={{ itemId: show.id }}>
                {show.title}
              </Link>
              {season === undefined ? null : (
                <>
                  <ChevronRight aria-hidden="true" size={13} />
                  <Link to="/season/$itemId" params={{ itemId: season.id }}>
                    {season.title}
                  </Link>
                </>
              )}
            </>
          )
        }
        meta={[
          episodeCode(season?.indexNumber, item.indexNumber),
          runtimeOf(item.durationSeconds),
          yearOf(item.year),
        ]}
        onBack={() =>
          void navigate(
            parent.data === undefined
              ? { to: "/library/$libraryId", params: { libraryId: item.libraryId } }
              : itemPage(parent.data.item),
          )
        }
        actions={
          <>
            <PlayButton item={current} />
            <WatchedButton item={current} />
          </>
        }
      />
      <DetailsInfo details={details.data} />
    </div>
  );
};

// Keyed by item so moving between items of the same kind starts from fresh state.
export const ItemPage = (): React.ReactElement => {
  const { itemId } = useParams({ from: "/item/$itemId" });
  return <MovieDetails key={itemId} itemId={itemId} />;
};

export const ShowPage = (): React.ReactElement => {
  const { itemId } = useParams({ from: "/show/$itemId" });
  return <ShowDetails key={itemId} itemId={itemId} />;
};

export const SeasonPage = (): React.ReactElement => {
  const { itemId } = useParams({ from: "/season/$itemId" });
  return <SeasonDetails key={itemId} itemId={itemId} />;
};

export const EpisodePage = (): React.ReactElement => {
  const { itemId } = useParams({ from: "/episode/$itemId" });
  return <EpisodeDetails key={itemId} itemId={itemId} />;
};
