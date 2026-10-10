import type { LumenRuntime } from "@lumen/client/runtime";
import type {
  AccountSummary,
  CatalogItem,
  PlayerAction,
  PlayerDisplay,
  PlayerState,
  WatchPlayback,
} from "@lumen/contracts";
import { Button, MediaCard } from "@lumen/ui";
import {
  type QueryClient,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, CircleCheck, LoaderCircle } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { errorMessage } from "./format";
import { useRuntime } from "./Runtime";

/** The saved accounts, which also carry each server's name. */
export const ACCOUNTS_KEY = ["accounts"] as const;

export interface WorkspaceValue {
  readonly account: AccountSummary;
  readonly scope: readonly unknown[];
  readonly openItem: (item: CatalogItem) => void;
  readonly playItem: (item: CatalogItem) => void;
  readonly openConnections: (view: "saved" | "add") => void;
  readonly watchPlayback: WatchPlayback | null;
  readonly playingItem: CatalogItem | null;
  readonly player: PlayerState | null;
  readonly playbackLoading: boolean;
  readonly playbackError: string | null;
  /** What the player controls show, wherever the platform draws them. */
  readonly playerDisplay: PlayerDisplay;
  readonly onPlayerAction: (action: PlayerAction) => void;
  readonly beginPlayback: (item: CatalogItem) => Promise<void>;
  readonly reportPlaybackError: (cause: unknown) => void;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export const useWorkspace = (): WorkspaceValue => {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("Workspace is unavailable without an active account");
  return value;
};

export const itemDetailsQuery = (
  runtime: LumenRuntime,
  scope: readonly unknown[],
  itemId: string | null | undefined,
) => ({
  queryKey: [...scope, "item", itemId],
  queryFn: () => runtime.catalog.itemDetails(itemId ?? ""),
  enabled: itemId != null,
});

/** The page for an item. Movies and other standalone titles share one. */
export const itemPage = (item: Pick<CatalogItem, "id" | "kind">) => {
  const params = { itemId: item.id };
  switch (item.kind) {
    case "show":
      return { to: "/show/$itemId", params } as const;
    case "season":
      return { to: "/season/$itemId", params } as const;
    case "episode":
      return { to: "/episode/$itemId", params } as const;
    default:
      return { to: "/item/$itemId", params } as const;
  }
};

export const useLibraries = (scope: readonly unknown[]) => {
  const runtime = useRuntime();
  return useQuery({ queryKey: [...scope, "libraries"], queryFn: () => runtime.catalog.libraries() });
};

export const useArtwork = (artworkId: string | null | undefined, scope: readonly unknown[]) => {
  const runtime = useRuntime();
  return useQuery({
    queryKey: [...scope, "artwork", artworkId],
    queryFn: () => runtime.artwork.url(artworkId ?? ""),
    enabled: artworkId != null,
    staleTime: Number.POSITIVE_INFINITY,
  });
};

/** Refetches everything that shows watch progress, after it changes. */
export const refreshWatchProgress = (client: QueryClient, scope: readonly unknown[]) =>
  client.invalidateQueries({
    queryKey: scope,
    predicate: (query) =>
      ["home", "items", "item", "children", "next-up", "search"].includes(
        String(query.queryKey[scope.length]),
      ),
  });

export const WatchedButton = ({
  item,
  compact = false,
}: {
  readonly item: CatalogItem;
  readonly compact?: boolean;
}): React.ReactElement => {
  const { scope } = useWorkspace();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const mutationKey = [...scope, "watch-state"];
  const pending = useIsMutating({ mutationKey }) > 0;
  const update = useMutation({
    mutationKey,
    mutationFn: (completed: boolean) => runtime.catalog.setWatched(item.id, completed),
    onSuccess: () => refreshWatchProgress(queryClient, scope),
  });
  const completed = item.completed === true;
  const label = `Mark ${item.title} as ${completed ? "unwatched" : "watched"}`;
  const Icon = update.isPending ? LoaderCircle : completed ? CircleCheck : Check;
  return (
    <div className={`watch-control${compact ? " is-compact" : ""}`}>
      <Button
        className={`watch-button${completed ? " is-watched" : ""}`}
        variant={compact ? "icon" : "secondary"}
        size={compact ? "sm" : "lg"}
        aria-label={label}
        aria-pressed={completed}
        aria-busy={update.isPending}
        title={label}
        disabled={pending}
        onClick={() => update.mutate(!completed)}
      >
        <Icon aria-hidden="true" size={16} className={update.isPending ? "spinner" : undefined} />
        {compact ? null : update.isPending ? "Saving…" : completed ? "Watched" : "Mark as watched"}
      </Button>
      {update.isError ? (
        <span className="watch-error" role="alert">
          {errorMessage(update.error, "Couldn’t update watched status. Try again.")}
        </span>
      ) : null}
    </div>
  );
};

export const CatalogCard = ({
  item,
  subtitle,
  detail,
  landscape = false,
}: {
  readonly item: CatalogItem;
  readonly subtitle?: string | null;
  readonly detail?: string | null;
  /** Wide artwork, for episode stills. */
  readonly landscape?: boolean;
}): React.ReactElement => {
  const { scope, openItem, playItem } = useWorkspace();
  const artwork = useArtwork(item.artworkId, scope);
  return (
    <MediaCard
      title={item.title}
      subtitle={subtitle}
      detail={detail}
      kind={item.kind}
      landscape={landscape}
      imageUrl={artwork.data ?? null}
      progress={
        item.durationMs !== null && item.durationMs > 0 && item.resumePositionSeconds
          ? (item.resumePositionSeconds * 1_000) / item.durationMs
          : null
      }
      action={
        ["movie", "season", "episode"].includes(item.kind) ? (
          <WatchedButton item={item} compact />
        ) : null
      }
      onOpen={() => openItem(item)}
      onPlay={() => playItem(item)}
    />
  );
};

export const PageHeader = ({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}): React.ReactElement => (
  <header className="page-header">
    <div className="page-header-text">
      <h1>{title}</h1>
      {subtitle === undefined ? null : <p>{subtitle}</p>}
    </div>
    {actions === undefined ? null : <div className="page-header-actions">{actions}</div>}
  </header>
);

const skeletonKeys = Array.from({ length: 12 }, (_, index) => `skeleton-${index}`);

export const PosterGridSkeleton = ({
  count = 12,
  layout = "grid",
  landscape = false,
}: {
  readonly count?: number;
  readonly layout?: "grid" | "row";
  readonly landscape?: boolean;
}): React.ReactElement => (
  <div
    className={layout === "row" ? "shelf-row" : landscape ? "episode-grid" : "media-grid"}
    aria-hidden="true"
  >
    {skeletonKeys.slice(0, count).map((key) => (
      <div className={`media-card-skeleton${landscape ? " is-landscape" : ""}`} key={key}>
        <span />
        <span />
        <span />
      </div>
    ))}
  </div>
);
