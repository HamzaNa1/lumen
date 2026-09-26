import type { IpcItem, IpcItemPage, IpcLibrary } from "@lumen/contracts";
import { Button, EmptyState, Form, PosterFallback, StatusState } from "@lumen/ui";
import {
  type InfiniteData,
  keepPreviousData,
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  LibraryBig,
  LoaderCircle,
  Search as SearchIcon,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatClock, kindLabel, libraryCount, plural } from "./format";
import {
  bridge,
  CatalogCard,
  PageHeader,
  PosterGridSkeleton,
  useArtwork,
  useLibraries,
  useWorkspace,
} from "./Workspace";

const yearOf = (item: IpcItem): string | null => (item.year === null ? null : String(item.year));

const NoLibraries = (): React.ReactElement => {
  const { account } = useWorkspace();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={LibraryBig}
      title="No libraries yet"
      message={
        account.role === "admin"
          ? "Create a library and point it at a folder of movies or shows on the server."
          : "Ask the server administrator to share a library with you."
      }
      action={
        account.role === "admin" ? (
          <Button variant="primary" onClick={() => void navigate({ to: "/admin" })}>
            Set up a library
          </Button>
        ) : undefined
      }
    />
  );
};

const Shelf = ({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): React.ReactElement => {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const updateEdges = useCallback((): void => {
    const row = rowRef.current;
    if (row === null) return;
    const start = row.scrollLeft <= 1;
    const end = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
    setEdges((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    );
  }, []);
  useLayoutEffect(() => {
    updateEdges();
  });
  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(row);
    return () => observer.disconnect();
  }, [updateEdges]);
  const scroll = (direction: -1 | 1): void => {
    const row = rowRef.current;
    row?.scrollBy({ left: direction * row.clientWidth * 0.85, behavior: "smooth" });
  };
  return (
    <section className="shelf">
      <header className="shelf-header">
        <h2>{title}</h2>
        <div className="shelf-actions">
          {action}
          {edges.start && edges.end ? null : (
            <>
              <Button
                variant="icon"
                size="sm"
                aria-label={`Scroll ${title} back`}
                disabled={edges.start}
                onClick={() => scroll(-1)}
              >
                <ChevronLeft aria-hidden="true" size={16} />
              </Button>
              <Button
                variant="icon"
                size="sm"
                aria-label={`Scroll ${title} forward`}
                disabled={edges.end}
                onClick={() => scroll(1)}
              >
                <ChevronRight aria-hidden="true" size={16} />
              </Button>
            </>
          )}
        </div>
      </header>
      <div className="shelf-row" ref={rowRef} onScroll={updateEdges}>
        {children}
      </div>
    </section>
  );
};

const homeSubtitle = (item: IpcItem, resume = false): string | null => {
  const context =
    item.seriesTitle == null
      ? null
      : [
          item.seriesTitle,
          item.kind === "episode" && item.indexNumber != null
            ? `S${item.seasonNumber ?? 1} E${item.indexNumber}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    context ?? (resume ? `Resume at ${formatClock(item.resumePositionSeconds ?? 0)}` : yearOf(item))
  );
};

const LibraryTile = ({
  library,
  artworkId,
}: {
  readonly library: IpcLibrary;
  readonly artworkId?: string | null;
}): React.ReactElement => {
  const { scope } = useWorkspace();
  const items = useQuery({
    queryKey: [...scope, "items", library.id, "thumbnail"],
    queryFn: () => bridge.library.items(library.id),
    enabled: artworkId == null,
  });
  const artwork = useArtwork(
    artworkId ?? items.data?.items.find((item) => item.artworkId != null)?.artworkId,
    scope,
  );
  const imageUrl = artwork.data;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <article className="media-card">
      <Link
        className="media-card-open library-tile"
        to="/library/$libraryId"
        params={{ libraryId: library.id }}
      >
        <span className="media-card-art">
          {imageUrl != null && failedImage !== imageUrl ? (
            <img
              className="poster"
              src={imageUrl}
              alt=""
              loading="lazy"
              draggable={false}
              onError={() => setFailedImage(imageUrl)}
            />
          ) : (
            <PosterFallback
              title={library.name}
              kind={library.kind === "shows" ? "show" : library.kind === "music" ? "album" : "movie"}
            />
          )}
        </span>
        <span className="media-card-title">{library.name}</span>
      </Link>
    </article>
  );
};

export const HomePage = (): React.ReactElement => {
  const { scope } = useWorkspace();
  const home = useQuery({
    queryKey: [...scope, "home"],
    queryFn: () => bridge.library.home(),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const data = home.data;
  const contentRows = (items: ReadonlyArray<IpcItem>, title: string, resume = false) =>
    items.length === 0 ? null : (
      <Shelf key={title} title={title}>
        {items.map((item) => (
          <CatalogCard key={item.id} item={item} subtitle={homeSubtitle(item, resume)} />
        ))}
      </Shelf>
    );
  return (
    <div className="page">
      <PageHeader title="Home" />
      {home.isLoading ? (
        <section className="shelf">
          <PosterGridSkeleton layout="row" count={8} />
        </section>
      ) : home.isError ? (
        <StatusState
          title="Couldn’t load Home"
          message="Check that the server is running and reachable."
          action={<Button onClick={() => void home.refetch()}>Try again</Button>}
        />
      ) : data?.libraryCount === 0 ? (
        <NoLibraries />
      ) : data ? (
        <>
          <Shelf title="My Media">
            {data.libraries.map((library) => {
              const artworkId = data.latest
                .find((row) => row.libraryId === library.id)
                ?.items.find((item) => item.artworkId != null)?.artworkId;
              return (
                <LibraryTile
                  key={library.id}
                  library={library}
                  artworkId={artworkId}
                />
              );
            })}
          </Shelf>
          {contentRows(data.continueWatching, "Continue watching", true)}
          {contentRows(data.continueListening, "Continue listening", true)}
          {contentRows(data.nextUp, "Next up")}
          {data.latest.map((row) => (
            <Shelf
              key={row.libraryId}
              title={`Latest ${row.libraryName}`}
              action={
                <Link
                  className="shelf-link"
                  to="/library/$libraryId"
                  params={{ libraryId: row.libraryId }}
                >
                  See all
                </Link>
              }
            >
              {row.items.map((item) => (
                <CatalogCard key={item.id} item={item} subtitle={homeSubtitle(item)} />
              ))}
            </Shelf>
          ))}
        </>
      ) : null}
    </div>
  );
};

export const LibraryIndexPage = (): React.ReactElement => {
  const { scope } = useWorkspace();
  const libraries = useLibraries(scope);
  const first = libraries.data?.[0];
  if (first !== undefined)
    return <Navigate to="/library/$libraryId" params={{ libraryId: first.id }} replace />;
  if (libraries.isLoading)
    return (
      <div className="page">
        <PosterGridSkeleton />
      </div>
    );
  return (
    <div className="page">
      <PageHeader title="Library" />
      <NoLibraries />
    </div>
  );
};

const LoadMore = ({
  query,
}: {
  readonly query: UseInfiniteQueryResult<InfiniteData<IpcItemPage>>;
}): React.ReactElement | null => {
  const ref = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const node = ref.current;
    if (node === null || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
      },
      { root: node.closest(".main-content"), rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  if (!hasNextPage) return null;
  return (
    <div className="load-more" ref={ref}>
      {isFetchingNextPage ? (
        <LoaderCircle className="spinner" aria-label="Loading more titles" size={18} />
      ) : (
        <Button variant="ghost" onClick={() => void fetchNextPage()}>
          Load more
        </Button>
      )}
    </div>
  );
};

const LibraryGrid = ({ library }: { readonly library: IpcLibrary }): React.ReactElement => {
  const { account, scope } = useWorkspace();
  const navigate = useNavigate();
  const items = useInfiniteQuery({
    queryKey: [...scope, "items", library.id, "all"],
    queryFn: ({ pageParam }) => bridge.library.items(library.id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const list = items.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="page">
      <PageHeader
        title={library.name}
        subtitle={
          items.data === undefined
            ? undefined
            : libraryCount(library.kind, list.length, items.hasNextPage)
        }
      />
      {items.isLoading ? (
        <PosterGridSkeleton />
      ) : items.isError ? (
        <StatusState
          title="Couldn’t load this library"
          message="Check your connection to the server, or whether you still have access."
          action={<Button onClick={() => void items.refetch()}>Try again</Button>}
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={LibraryBig}
          title={`${library.name} is empty`}
          message={
            account.role === "admin"
              ? "Add a media folder to this library and run a scan."
              : "Titles will appear here once the administrator adds media."
          }
          action={
            account.role === "admin" ? (
              <Button onClick={() => void navigate({ to: "/admin" })}>Manage libraries</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="media-grid">
            {list.map((item) => (
              <CatalogCard key={item.id} item={item} subtitle={yearOf(item)} />
            ))}
          </div>
          <LoadMore query={items} />
        </>
      )}
    </div>
  );
};

export const LibraryPage = (): React.ReactElement => {
  const { libraryId } = useParams({ from: "/library/$libraryId" });
  const { scope } = useWorkspace();
  const libraries = useLibraries(scope);
  const library = libraries.data?.find((entry) => entry.id === libraryId);
  if (library !== undefined) return <LibraryGrid key={library.id} library={library} />;
  if (libraries.isLoading)
    return (
      <div className="page">
        <PosterGridSkeleton />
      </div>
    );
  // The library belongs to another server or was removed.
  return <Navigate to="/library" replace />;
};

const extractItems = (value: unknown): ReadonlyArray<IpcItem> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("items" in value) ||
    !Array.isArray(value.items)
  )
    return [];
  return value.items.filter(
    (item): item is IpcItem =>
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.libraryId === "string" &&
      typeof item.kind === "string",
  );
};

export const SearchPage = (): React.ReactElement => {
  const { scope } = useWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate({ from: "/search" });
  // The submitted query lives in the URL so returning from the player (or history) restores it.
  const submitted = useSearch({ from: "/search", select: (search) => search.q ?? "" });
  const [query, setQuery] = useState(submitted);
  const [shownQuery, setShownQuery] = useState(submitted);
  if (submitted !== shownQuery) {
    setShownQuery(submitted);
    if (submitted !== query.trim()) setQuery(submitted);
  }
  const submit = useCallback(
    (value: string): void => {
      const next = value.trim();
      void navigate({ search: next === "" ? {} : { q: next }, replace: true });
    },
    [navigate],
  );
  useEffect(() => {
    const timer = setTimeout(() => submit(query), 250);
    return () => clearTimeout(timer);
  }, [query, submit]);
  const results = useQuery({
    queryKey: [...scope, "search", submitted],
    queryFn: () => bridge.library.search(submitted),
    enabled: submitted !== "",
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => extractItems(results.data), [results.data]);
  return (
    <div className="page">
      <PageHeader title="Search" />
      <Form
        className="search-field"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit(query);
        }}
      >
        <SearchIcon aria-hidden="true" size={18} />
        <input
          id="search-input"
          ref={inputRef}
          className="search-input"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search movies, shows, and episodes"
          aria-label="Search your libraries"
          autoComplete="off"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: Search is the page's only purpose.
          autoFocus
        />
        {results.isFetching ? (
          <LoaderCircle className="spinner search-spinner" aria-hidden="true" size={16} />
        ) : null}
        {query === "" ? null : (
          <Button
            variant="icon"
            size="sm"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              submit("");
              inputRef.current?.focus();
            }}
          >
            <X aria-hidden="true" size={15} />
          </Button>
        )}
      </Form>
      {submitted === "" ? (
        <EmptyState
          icon={SearchIcon}
          title="Search your libraries"
          message="Find movies, shows, and episodes by title."
        />
      ) : results.data === undefined && results.isFetching ? (
        <PosterGridSkeleton count={6} />
      ) : results.isError ? (
        <StatusState
          title="Search failed"
          message="The server couldn’t complete the search. Try again in a moment."
          action={<Button onClick={() => void results.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title={`No results for “${submitted}”`}
          message="Check the spelling or try a shorter search."
        />
      ) : (
        <>
          <p className="results-summary">{plural(items.length, "result")}</p>
          <div className="media-grid">
            {items.map((item) => (
              <CatalogCard
                key={item.id}
                item={item}
                subtitle={[yearOf(item), kindLabel(item.kind)].filter(Boolean).join(" · ")}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
