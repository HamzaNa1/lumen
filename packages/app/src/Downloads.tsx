import type { DownloadsRuntime } from "@lumen/client/runtime";
import {
  type CatalogItem,
  type DeleteWatchedAfter,
  type DownloadEntry,
  type DownloadSettingsPatch,
  MAX_FREE_SPACE_PERCENT,
  MIN_FREE_SPACE_PERCENT,
  type RemoveUnopenedAfter,
  type StorageUsage,
  type StreamingCacheSize,
} from "@lumen/contracts";
import {
  Button,
  DropdownItem,
  DropdownMenu,
  DropdownSeparator,
  EmptyState,
  formatBytes,
  PosterFallback,
  SelectField,
} from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  CircleAlert,
  CircleCheck,
  Download,
  LoaderCircle,
  Pause,
  Pin,
  PinOff,
  Play,
  RotateCw,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { episodeCode, errorMessage, plural } from "./format";
import { useRuntime } from "./Runtime";
import { PageHeader, useWorkspace } from "./Workspace";

export const DOWNLOADS_KEY = ["downloads"] as const;

/**
 * Marks what only a device that keeps media shows. It takes no space of its own, and lets the
 * desktop and browser apps be compared apart from it.
 */
export const DeviceOnly = ({ children }: { readonly children: ReactNode }): React.ReactElement => (
  <span className="device-only" data-device-only="">
    {children}
  </span>
);

/** Keeps the download list current while the app is open. Mounted once, by the app shell. */
export const useDownloadUpdates = (): void => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      runtime.downloads?.onChange(
        () => void queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY }),
      ),
    [queryClient, runtime],
  );
};

const useDownloadState = () => {
  const runtime = useRuntime();
  return useQuery({
    queryKey: DOWNLOADS_KEY,
    queryFn: () => runtime.downloads?.state() ?? null,
    enabled: runtime.downloads !== null,
    // A local read, and the streaming cache changes it without telling anyone: always reread.
    staleTime: 0,
  });
};

/** The active account's downloads, or null where media cannot be kept on this device. */
const useAccountDownloads = (): ReadonlyArray<DownloadEntry> | null => {
  const { account } = useWorkspace();
  const state = useDownloadState();
  if (state.data == null) return null;
  return state.data.entries.filter((entry) => entry.connectionId === account.connectionId);
};

/** Whether new downloads can start: the server is reachable and supports them. */
const useCanDownload = (): boolean => useDownloadState().data?.available === true;

const useDownloadEntry = (itemId: string): DownloadEntry | null =>
  useAccountDownloads()?.find((entry) => entry.itemId === itemId) ?? null;

const percentOf = (entry: DownloadEntry): number =>
  entry.sizeBytes > 0
    ? Math.min(100, Math.floor((entry.downloadedBytes / entry.sizeBytes) * 100))
    : 0;

/** What a download is doing, in a few words. */
export const downloadStatusText = (entry: DownloadEntry): string => {
  switch (entry.status) {
    case "completed":
      return "Downloaded";
    case "downloading":
      return `Downloading ${percentOf(entry)}%`;
    case "queued":
      return "Queued";
    case "paused":
      return `Paused at ${percentOf(entry)}%`;
    case "waiting":
      return entry.reason ?? "Waiting";
    case "failed":
      return entry.reason ?? "Download failed";
  }
};

const useDownloadAction = <A,>(
  action: (downloads: DownloadsRuntime, input: A) => Promise<unknown>,
) => {
  const runtime = useRuntime();
  return useMutation({
    mutationFn: async (input: A) => {
      if (runtime.downloads === null) throw new Error("Downloads are unavailable here");
      await action(runtime.downloads, input);
    },
  });
};

const ActionError = ({ error }: { readonly error: unknown }): React.ReactElement | null =>
  error == null ? null : (
    <span className="download-error" role="alert">
      <CircleAlert aria-hidden="true" size={14} />
      {errorMessage(error, "Could not change the download")}
    </span>
  );

/** The menu items for one download: pause or resume, keep, remove. */
const EntryActions = ({ entry }: { readonly entry: DownloadEntry }): React.ReactElement => {
  const action = useDownloadAction(
    (downloads, input: "pause" | "resume" | "keep" | "release" | "remove") =>
      input === "pause"
        ? downloads.pause(entry.id)
        : input === "resume"
          ? downloads.resume(entry.id)
          : input === "remove"
            ? downloads.remove(entry.id)
            : downloads.keep(entry.id, input === "keep"),
  );
  return (
    <>
      {entry.status === "completed" ? null : entry.status === "paused" ||
        entry.status === "failed" ? (
        <DropdownItem icon={<RotateCw size={15} />} onClick={() => action.mutate("resume")}>
          {entry.status === "failed" ? "Retry download" : "Resume download"}
        </DropdownItem>
      ) : (
        <DropdownItem icon={<Pause size={15} />} onClick={() => action.mutate("pause")}>
          Pause download
        </DropdownItem>
      )}
      <DropdownItem
        icon={entry.keep ? <PinOff size={15} /> : <Pin size={15} />}
        onClick={() => action.mutate(entry.keep ? "release" : "keep")}
      >
        {entry.keep ? "Allow automatic cleanup" : "Keep, never clean up"}
      </DropdownItem>
      <DropdownSeparator />
      <DropdownItem
        tone="danger"
        icon={<Trash2 size={15} />}
        onClick={() => action.mutate("remove")}
      >
        Remove download
      </DropdownItem>
    </>
  );
};

/** Downloads a movie or episode, and shows how far it has got. */
export const DownloadButton = ({
  item,
}: {
  readonly item: CatalogItem;
}): React.ReactElement | null => {
  const entry = useDownloadEntry(item.id);
  const canDownload = useCanDownload();
  const add = useDownloadAction((downloads, itemIds: ReadonlyArray<string>) =>
    downloads.add(itemIds),
  );
  if (entry === null && !canDownload) return null;
  if (entry === null)
    return (
      <div className="download-control">
        <Button
          variant="secondary"
          size="lg"
          disabled={add.isPending}
          aria-busy={add.isPending}
          onClick={() => add.mutate([item.id])}
        >
          {add.isPending ? (
            <LoaderCircle aria-hidden="true" size={16} className="spinner" />
          ) : (
            <ArrowDownToLine aria-hidden="true" size={16} />
          )}
          {add.isPending ? "Preparing…" : "Download"}
        </Button>
        <ActionError error={add.error} />
      </div>
    );
  const Icon =
    entry.status === "completed"
      ? CircleCheck
      : entry.status === "failed"
        ? CircleAlert
        : entry.status === "downloading"
          ? LoaderCircle
          : ArrowDownToLine;
  return (
    <DropdownMenu
      align="start"
      trigger={
        <Button
          variant="secondary"
          size="lg"
          className={`download-button is-${entry.status}`}
          aria-label={`${downloadStatusText(entry)}. Download options`}
        >
          <Icon
            aria-hidden="true"
            size={16}
            className={entry.status === "downloading" ? "spinner" : undefined}
          />
          {downloadStatusText(entry)}
        </Button>
      }
    >
      <EntryActions entry={entry} />
    </DropdownMenu>
  );
};

/** Downloads every episode listed that is not downloaded yet. */
export const DownloadAllButton = ({
  items,
  label,
}: {
  readonly items: ReadonlyArray<CatalogItem>;
  readonly label: string;
}): React.ReactElement | null => {
  const entries = useAccountDownloads();
  const canDownload = useCanDownload();
  const add = useDownloadAction((downloads, itemIds: ReadonlyArray<string>) =>
    downloads.add(itemIds),
  );
  if (entries === null || items.length === 0 || !canDownload) return null;
  const missing = items.filter((item) => !entries.some((entry) => entry.itemId === item.id));
  return (
    <div className="download-control">
      <Button
        variant="secondary"
        size="lg"
        disabled={missing.length === 0 || add.isPending}
        aria-busy={add.isPending}
        onClick={() => add.mutate(missing.map((item) => item.id))}
      >
        {missing.length === 0 ? (
          <CircleCheck aria-hidden="true" size={16} />
        ) : add.isPending ? (
          <LoaderCircle aria-hidden="true" size={16} className="spinner" />
        ) : (
          <ArrowDownToLine aria-hidden="true" size={16} />
        )}
        {missing.length === 0 ? "All downloaded" : add.isPending ? "Preparing…" : label}
      </Button>
      <ActionError error={add.error} />
    </div>
  );
};

const showRuleOptions = [null, 1, 3, 5] as const;
const showRuleLabel = (episodes: number | null): string =>
  episodes === null ? "Off" : episodes === 1 ? "Next episode" : `Next ${episodes} episodes`;

/** Keeps a show's next unwatched episodes downloaded, fetching each next one as they are watched. */
export const ShowDownloadRuleMenu = ({
  show,
}: {
  readonly show: { readonly id: string; readonly title: string };
}): React.ReactElement | null => {
  const { account } = useWorkspace();
  const state = useDownloadState();
  const set = useDownloadAction((downloads, episodes: number | null) =>
    downloads.showRule(show, episodes),
  );
  if (state.data?.available !== true) return null;
  const current =
    state.data.shows.find(
      (rule) => rule.connectionId === account.connectionId && rule.showId === show.id,
    )?.episodes ?? null;
  return (
    <div className="download-control">
      <DropdownMenu
        align="start"
        trigger={
          <Button variant="secondary" size="lg" aria-busy={set.isPending}>
            <ArrowDownToLine aria-hidden="true" size={16} />
            {current === null ? "Auto-download" : `Auto-download: ${showRuleLabel(current)}`}
          </Button>
        }
      >
        {showRuleOptions.map((episodes) => (
          <DropdownItem
            key={String(episodes)}
            trailing={current === episodes ? <CircleCheck size={14} /> : undefined}
            onClick={() => set.mutate(episodes)}
          >
            {showRuleLabel(episodes)}
          </DropdownItem>
        ))}
      </DropdownMenu>
      <ActionError error={set.error} />
    </div>
  );
};

/** A small mark on a card for an item kept on this device. */
export const DownloadBadge = ({
  itemId,
}: {
  readonly itemId: string;
}): React.ReactElement | null => {
  const entry = useDownloadEntry(itemId);
  if (entry === null) return null;
  const label = downloadStatusText(entry);
  return (
    <span
      className={`download-badge is-${entry.status}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <Download aria-hidden="true" size={12} strokeWidth={2.5} />
    </span>
  );
};

const StorageMeter = ({ usage }: { readonly usage: StorageUsage }): React.ReactElement => {
  const share = (bytes: number) =>
    usage.totalBytes > 0 ? `${Math.min(100, (bytes / usage.totalBytes) * 100)}%` : "0%";
  const others = Math.max(
    0,
    usage.totalBytes - usage.freeBytes - usage.downloadBytes - usage.cacheBytes,
  );
  return (
    <section className="storage-meter" aria-label="Storage">
      <div className="storage-meter-bar" aria-hidden="true">
        <span className="is-other" style={{ width: share(others) }} />
        <span className="is-downloads" style={{ width: share(usage.downloadBytes) }} />
        <span className="is-cache" style={{ width: share(usage.cacheBytes) }} />
        <span className="storage-meter-limit" style={{ right: share(usage.minimumFreeBytes) }} />
      </div>
      <dl className="storage-meter-legend">
        <div>
          <dt>
            <span className="storage-swatch is-downloads" />
            Downloads
          </dt>
          <dd>{formatBytes(usage.downloadBytes)}</dd>
        </div>
        <div>
          <dt>
            <span className="storage-swatch is-cache" />
            Streaming cache
          </dt>
          <dd>{formatBytes(usage.cacheBytes)}</dd>
        </div>
        <div>
          <dt>
            <span className="storage-swatch is-free" />
            Free
          </dt>
          <dd>{formatBytes(usage.freeBytes)}</dd>
        </div>
      </dl>
      <p className="storage-meter-note">
        Downloads pause when free space falls below {formatBytes(usage.minimumFreeBytes)}.
      </p>
    </section>
  );
};

const DownloadArtwork = ({ entry }: { readonly entry: DownloadEntry }): React.ReactElement => {
  const runtime = useRuntime();
  const artwork = useQuery({
    queryKey: [...DOWNLOADS_KEY, "artwork", entry.id],
    queryFn: () => runtime.downloads?.artwork(entry.id) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [failed, setFailed] = useState(false);
  const url = artwork.data;
  return (
    <span className={`download-art${entry.item.kind === "episode" ? " is-landscape" : ""}`}>
      {url == null || failed ? (
        <PosterFallback title={entry.item.title} kind={entry.item.kind} />
      ) : (
        <img src={url} alt="" draggable={false} onError={() => setFailed(true)} />
      )}
    </span>
  );
};

const DownloadRow = ({ entry }: { readonly entry: DownloadEntry }): React.ReactElement => {
  const { playItem } = useWorkspace();
  const placement = entry.item.placement;
  const code =
    entry.item.kind === "episode" ? episodeCode(placement?.seasonNumber, entry.item) : null;
  const details = [
    downloadStatusText(entry),
    entry.status === "completed" || entry.downloadedBytes === 0
      ? formatBytes(entry.sizeBytes)
      : `${formatBytes(entry.downloadedBytes)} of ${formatBytes(entry.sizeBytes)}`,
    entry.watchedAtMs === null ? null : "Watched",
    entry.keep ? "Kept" : null,
    entry.autoShowId === null ? null : "Auto-downloaded",
  ].filter((part): part is string => part !== null);
  return (
    <li className={`download-row is-${entry.status}`} aria-label={entry.item.title}>
      <DownloadArtwork entry={entry} />
      <div className="download-row-text">
        <span className="download-row-title">
          {code === null ? null : <span className="download-row-code">{code}</span>}
          {entry.item.title}
        </span>
        <span className="download-row-status">{details.join(" · ")}</span>
        {entry.status === "completed" ? null : (
          <span
            className="download-row-progress"
            role="progressbar"
            aria-label={`${entry.item.title} download progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentOf(entry)}
          >
            <span style={{ width: `${percentOf(entry)}%` }} />
          </span>
        )}
      </div>
      <div className="download-row-actions">
        <Button
          variant="icon"
          aria-label={`Play ${entry.item.title}`}
          title="Play"
          onClick={() => playItem(entry.item)}
        >
          <Play aria-hidden="true" size={16} fill="currentColor" strokeWidth={0} />
        </Button>
        <DropdownMenu
          trigger={
            <Button variant="icon" aria-label={`Options for ${entry.item.title}`} title="Options">
              <span aria-hidden="true" className="download-row-more">
                •••
              </span>
            </Button>
          }
        >
          <EntryActions entry={entry} />
        </DropdownMenu>
      </div>
    </li>
  );
};

/** Downloads grouped the way the library is: movies apart, episodes under their show. */
const groupDownloads = (
  entries: ReadonlyArray<DownloadEntry>,
): ReadonlyArray<{
  readonly key: string;
  readonly title: string;
  readonly entries: DownloadEntry[];
}> => {
  const groups = new Map<string, { key: string; title: string; entries: DownloadEntry[] }>();
  for (const entry of entries) {
    const show = entry.item.placement?.show;
    const key = show?.id ?? (entry.item.kind === "episode" ? "episodes" : "movies");
    const title = show?.title ?? (entry.item.kind === "episode" ? "Episodes" : "Movies");
    const group = groups.get(key) ?? { key, title, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const ordered = [...groups.values()];
  for (const group of ordered)
    group.entries.sort(
      (a, b) =>
        (a.item.placement?.seasonNumber ?? 0) - (b.item.placement?.seasonNumber ?? 0) ||
        (a.item.indexNumber ?? 0) - (b.item.indexNumber ?? 0) ||
        a.createdAtMs - b.createdAtMs,
    );
  return ordered.sort((a, b) =>
    a.key === "movies" ? -1 : b.key === "movies" ? 1 : a.title.localeCompare(b.title),
  );
};

export const DownloadsPage = (): React.ReactElement => {
  const runtime = useRuntime();
  const state = useDownloadState();
  const entries = useAccountDownloads() ?? [];
  const removeAll = useDownloadAction((downloads, watchedOnly: boolean) =>
    downloads.removeAll(watchedOnly),
  );
  if (runtime.downloads === null)
    return (
      <div className="page">
        <PageHeader title="Downloads" />
        <EmptyState
          icon={Download}
          title="Downloads need the desktop app"
          message="Use Lumen Desktop to keep movies and episodes for later."
        />
      </div>
    );
  const watched = entries.filter((entry) => entry.watchedAtMs !== null).length;
  const total = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return (
    <div className="page downloads-page">
      <PageHeader
        title="Downloads"
        subtitle={
          entries.length === 0
            ? "Keep movies and episodes on this device to watch later."
            : `${plural(entries.length, "item")} · ${formatBytes(total)}`
        }
        actions={
          entries.length === 0 ? undefined : (
            <DropdownMenu
              trigger={
                <Button variant="secondary" aria-busy={removeAll.isPending}>
                  <Trash2 aria-hidden="true" size={15} />
                  Clean up
                </Button>
              }
            >
              <DropdownItem disabled={watched === 0} onClick={() => removeAll.mutate(true)}>
                Delete watched ({watched})
              </DropdownItem>
              <DropdownItem tone="danger" onClick={() => removeAll.mutate(false)}>
                Delete all downloads
              </DropdownItem>
            </DropdownMenu>
          )
        }
      />
      <ActionError error={removeAll.error} />
      {state.data == null ? null : <StorageMeter usage={state.data.usage} />}
      {entries.length === 0 ? (
        <EmptyState
          icon={Download}
          title="Nothing downloaded yet"
          message="Download a movie or an episode from its page. Downloads play even without a connection to the server."
        />
      ) : (
        groupDownloads(entries).map((group) => (
          <section className="download-group" key={group.key} aria-label={group.title}>
            <h2>{group.title}</h2>
            <ul className="download-list">
              {group.entries.map((entry) => (
                <DownloadRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
};

const cacheOptions: ReadonlyArray<{ readonly value: StreamingCacheSize; readonly label: string }> =
  [
    { value: "none", label: "None" },
    { value: "low", label: "Low (0.5 GB)" },
    { value: "medium", label: "Medium (1.5 GB)" },
    { value: "high", label: "High (5 GB)" },
  ];

const watchedOptions: ReadonlyArray<{
  readonly value: DeleteWatchedAfter;
  readonly label: string;
}> = [
  { value: "immediately", label: "Right after watching" },
  { value: "1d", label: "1 day after watching" },
  { value: "7d", label: "7 days after watching" },
  { value: "never", label: "Never" },
];

const unopenedOptions: ReadonlyArray<{
  readonly value: RemoveUnopenedAfter;
  readonly label: string;
}> = [
  { value: "30d", label: "30 days" },
  { value: "60d", label: "60 days" },
  { value: "90d", label: "90 days" },
  { value: "never", label: "Never" },
];

const Row = ({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}): React.ReactElement => (
  <div className="settings-row">
    <div className="settings-row-text">
      <span>{label}</span>
      {description === undefined ? null : <p>{description}</p>}
    </div>
    <div className="settings-row-value">{children}</div>
  </div>
);

/** The free space at which downloads pause, as a share of the disk. */
const FreeSpaceLimit = ({
  value,
  totalBytes,
  disabled,
  onCommit,
}: {
  readonly value: number;
  readonly totalBytes: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}): React.ReactElement => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft);
  const valid =
    Number.isInteger(parsed) &&
    parsed >= MIN_FREE_SPACE_PERCENT &&
    parsed <= MAX_FREE_SPACE_PERCENT;
  const commit = (next: number) => {
    if (next !== value) onCommit(next);
  };
  return (
    <div className="free-space-limit">
      <input
        type="range"
        aria-label="Free space limit"
        min={MIN_FREE_SPACE_PERCENT}
        max={MAX_FREE_SPACE_PERCENT}
        step={1}
        value={valid ? parsed : value}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => commit(Number(event.currentTarget.value))}
      />
      <input
        className="free-space-number"
        type="number"
        aria-label="Free space limit percent"
        min={MIN_FREE_SPACE_PERCENT}
        max={MAX_FREE_SPACE_PERCENT}
        step={1}
        value={draft}
        disabled={disabled}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => (valid ? commit(parsed) : setDraft(String(value)))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && valid) commit(parsed);
        }}
      />
      <span aria-hidden="true">%</span>
      {totalBytes > 0 && valid ? (
        <span className="free-space-hint">
          {parsed}% of {formatBytes(totalBytes)}: downloads pause at{" "}
          {formatBytes(Math.ceil((totalBytes * parsed) / 100))} free
        </span>
      ) : null}
    </div>
  );
};

/** Download and cache settings, which belong to this device rather than the server. */
export const DownloadSettingsSection = (): React.ReactElement | null => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const state = useDownloadState();
  const update = useMutation({
    mutationFn: (patch: DownloadSettingsPatch) => {
      if (runtime.downloads === null) throw new Error("Downloads are unavailable here");
      return runtime.downloads.updateSettings(patch);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY }),
  });
  const clear = useDownloadAction((downloads, _input: undefined) => downloads.clearCache());
  if (runtime.downloads === null || state.data == null) return null;
  const { settings, usage } = state.data;
  return (
    <section className="settings-group" aria-labelledby="settings-downloads">
      <h2 id="settings-downloads">Downloads and storage</h2>
      <div className="settings-card">
        <Row
          label="Streaming cache"
          description="Keeps recently streamed video on this device so going back or rewatching doesn’t download it again. Downloads aren’t affected."
        >
          {usage.cacheBytes > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => clear.mutate(undefined)}>
              Clear {formatBytes(usage.cacheBytes)}
            </Button>
          ) : null}
          <SelectField
            label="Streaming cache"
            hideLabel
            value={settings.streamingCache}
            disabled={update.isPending}
            options={cacheOptions}
            onValueChange={(streamingCache) => update.mutate({ streamingCache })}
          />
        </Row>
        <Row
          label="Stop downloading when free space falls below"
          description="Downloads pause until space frees up. Playback never stops for it."
        >
          <FreeSpaceLimit
            value={settings.minimumFreeSpacePercent}
            totalBytes={usage.totalBytes}
            disabled={update.isPending}
            onCommit={(minimumFreeSpacePercent) => update.mutate({ minimumFreeSpacePercent })}
          />
        </Row>
        <Row
          label="Delete watched downloads"
          description="Downloads you keep are never deleted automatically."
        >
          <SelectField
            label="Delete watched downloads"
            hideLabel
            value={settings.deleteWatchedAfter}
            disabled={update.isPending}
            options={watchedOptions}
            onValueChange={(deleteWatchedAfter) => update.mutate({ deleteWatchedAfter })}
          />
        </Row>
        <Row label="Remove downloads not opened in">
          <SelectField
            label="Remove downloads not opened in"
            hideLabel
            value={settings.removeUnopenedAfter}
            disabled={update.isPending}
            options={unopenedOptions}
            onValueChange={(removeUnopenedAfter) => update.mutate({ removeUnopenedAfter })}
          />
        </Row>
        {update.isError || clear.isError ? (
          <p className="form-error" role="alert">
            <CircleAlert aria-hidden="true" size={15} />
            <span>
              {errorMessage(update.error ?? clear.error, "Could not save download settings")}
            </span>
          </p>
        ) : null}
      </div>
    </section>
  );
};
