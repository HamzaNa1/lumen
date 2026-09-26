import type { IpcAccount, IpcItem, IpcPlayerState } from "@lumen/contracts";
import { Button, MediaCard } from "@lumen/ui";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, LoaderCircle } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { errorMessage } from "./format";

export const bridge = window.lumen;

export interface WorkspaceValue {
  readonly account: IpcAccount;
  readonly scope: readonly unknown[];
  readonly openItem: (item: IpcItem) => void;
  readonly playItem: (item: IpcItem) => void;
  readonly openConnections: (view: "saved" | "add") => void;
  readonly playingItem: IpcItem | null;
  readonly player: IpcPlayerState | null;
  readonly playbackLoading: boolean;
  readonly playbackError: string | null;
  readonly beginPlayback: (item: IpcItem) => Promise<void>;
  readonly reportPlaybackError: (cause: unknown) => void;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export const useWorkspace = (): WorkspaceValue => {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("Workspace is unavailable without an active account");
  return value;
};

export const useLibraries = (scope: readonly unknown[]) =>
  useQuery({ queryKey: [...scope, "libraries"], queryFn: () => bridge.library.list() });

export const useArtwork = (artworkId: string | null | undefined, scope: readonly unknown[]) =>
  useQuery({
    queryKey: [...scope, "artwork", artworkId],
    queryFn: () => bridge.library.artwork(artworkId ?? ""),
    enabled: artworkId != null,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const WatchedButton = ({
  item,
  compact = false,
}: {
  readonly item: IpcItem;
  readonly compact?: boolean;
}): React.ReactElement => {
  const { scope } = useWorkspace();
  const queryClient = useQueryClient();
  const mutationKey = [...scope, "watch-state"];
  const pending = useIsMutating({ mutationKey }) > 0;
  const update = useMutation({
    mutationKey,
    mutationFn: (completed: boolean) => bridge.library.setWatched(item.id, completed),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: scope,
        predicate: (query) =>
          ["home", "items", "item", "children", "next-up", "search"].includes(
            String(query.queryKey[scope.length]),
          ),
      }),
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
}: {
  readonly item: IpcItem;
  readonly subtitle?: string | null;
}): React.ReactElement => {
  const { scope, openItem, playItem } = useWorkspace();
  const artwork = useArtwork(item.artworkId, scope);
  return (
    <MediaCard
      title={item.title}
      subtitle={subtitle}
      kind={item.kind}
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
}: {
  readonly count?: number;
  readonly layout?: "grid" | "row";
}): React.ReactElement => (
  <div className={layout === "grid" ? "media-grid" : "shelf-row"} aria-hidden="true">
    {skeletonKeys.slice(0, count).map((key) => (
      <div className="media-card-skeleton" key={key}>
        <span />
        <span />
        <span />
      </div>
    ))}
  </div>
);
