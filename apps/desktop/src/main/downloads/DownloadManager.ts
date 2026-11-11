import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expiredDownloads,
  type FetchLike,
  nextRetentionAtMs,
  ServerHttpError,
} from "@lumen/client";
import {
  CatalogItem,
  catalogItemOf,
  DownloadSettings,
  type DownloadSettingsPatch,
  type DownloadState,
  DownloadStatus,
  DownloadTicket,
  defaultDownloadSettings,
  isWatchCompleted,
  type PlayerSession,
  type PlayerState,
  posterOf,
  ShowDownloadRule,
  streamingCacheBytes,
} from "@lumen/contracts";
import { Schema } from "effect";
import type { ServerClient } from "../api/ServerClient";
import { ignoreFailure, reportFailure } from "../failures";
import { SpaceExhausted } from "../media-store/ByteStore";
import { MediaChanged, type MediaSpec } from "../media-store/MediaFile";
import type { MediaStore } from "../media-store/MediaStore";
import type { PlaybackClient } from "../player/PlaybackClient";
import { JsonFileStore } from "../storage/JsonFileStore";

const { grantToken: _grantToken, ...ticketFields } = DownloadTicket.fields;
/** A ticket as it is kept: its grant lives in the encrypted vault, not beside it. */
const StoredTicket = Schema.Struct(ticketFields);
type StoredTicket = Schema.Schema.Type<typeof StoredTicket>;

const StoredDownload = Schema.Struct({
  id: Schema.String,
  connectionId: Schema.String,
  serverId: Schema.String,
  itemId: Schema.String,
  item: CatalogItem,
  /** The copy that plays. */
  ticket: StoredTicket,
  /** A newer revision being fetched to replace a finished copy, which plays until it is ready. */
  next: Schema.NullOr(StoredTicket),
  status: DownloadStatus,
  pausedByUser: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  keep: Schema.Boolean,
  autoShowId: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
  completedAtMs: Schema.NullOr(Schema.Number),
  watchedAtMs: Schema.NullOr(Schema.Number),
  lastOpenedAtMs: Schema.NullOr(Schema.Number),
  hasArtwork: Schema.Boolean,
});
type StoredDownload = Schema.Schema.Type<typeof StoredDownload>;
type Download = { -readonly [K in keyof StoredDownload]: StoredDownload[K] };

/** Watch progress made offline, saved to the server once it can be reached. */
const OfflineProgress = Schema.Struct({
  connectionId: Schema.String,
  itemId: Schema.String,
  positionSeconds: Schema.Number,
  completed: Schema.Boolean,
  observedAtMs: Schema.Number,
});

const StoredState = Schema.Struct({
  downloads: Schema.Array(StoredDownload),
  settings: DownloadSettings,
  shows: Schema.Array(ShowDownloadRule),
  outbox: Schema.Array(OfflineProgress),
});
type StoredState = Schema.Schema.Type<typeof StoredState>;

const SYNC_INTERVAL_MS = 6 * 3_600_000;
const RETENTION_INTERVAL_MS = 3_600_000;
const SPACE_CHECK_MS = 30_000;
/** How soon cleanup looks again at a download it left alone because it was playing. */
const PLAYING_RECHECK_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
/** Grants are renewed this long before they lapse. */
const TICKET_MARGIN_MS = 24 * 3_600_000;

export interface Account {
  readonly connectionId: string;
  readonly serverId: string;
  readonly origin: string;
}

export interface DownloadManagerOptions {
  readonly directory: string;
  readonly store: MediaStore;
  /** The signed-in client for a connection, or null while its server cannot be reached. */
  readonly clientFor: (connectionId: string) => ServerClient | null;
  readonly artworkTransport: (connectionId: string) => FetchLike;
  /** What the player is playing now, if anything. */
  readonly nowPlaying: () => { readonly connectionId: string; readonly itemId: string } | null;
  /** Keeps encrypted grant tokens. */
  readonly vault: {
    readonly read: () => Promise<string | null>;
    readonly write: (value: string) => Promise<void>;
  };
  readonly clock?: () => number;
}

const describeFailure = (cause: unknown): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : "The download failed";

const isTransient = (cause: unknown): boolean =>
  !(cause instanceof ServerHttpError) || cause.status === 429 || cause.status >= 500;

const specOf = (serverId: string, ticket: StoredTicket): MediaSpec => ({
  serverId,
  sourceId: ticket.sourceId,
  revision: ticket.revision,
  sizeBytes: ticket.sizeBytes,
  mimeType: ticket.mimeType,
});

const storedTicket = (ticket: DownloadTicket): StoredTicket => {
  const { grantToken: _token, ...stored } = ticket;
  return stored;
};

/**
 * Everything the viewer chose to keep for later. Downloads run one at a time, the one being
 * watched first; each pins its file in the media store so the bytes stay until the viewer or
 * their cleanup rules remove it. While a server can be reached its downloads are checked in, so
 * revoked or changed files are found, and progress made offline is handed back.
 */
export class DownloadManager extends EventEmitter {
  private downloads: Download[] = [];
  private tokens = new Map<string, string>();
  private running: {
    readonly id: string;
    readonly controller: AbortController;
    readonly done: Promise<void>;
  } | null = null;
  private pumping: Promise<void> = Promise.resolve();
  private pumpQueued = false;
  private retryAt = new Map<string, { readonly atMs: number; readonly attempts: number }>();
  private spaceWaiting = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retentionTimer: ReturnType<typeof setTimeout> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = new Map<string, Promise<void>>();
  /**
   * Items watched to the end here since the app started, by connection. The server may not have
   * heard yet, and cleanup may already have deleted their downloads.
   */
  private watchedHere = new Set<string>();
  private closed = false;
  private readonly clock: () => number;

  private constructor(
    private readonly options: DownloadManagerOptions,
    private readonly stored: JsonFileStore<StoredState>,
  ) {
    super();
    this.clock = options.clock ?? Date.now;
  }

  static async open(options: DownloadManagerOptions): Promise<DownloadManager> {
    await mkdir(join(options.directory, "artwork"), { recursive: true });
    const stored = await JsonFileStore.open({
      path: join(options.directory, "downloads.json"),
      schema: StoredState,
      defaults: (): StoredState => ({
        downloads: [],
        settings: defaultDownloadSettings,
        shows: [],
        outbox: [],
      }),
      name: "downloads",
    });
    const manager = new DownloadManager(options, stored);
    manager.downloads = stored.current.downloads.map((download) => ({ ...download }));
    try {
      const tokens = JSON.parse((await options.vault.read()) ?? "{}") as Record<string, unknown>;
      for (const [downloadId, token] of Object.entries(tokens))
        if (typeof token === "string") manager.tokens.set(downloadId, token);
    } catch {
      // Without saved grants, each download asks the server for a new one before it fetches.
    }
    manager.applySettings();
    for (const download of manager.downloads) {
      // Nothing was running when the app last closed.
      if (download.status === "downloading") download.status = "queued";
      await options.store.pin(specOf(download.serverId, download.ticket));
      if (download.next !== null) await options.store.pin(specOf(download.serverId, download.next));
    }
    // What no download holds is streaming cache, trimmed to its budget.
    await options.store.enforceCache();
    options.store.onSpaceFreed = () => manager.spaceFreed();
    // Servers that can be reached are checked in with regularly, not only on connecting.
    manager.timers.push(setInterval(() => manager.syncReachable(), SYNC_INTERVAL_MS));
    for (const timer of manager.timers) timer.unref?.();
    await manager.applyRetention();
    manager.schedule();
    return manager;
  }

  /** Whether a download is fetching right now. */
  get isDownloading(): boolean {
    return this.running !== null;
  }

  get settings(): DownloadSettings {
    return this.stored.current.settings;
  }

  private save(): void {
    this.stored.set({
      ...this.stored.current,
      downloads: this.downloads.map((entry) => ({ ...entry })),
    });
    this.scheduleRetention();
  }

  private syncReachable(): void {
    for (const connectionId of new Set(this.downloads.map((entry) => entry.connectionId)))
      if (this.options.clientFor(connectionId) !== null) void this.connectionReady(connectionId);
  }

  private retained() {
    return this.downloads.map((download) => ({
      id: download.id,
      keep: download.keep,
      inUse: this.inUse(download),
      createdAtMs: download.createdAtMs,
      completedAtMs: download.completedAtMs,
      watchedAtMs: download.watchedAtMs,
      lastOpenedAtMs: download.lastOpenedAtMs,
    }));
  }

  /**
   * Runs the cleanup rules when the next download falls due. Waits are capped, so a long one
   * is looked at again, and a clock changed meanwhile is caught up with.
   */
  private scheduleRetention(): void {
    if (this.closed) return;
    const now = this.clock();
    const due = nextRetentionAtMs(this.retained(), this.settings, now, PLAYING_RECHECK_MS);
    if (this.retentionTimer !== null) clearTimeout(this.retentionTimer);
    this.retentionTimer = null;
    if (due === null) return;
    this.retentionTimer = setTimeout(
      () => {
        this.retentionTimer = null;
        void this.applyRetention();
      },
      Math.min(RETENTION_INTERVAL_MS, Math.max(0, due - now)),
    );
    this.retentionTimer.unref?.();
  }

  private async saveTokens(): Promise<void> {
    await this.options.vault.write(JSON.stringify(Object.fromEntries(this.tokens)));
  }

  /** Tells the renderer something changed; bursts of progress are folded into one message. */
  private publish(immediately = false): void {
    if (this.closed) return;
    if (immediately) {
      if (this.publishTimer !== null) clearTimeout(this.publishTimer);
      this.publishTimer = null;
      this.emit("change");
      return;
    }
    if (this.publishTimer !== null) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.emit("change");
    }, 250);
  }

  async state(activeConnectionId: string | null): Promise<DownloadState> {
    const { store } = this.options;
    return {
      available:
        activeConnectionId !== null &&
        this.options.clientFor(activeConnectionId)?.supportsDownloads === true,
      entries: this.downloads.map((download) => {
        const target = download.next ?? download.ticket;
        const file = store.find(specOf(download.serverId, target));
        return {
          id: download.id,
          connectionId: download.connectionId,
          itemId: download.itemId,
          item: download.item,
          status: download.status,
          reason: download.reason,
          downloadedBytes:
            download.next === null && download.status === "completed"
              ? download.ticket.sizeBytes
              : (file?.disk.heldBytes ?? 0),
          sizeBytes: target.sizeBytes,
          keep: download.keep,
          autoShowId: download.autoShowId,
          createdAtMs: download.createdAtMs,
          completedAtMs: download.completedAtMs,
          watchedAtMs: download.watchedAtMs,
        };
      }),
      usage: await store.usage(),
      settings: this.settings,
      shows: this.stored.current.shows,
    };
  }

  async artwork(id: string): Promise<string | null> {
    const download = this.downloads.find((entry) => entry.id === id);
    if (download?.hasArtwork !== true) return null;
    return readFile(this.artworkPath(id), "utf8").catch(() => null);
  }

  private artworkPath(id: string): string {
    return join(this.options.directory, "artwork", `${id}.txt`);
  }

  private find(connectionId: string, itemId: string): Download | undefined {
    return this.downloads.find(
      (entry) => entry.connectionId === connectionId && entry.itemId === itemId,
    );
  }

  private requireClient(connectionId: string): ServerClient {
    const client = this.options.clientFor(connectionId);
    if (client === null) throw new Error("Connect to the server to download");
    if (!client.supportsDownloads) throw new Error("This server does not support downloads");
    return client;
  }

  /** Starts keeping an item, or resumes keeping it if it is already on the list. */
  async add(account: Account, itemId: string, autoShowId: string | null = null): Promise<void> {
    const existing = this.find(account.connectionId, itemId);
    if (existing !== undefined) {
      // Asking by hand for an episode a show rule fetched makes it the viewer's own.
      if (autoShowId === null) existing.autoShowId = null;
      if (existing.pausedByUser || existing.status === "failed") this.resume(existing.id);
      this.save();
      this.publish(true);
      return;
    }
    const client = this.requireClient(account.connectionId);
    const item = catalogItemOf(await client.itemDetails(itemId));
    const ticket = await client.createDownload(itemId);
    this.tokens.set(ticket.downloadId, ticket.grantToken);
    await this.saveTokens();
    const download: Download = {
      id: crypto.randomUUID(),
      connectionId: account.connectionId,
      serverId: account.serverId,
      itemId,
      item,
      ticket: storedTicket(ticket),
      next: null,
      status: "queued",
      pausedByUser: false,
      reason: null,
      keep: false,
      autoShowId,
      createdAtMs: this.clock(),
      completedAtMs: null,
      watchedAtMs: item.completed === true ? this.clock() : null,
      lastOpenedAtMs: null,
      hasArtwork: false,
    };
    await this.options.store.pin(specOf(download.serverId, download.ticket));
    if (this.find(account.connectionId, itemId) !== undefined) {
      // Another request added it while this one waited on the server.
      await this.options.store.discard(specOf(download.serverId, download.ticket));
      return;
    }
    this.downloads.push(download);
    this.save();
    this.publish(true);
    this.schedule();
    await this.saveArtwork(download, client).catch(ignoreFailure);
  }

  private async saveArtwork(download: Download, client: ServerClient): Promise<void> {
    const poster = posterOf(download.item);
    if (poster === null) return;
    const url = await client.artworkDataUrl(
      poster,
      this.options.artworkTransport(download.connectionId),
    );
    if (url === null || !this.downloads.includes(download)) return;
    await writeFile(this.artworkPath(download.id), url);
    download.hasArtwork = true;
    this.save();
    this.publish();
  }

  /** Stops keeping an item and gives its space back. */
  async remove(id: string, options: { readonly tellServer?: boolean } = {}): Promise<void> {
    const download = this.downloads.find((entry) => entry.id === id);
    if (download === undefined) return;
    this.downloads = this.downloads.filter((entry) => entry !== download);
    this.retryAt.delete(id);
    this.save();
    if (this.running?.id === id) {
      this.running.controller.abort();
      await this.running.done;
    }
    for (const ticket of [download.ticket, download.next]) {
      if (ticket === null) continue;
      await this.options.store.discard(specOf(download.serverId, ticket));
      if (options.tellServer !== false)
        void this.options
          .clientFor(download.connectionId)
          ?.deleteDownload(ticket.downloadId)
          .catch(ignoreFailure);
      this.tokens.delete(ticket.downloadId);
    }
    await this.saveTokens().catch(ignoreFailure);
    await rm(this.artworkPath(id), { force: true });
    this.publish(true);
    this.schedule();
  }

  async removeMany(predicate: (download: StoredDownload) => boolean): Promise<void> {
    for (const download of this.downloads.filter(predicate)) await this.remove(download.id);
  }

  /** Removes everything kept for an account, such as when it signs out of this device. */
  async removeConnection(connectionId: string): Promise<void> {
    await this.removeMany((download) => download.connectionId === connectionId);
    this.stored.set({
      ...this.stored.current,
      shows: this.stored.current.shows.filter((rule) => rule.connectionId !== connectionId),
      outbox: this.stored.current.outbox.filter((entry) => entry.connectionId !== connectionId),
    });
  }

  pause(id: string): void {
    const download = this.downloads.find((entry) => entry.id === id);
    if (download === undefined || download.status === "completed") return;
    download.pausedByUser = true;
    download.status = "paused";
    download.reason = null;
    if (this.running?.id === id) this.running.controller.abort();
    this.save();
    this.publish(true);
  }

  resume(id: string): void {
    const download = this.downloads.find((entry) => entry.id === id);
    if (download === undefined) return;
    download.pausedByUser = false;
    if (download.status !== "completed") {
      download.status = "queued";
      download.reason = null;
    }
    this.retryAt.delete(id);
    this.save();
    this.publish(true);
    this.schedule();
  }

  setKeep(id: string, keep: boolean): void {
    const download = this.downloads.find((entry) => entry.id === id);
    if (download === undefined) return;
    download.keep = keep;
    this.save();
    this.publish(true);
  }

  async clearCache(): Promise<void> {
    await this.options.store.clearCache();
    this.publish(true);
  }

  private applySettings(): void {
    const { store } = this.options;
    store.cacheBudgetBytes = streamingCacheBytes[this.settings.streamingCache];
    store.minimumFreePercent = this.settings.minimumFreeSpacePercent;
  }

  async updateSettings(patch: DownloadSettingsPatch): Promise<DownloadSettings> {
    const settings = Schema.decodeUnknownSync(DownloadSettings)({ ...this.settings, ...patch });
    this.stored.set({ ...this.stored.current, settings });
    this.applySettings();
    await this.options.store.enforceCache();
    this.spaceFreed();
    await this.applyRetention();
    this.publish(true);
    return settings;
  }

  /** Keeps the next unwatched episodes of a show downloaded, or stops when `episodes` is null. */
  async setShowRule(
    account: Account,
    show: { readonly id: string; readonly title: string },
    episodes: number | null,
  ): Promise<void> {
    const others = this.stored.current.shows.filter(
      (rule) => !(rule.connectionId === account.connectionId && rule.showId === show.id),
    );
    const shows =
      episodes === null
        ? others
        : [
            ...others,
            Schema.decodeUnknownSync(ShowDownloadRule)({
              connectionId: account.connectionId,
              showId: show.id,
              title: show.title,
              episodes,
            }),
          ];
    this.stored.set({ ...this.stored.current, shows });
    this.publish(true);
    await this.reconcileShows(account);
  }

  /** Downloads the episodes a show rule asks for, and drops ones it no longer does. */
  private async reconcileShows(account: Account): Promise<void> {
    const client = this.options.clientFor(account.connectionId);
    if (client === null || !client.supportsDownloads) return;
    const rules = this.stored.current.shows.filter(
      (rule) => rule.connectionId === account.connectionId,
    );
    for (const rule of rules) {
      const wanted: string[] = [];
      const seen = new Set<string>();
      let episode = await client.nextUp(rule.showId).catch(() => null);
      while (episode !== null && wanted.length < rule.episodes && !seen.has(episode.id)) {
        seen.add(episode.id);
        // An episode just watched here may not have reached the server yet.
        const watchedHere = this.watchedHere.has(`${account.connectionId}/${episode.id}`);
        if (episode.completed !== true && !watchedHere) wanted.push(episode.id);
        const neighbours = await client.adjacentEpisodes(episode.id).catch(() => null);
        episode = neighbours?.next ?? null;
      }
      for (const itemId of wanted)
        if (this.find(account.connectionId, itemId) === undefined)
          await this.add(account, itemId, rule.showId).catch(
            reportFailure("Failed to download an episode for a show"),
          );
      await this.removeMany(
        (download) =>
          download.connectionId === account.connectionId &&
          download.autoShowId === rule.showId &&
          download.watchedAtMs === null &&
          !wanted.includes(download.itemId) &&
          !this.inUse(download),
      );
    }
    // Episodes a rule fetched outlive the rule only until they are watched; drop the rest.
    await this.removeMany(
      (download) =>
        download.connectionId === account.connectionId &&
        download.autoShowId !== null &&
        !rules.some((rule) => rule.showId === download.autoShowId) &&
        !this.inUse(download),
    );
  }

  private inUse(download: StoredDownload): boolean {
    const playing = this.options.nowPlaying();
    return playing?.connectionId === download.connectionId && playing.itemId === download.itemId;
  }

  /** Deletes what the viewer's cleanup rules say has had its time. */
  async applyRetention(): Promise<void> {
    const expired = expiredDownloads(this.retained(), this.settings, this.clock());
    for (const id of expired) await this.remove(id);
    this.scheduleRetention();
  }

  /** What the player reports as it plays: when the item was last opened, and when it was watched. */
  observePlayback(connectionId: string, state: PlayerState): void {
    const download = this.find(connectionId, state.itemId);
    if (download === undefined) return;
    const now = this.clock();
    const previous = download.lastOpenedAtMs;
    download.lastOpenedAtMs = now;
    const watched = isWatchCompleted(
      Math.round(state.positionSeconds * 1000),
      state.durationSeconds === null ? null : Math.round(state.durationSeconds * 1000),
    );
    if (watched) this.watchedHere.add(`${connectionId}/${state.itemId}`);
    if (watched && download.watchedAtMs === null) {
      download.watchedAtMs = now;
      this.save();
      this.publish(true);
      // The show's next episode is fetched now that this one is done.
      const account = this.accountOf(download);
      if (download.item.placement !== undefined && account !== null)
        void this.reconcileShows(account);
    } else if (previous === null || now - previous > 60_000) this.save();
    // The viewer is watching it: it comes first, and may finish it.
    if (this.running?.id !== download.id && download.status !== "completed") this.schedule();
  }

  private accountOf(download: StoredDownload): Account | null {
    const client = this.options.clientFor(download.connectionId);
    return client === null
      ? null
      : {
          connectionId: download.connectionId,
          serverId: download.serverId,
          origin: client.serverOrigin,
        };
  }

  /** A session to play a download with no server, or null when it is not on this device. */
  offlineSession(connectionId: string, itemId: string): PlayerSession | null {
    const download = this.find(connectionId, itemId);
    if (download === undefined) return null;
    const { ticket } = download;
    return {
      sessionId: crypto.randomUUID(),
      itemId,
      titleId: ticket.titleId,
      sourceId: ticket.sourceId,
      title: ticket.title,
      streamUrl: ticket.streamPath,
      durationSeconds: ticket.durationSeconds,
      streams: ticket.streams,
      grantExpiresInSeconds: 1,
      grantToken: "offline",
      ...(ticket.trackMemory === undefined ? {} : { trackMemory: ticket.trackMemory }),
      media: ticket.media,
    };
  }

  /** Keeps offline progress for the server, folding repeated saves for an item into one. */
  recordOfflineProgress(connectionId: string, state: PlayerState): void {
    const completed = isWatchCompleted(
      Math.round(state.positionSeconds * 1000),
      state.durationSeconds === null ? null : Math.round(state.durationSeconds * 1000),
    );
    const outbox = this.stored.current.outbox.filter(
      (entry) => !(entry.connectionId === connectionId && entry.itemId === state.itemId),
    );
    outbox.push({
      connectionId,
      itemId: state.itemId,
      positionSeconds: Math.round(state.positionSeconds),
      completed,
      observedAtMs: this.clock(),
    });
    this.stored.set({ ...this.stored.current, outbox });
  }

  /**
   * A connection's server can be reached: hand back offline progress, check its downloads in,
   * keep its shows' episodes ready and carry on downloading.
   */
  connectionReady(connectionId: string): Promise<void> {
    const pending = this.syncing.get(connectionId);
    if (pending !== undefined) return pending;
    const syncing = this.sync(connectionId)
      .catch(reportFailure("Failed to check downloads in with the server"))
      .finally(() => {
        this.syncing.delete(connectionId);
        this.schedule();
      });
    this.syncing.set(connectionId, syncing);
    return syncing;
  }

  private async sync(connectionId: string): Promise<void> {
    const client = this.options.clientFor(connectionId);
    if (client === null) return;
    for (const entry of this.stored.current.outbox.filter(
      (item) => item.connectionId === connectionId,
    )) {
      await client.saveOfflineProgress(entry.itemId, entry);
      this.stored.set({
        ...this.stored.current,
        outbox: this.stored.current.outbox.filter((item) => item !== entry),
      });
    }
    if (!client.supportsDownloads) return;
    const held = this.downloads.filter((download) => download.connectionId === connectionId);
    if (held.length > 0) {
      const results = await client.syncDownloads(
        held.map((download) => {
          const target = download.next ?? download.ticket;
          return { downloadId: target.downloadId, revision: target.revision };
        }),
      );
      for (const result of results) {
        const download = held.find(
          (entry) => (entry.next ?? entry.ticket).downloadId === result.downloadId,
        );
        if (download === undefined || !this.downloads.includes(download)) continue;
        if (result.status === "revoked") {
          await this.remove(download.id, { tellServer: false });
          continue;
        }
        const target = download.next ?? download.ticket;
        if (result.expiresAtMs !== null) {
          const renewed = { ...target, expiresAtMs: result.expiresAtMs };
          if (download.next === null) download.ticket = renewed;
          else download.next = renewed;
        }
        if (result.completed) download.watchedAtMs ??= this.clock();
        else if (!this.inUse(download)) download.watchedAtMs = null;
        if (result.status === "changed")
          await this.renewTicket(download, client).catch((cause: unknown) =>
            this.fail(download, cause),
          );
      }
      this.save();
    }
    const first = held[0] ?? null;
    const account: Account = {
      connectionId,
      serverId: first?.serverId ?? client.serverId ?? "",
      origin: client.serverOrigin,
    };
    if (account.serverId !== "") await this.reconcileShows(account);
    await this.applyRetention();
    this.publish(true);
  }

  /**
   * Asks the server for a fresh grant. A newer revision of the file replaces an unfinished copy
   * at once, and a finished one only once the new copy is complete.
   */
  private async renewTicket(download: Download, client: ServerClient): Promise<StoredTicket> {
    const issued = await client.createDownload(download.itemId);
    this.tokens.set(issued.downloadId, issued.grantToken);
    await this.saveTokens();
    const ticket = storedTicket(issued);
    const { store } = this.options;
    const target = download.next ?? download.ticket;
    if (ticket.revision === target.revision) {
      if (download.next === null) download.ticket = ticket;
      else download.next = ticket;
    } else if (ticket.revision === download.ticket.revision) {
      if (download.next !== null) await store.discard(specOf(download.serverId, download.next));
      download.next = null;
      download.ticket = ticket;
    } else {
      await store.pin(specOf(download.serverId, ticket));
      if (download.completedAtMs !== null) {
        if (download.next !== null) await store.discard(specOf(download.serverId, download.next));
        download.next = ticket;
      } else {
        await store.discard(specOf(download.serverId, download.ticket));
        download.ticket = ticket;
      }
      if (download.status === "completed" && download.next !== null) download.reason = null;
      else if (!download.pausedByUser) download.status = "queued";
    }
    this.save();
    this.publish(true);
    return ticket;
  }

  private needsWork(download: Download): boolean {
    if (download.pausedByUser || download.status === "failed") return false;
    if (download.status === "completed" && download.next === null) return false;
    return this.options.clientFor(download.connectionId) !== null;
  }

  /** Runs the queue: the item being watched first, then in the order they were asked for. */
  schedule(): void {
    if (this.closed || this.pumpQueued) return;
    this.pumpQueued = true;
    // One run at a time, and at most one more queued behind it, however often this is asked.
    this.pumping = this.pumping
      .then(() => {
        this.pumpQueued = false;
        return this.pump();
      })
      .catch(reportFailure("Failed to run downloads"));
  }

  /**
   * Completes downloads whose files filled up some other way: playing a paused download keeps
   * what it fetches, and can fetch all of it.
   */
  private async settleFilled(): Promise<void> {
    const { store } = this.options;
    for (const download of this.downloads) {
      if (download.status === "completed" && download.next === null) continue;
      if (this.running?.id === download.id) continue;
      const target = download.next ?? download.ticket;
      if (store.find(specOf(download.serverId, target))?.complete !== true) continue;
      if (download.next !== null) {
        await store.discard(specOf(download.serverId, download.ticket));
        download.ticket = download.next;
        download.next = null;
      }
      download.status = "completed";
      download.pausedByUser = false;
      download.reason = null;
      download.completedAtMs ??= this.clock();
      this.save();
      this.publish(true);
    }
  }

  private async pump(): Promise<void> {
    await this.settleFilled();
    const now = this.clock();
    const playing = this.options.nowPlaying();
    const candidates = this.downloads
      .filter((download) => this.needsWork(download))
      .filter((download) => (this.retryAt.get(download.id)?.atMs ?? 0) <= now)
      .sort((a, b) => {
        const watching = (download: Download) =>
          playing?.connectionId === download.connectionId && playing.itemId === download.itemId
            ? 0
            : 1;
        return watching(a) - watching(b) || a.createdAtMs - b.createdAtMs;
      });
    this.scheduleRetry(now);
    for (const download of this.downloads)
      if (
        !this.needsWork(download) &&
        !download.pausedByUser &&
        download.status !== "failed" &&
        download.status !== "completed" &&
        this.options.clientFor(download.connectionId) === null
      ) {
        download.status = "waiting";
        download.reason = "Waiting for the server";
      }
    const next = candidates[0];
    if (this.running !== null) {
      // Starting to watch a download that is waiting its turn puts it ahead of the one running.
      if (next === undefined || next.id === this.running.id || this.inUse(next) === false) return;
      this.running.controller.abort();
      await this.running.done;
    }
    if (next === undefined || this.spaceWaiting) {
      this.publish();
      return;
    }
    const controller = new AbortController();
    const done = this.run(next, controller.signal).finally(() => {
      if (this.running?.controller === controller) this.running = null;
      this.schedule();
    });
    this.running = { id: next.id, controller, done };
  }

  /**
   * Looks at the queue again when the next retry falls due. A timer can fire before the clock
   * reaches that time, so the queue arms another for whatever is still to come.
   */
  private scheduleRetry(now: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    let due: number | null = null;
    for (const download of this.downloads) {
      const atMs = this.retryAt.get(download.id)?.atMs;
      if (atMs !== undefined && atMs > now && this.needsWork(download))
        due = Math.min(due ?? atMs, atMs);
    }
    if (due === null || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, due - now);
    this.retryTimer.unref?.();
  }

  private async run(download: Download, signal: AbortSignal): Promise<void> {
    const client = this.options.clientFor(download.connectionId);
    if (client === null) return;
    const { store } = this.options;
    try {
      let ticket = download.next ?? download.ticket;
      if (
        !this.tokens.has(ticket.downloadId) ||
        ticket.expiresAtMs - TICKET_MARGIN_MS <= this.clock()
      )
        ticket = await this.renewTicket(download, client);
      if (signal.aborted || !this.downloads.includes(download)) return;
      const file = await store.open(specOf(download.serverId, ticket));
      if (file.pins === 0) await store.pin(file.spec);
      download.status = "downloading";
      download.reason = null;
      this.publish(true);
      // Why the server refused a fresh grant, which is what to tell the viewer if fetching stops.
      let refusal: unknown = null;
      const removeSource = file.addSource({
        origin: client.serverOrigin,
        path: ticket.streamPath,
        token: this.tokens.get(ticket.downloadId) ?? "",
        kind: "download",
        refresh: async () => {
          const renewed = await this.renewTicket(download, client).catch((cause: unknown) => {
            refusal = cause;
            return null;
          });
          if (renewed === null || renewed.revision !== file.spec.revision) return null;
          return {
            origin: client.serverOrigin,
            path: renewed.streamPath,
            token: this.tokens.get(renewed.downloadId) ?? "",
            kind: "download",
          };
        },
      });
      const onProgress = () => this.publish();
      file.on("progress", onProgress);
      try {
        await file.download(signal);
      } catch (cause) {
        // A grant the server would not renew explains the failed fetch better than its status.
        throw refusal !== null && !isTransient(refusal) ? refusal : cause;
      } finally {
        removeSource();
        file.off("progress", onProgress);
      }
      if (!this.downloads.includes(download)) return;
      if (download.next !== null && download.next.revision === file.spec.revision) {
        // The newer copy is ready: it replaces the one that played until now.
        await store.discard(specOf(download.serverId, download.ticket));
        download.ticket = download.next;
        download.next = null;
      }
      download.status = "completed";
      download.reason = null;
      download.completedAtMs ??= this.clock();
      this.retryAt.delete(download.id);
      this.save();
      this.publish(true);
    } catch (cause) {
      if (!this.downloads.includes(download)) return;
      if (signal.aborted) {
        if (!download.pausedByUser && download.status === "downloading") download.status = "queued";
        this.publish(true);
        return;
      }
      if (cause instanceof SpaceExhausted) {
        download.status = "waiting";
        download.reason = "Paused: disk almost full";
        this.waitForSpace();
      } else if (cause instanceof MediaChanged) {
        await this.renewTicket(download, client).catch((error: unknown) =>
          this.fail(download, error),
        );
      } else this.fail(download, cause);
      this.save();
      this.publish(true);
    }
  }

  private fail(download: Download, cause: unknown): void {
    if (isTransient(cause)) {
      const attempts = (this.retryAt.get(download.id)?.attempts ?? 0) + 1;
      const delay = Math.min(MAX_RETRY_MS, 5_000 * 2 ** (attempts - 1));
      this.retryAt.set(download.id, { atMs: this.clock() + delay, attempts });
      if (download.status !== "completed") {
        download.status = "waiting";
        download.reason = "Can’t reach the server. Retrying…";
      }
      return;
    }
    if (download.status !== "completed") {
      download.status = "failed";
      download.reason = describeFailure(cause);
    }
  }

  private waitForSpace(): void {
    if (this.spaceWaiting) return;
    this.spaceWaiting = true;
    const check = setInterval(() => {
      void this.options.store.hasRoomToResume().then((room) => {
        if (room) {
          clearInterval(check);
          this.resumeAfterSpace();
        }
      });
    }, SPACE_CHECK_MS);
    check.unref?.();
    this.timers.push(check);
  }

  private spaceFreed(): void {
    if (!this.spaceWaiting) return;
    void this.options.store.hasRoomToResume().then((room) => {
      if (room) this.resumeAfterSpace();
    });
  }

  private resumeAfterSpace(): void {
    this.spaceWaiting = false;
    for (const download of this.downloads)
      if (download.status === "waiting" && download.reason === "Paused: disk almost full") {
        download.status = "queued";
        download.reason = null;
      }
    this.publish(true);
    this.schedule();
  }

  /** A client for playing an account's downloads while its server cannot be reached. */
  offlineClient(account: Account): PlaybackClient {
    // Nothing reaches a server that cannot be reached.
    const nowhere = async (): Promise<void> => undefined;
    return {
      serverOrigin: account.origin,
      serverId: account.serverId,
      supportsTranscoding: false,
      offline: true,
      startPlayback: async (itemId) => {
        const session = this.offlineSession(account.connectionId, itemId);
        if (session === null) throw new Error("This item is not downloaded");
        return session;
      },
      heartbeat: nowhere,
      progress: async (_sessionId, state) =>
        this.recordOfflineProgress(account.connectionId, state),
      stopPlayback: nowhere,
      saveTrackChoice: async () => null,
    };
  }

  /** Whether an account's item can play from this device alone. */
  hasOffline(connectionId: string, itemId: string): boolean {
    return this.find(connectionId, itemId) !== undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.publishTimer !== null) clearTimeout(this.publishTimer);
    if (this.retentionTimer !== null) clearTimeout(this.retentionTimer);
    this.running?.controller.abort();
    await this.running?.done;
    this.save();
    await this.options.store.close();
  }
}
