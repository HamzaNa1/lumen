import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChunkMap, nextChunkToDownload } from "@lumen/client";
import type { PlayableMedia } from "@lumen/contracts";
import { ignoreFailure } from "../failures";
import { DiskByteStore, MemoryByteStore, SpaceExhausted } from "./ByteStore";

/** One revision of one file on one server: the unit bytes are kept and shared under. */
export interface MediaSpec {
  readonly serverId: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}

/** The file a server described, or null when it said too little for its bytes to be kept. */
export const mediaSpecOf = (
  serverId: string | null,
  sourceId: string,
  media: PlayableMedia | undefined,
): MediaSpec | null =>
  serverId === null ||
  media?.revision === undefined ||
  media.sizeBytes === null ||
  media.sizeBytes <= 0
    ? null
    : {
        serverId,
        sourceId,
        revision: media.revision,
        sizeBytes: media.sizeBytes,
        mimeType: media.mimeType ?? "application/octet-stream",
      };

export const mediaKey = (spec: Pick<MediaSpec, "serverId" | "sourceId" | "revision">): string =>
  `${spec.serverId}/${spec.sourceId}/${createHash("sha256").update(spec.revision).digest("hex").slice(0, 24)}`;

/** Where to fetch the file from, and the grant that allows it. */
export interface UpstreamSource {
  readonly origin: string;
  readonly path: string;
  readonly token: string;
  /** A download's grant outlives the player, so it is preferred over a playback session's. */
  readonly kind: "download" | "playback";
  /** Asked for a fresh grant when the server refuses this one. */
  readonly refresh?: () => Promise<UpstreamSource | null>;
}

export interface MediaGeometry {
  readonly chunkBytes: number;
  readonly segmentBytes: number;
}

/** The server no longer has these bytes under this revision. */
export class MediaChanged extends Error {}
/** Nothing is allowed to fetch the missing bytes. */
export class MediaUnavailable extends Error {}

type Target = "disk" | "memory";

interface Fetch {
  readonly start: number;
  readonly end: number;
  readonly target: Target;
  /** Paced by the readers: it fetches only a window ahead of them. */
  readonly paced: boolean;
  readonly background: boolean;
  readonly controller: AbortController;
  cursor: number;
  done: Promise<void>;
}

interface Reader {
  position: number;
}

interface StoredIndex {
  readonly version: 1;
  readonly spec: MediaSpec;
  readonly chunkBytes: number;
  readonly segmentBytes: number;
  readonly chunks: string;
  readonly segmentUsedAtMs: Readonly<Record<string, number>>;
}

const READ_BYTES = 256 * 1024;
const MEMORY_BEHIND_BYTES = 4 * 1024 * 1024;
const MIN_LOOKAHEAD_BYTES = 16 * 1024 * 1024;
const MAX_LOOKAHEAD_BYTES = 256 * 1024 * 1024;
const MAX_MEMORY_LOOKAHEAD_BYTES = 32 * 1024 * 1024;
const LOOKAHEAD_SECONDS = 120;
const STALL_LIMIT_MS = 20_000;
const IDLE_FETCH_MS = 10_000;
const MAX_FOREGROUND_FETCHES = 3;
const INDEX_BYTES = { head: 8 * 1024 * 1024, tail: 16 * 1024 * 1024 } as const;

const validIndex = (
  value: unknown,
  spec: MediaSpec,
  geometry: MediaGeometry,
): value is StoredIndex => {
  if (value === null || typeof value !== "object") return false;
  const index = value as Partial<StoredIndex>;
  return (
    index.version === 1 &&
    index.chunkBytes === geometry.chunkBytes &&
    index.segmentBytes === geometry.segmentBytes &&
    typeof index.chunks === "string" &&
    index.spec?.revision === spec.revision &&
    index.spec.sizeBytes === spec.sizeBytes &&
    index.spec.sourceId === spec.sourceId &&
    index.spec.serverId === spec.serverId
  );
};

/**
 * One file as this device holds it: chunks kept on disk, a window of chunks kept in memory for
 * streams nothing is kept from, the fetches filling either, and the readers the player opened.
 *
 * Readers never see where bytes come from. Each takes whatever is held at its position, and when
 * nothing is, asks for a fetch there and waits for it; held data then runs straight into fetched
 * data, which is what lets playback cross from downloaded parts into missing ones without a seam.
 */
export class MediaFile extends EventEmitter {
  readonly key: string;
  readonly disk: ChunkMap;
  private readonly memory: ChunkMap;
  private readonly memoryStore: MemoryByteStore;
  /** Memory chunks held before any reader came, which readers moving on do not let go of. */
  private readonly kept = new Set<number>();
  private readonly fetches = new Set<Fetch>();
  private readonly readers = new Set<Reader>();
  private readonly sources = new Map<symbol, UpstreamSource>();
  private readonly segmentUsedAtMs = new Map<number, number>();
  private saving: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastFocus = 0;
  /** Downloads holding this file. Unpinned files are cache, given back when space is wanted. */
  pins = 0;
  /** Players reading this file now. */
  users = 0;
  /** Whether new bytes may be kept on disk: always for downloads, for streams within the cache. */
  keepsBytes: () => boolean = () => this.pins > 0;
  /** Set when the server stopped serving this revision; nothing more will be fetched. */
  changed = false;
  /** The last reason a fetch failed, for the player to report. */
  lastFailure: Error | null = null;
  /** After the disk refused a segment, new bytes go to memory for a while instead. */
  private diskRefusedUntil = 0;

  private wantsDisk(): boolean {
    return this.keepsBytes() && Date.now() >= this.diskRefusedUntil;
  }

  private constructor(
    readonly spec: MediaSpec,
    readonly directory: string,
    readonly geometry: MediaGeometry,
    readonly store: DiskByteStore,
    disk: ChunkMap,
    usedAtMs: Readonly<Record<string, number>>,
    private readonly fetchImpl: typeof fetch,
  ) {
    super();
    this.setMaxListeners(0);
    this.key = mediaKey(spec);
    this.disk = disk;
    this.memory = new ChunkMap(spec.sizeBytes, geometry.chunkBytes);
    this.memoryStore = new MemoryByteStore(geometry.chunkBytes);
    for (const [segment, at] of Object.entries(usedAtMs))
      this.segmentUsedAtMs.set(Number(segment), at);
  }

  static async open(options: {
    readonly root: string;
    readonly spec: MediaSpec;
    readonly geometry: MediaGeometry;
    readonly allowSegment: (file: MediaFile) => Promise<boolean>;
    readonly fetchImpl?: typeof fetch;
  }): Promise<MediaFile> {
    const { spec, geometry } = options;
    const directory = join(options.root, mediaKey(spec));
    await mkdir(directory, { recursive: true });
    let stored: StoredIndex | null = null;
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
      if (validIndex(value, spec, geometry)) stored = value;
    } catch {
      // A missing or unreadable index means nothing is known to be held.
    }
    let file: MediaFile | null = null;
    const store = await DiskByteStore.open(directory, geometry.segmentBytes, () =>
      file === null ? Promise.resolve(false) : options.allowSegment(file),
    );
    const disk = new ChunkMap(spec.sizeBytes, geometry.chunkBytes, stored?.chunks);
    // A crash can leave a chunk recorded whose segment never reached the disk in full.
    for (let index = 0; index < disk.count; index += 1) {
      if (!disk.has(index)) continue;
      const segment = Math.floor(disk.startOf(index) / geometry.segmentBytes);
      const needed = disk.endOf(index) - segment * geometry.segmentBytes;
      if ((store.segments.get(segment) ?? 0) < needed) disk.clear(index);
    }
    file = new MediaFile(
      spec,
      directory,
      geometry,
      store,
      disk,
      stored?.segmentUsedAtMs ?? {},
      options.fetchImpl ?? fetch,
    );
    return file;
  }

  /** Reads the identity of a file kept earlier, without opening it. */
  static async describe(directory: string): Promise<MediaSpec | null> {
    try {
      const value = JSON.parse(
        await readFile(join(directory, "index.json"), "utf8"),
      ) as Partial<StoredIndex>;
      const spec = value.spec;
      if (
        value.version !== 1 ||
        spec === undefined ||
        typeof spec.serverId !== "string" ||
        typeof spec.sourceId !== "string" ||
        typeof spec.revision !== "string" ||
        typeof spec.sizeBytes !== "number" ||
        typeof spec.mimeType !== "string"
      )
        return null;
      return spec;
    } catch {
      return null;
    }
  }

  get complete(): boolean {
    return this.disk.complete;
  }

  get busy(): boolean {
    return this.users > 0 || this.fetches.size > 0 || this.readers.size > 0;
  }

  /** Segments with when each was last read or written, for the cache to give back the oldest. */
  get segments(): ReadonlyArray<{
    readonly index: number;
    readonly bytes: number;
    readonly usedAtMs: number;
  }> {
    return [...this.store.segments].map(([index, bytes]) => ({
      index,
      bytes,
      usedAtMs: this.segmentUsedAtMs.get(index) ?? 0,
    }));
  }

  /** Whether a reader or fetch is working within a segment, which must not be dropped. */
  segmentBusy(index: number): boolean {
    const start = index * this.geometry.segmentBytes;
    const end = start + this.geometry.segmentBytes;
    for (const reader of this.readers)
      if (reader.position >= start - this.geometry.chunkBytes && reader.position < end) return true;
    for (const fetch of this.fetches)
      if (fetch.target === "disk" && fetch.cursor >= start && fetch.start < end) return true;
    return false;
  }

  addSource(source: UpstreamSource): () => void {
    const id = Symbol("source");
    this.sources.set(id, source);
    return () => {
      this.sources.delete(id);
    };
  }

  /** Bytes per second of playback, or null when the duration is unknown. */
  bitrate: number | null = null;

  private lookahead(target: Target): number {
    const byRate =
      this.bitrate === null ? MIN_LOOKAHEAD_BYTES : Math.round(this.bitrate * LOOKAHEAD_SECONDS);
    const bounded = Math.min(MAX_LOOKAHEAD_BYTES, Math.max(MIN_LOOKAHEAD_BYTES, byRate));
    return target === "memory" ? Math.min(bounded, MAX_MEMORY_LOOKAHEAD_BYTES) : bounded;
  }

  /** Where the bytes at `position` are held, and up to where they run without a gap. */
  private heldAt(position: number): { readonly until: number; readonly target: Target } | null {
    let best: { until: number; target: Target } | null = null;
    const consider = (until: number, target: Target) => {
      if (until > position && (best === null || until > best.until)) best = { until, target };
    };
    consider(this.disk.heldUntil(position), "disk");
    consider(this.memory.heldUntil(position), "memory");
    for (const fetch of this.fetches)
      if (this.writingFrom(fetch) <= position && position < fetch.cursor)
        consider(fetch.cursor, fetch.target);
    return best;
  }

  /**
   * Where the bytes only a fetch knows of begin: the chunk it is part way through. Every chunk it
   * finished before that is recorded as held, and stops being held once memory lets it go behind
   * the readers, so the fetch cannot vouch for it.
   */
  private writingFrom(fetch: Fetch): number {
    return Math.max(fetch.start, this.disk.startOf(this.disk.chunkOf(fetch.cursor)));
  }

  private isHeld(chunk: number): boolean {
    return this.disk.has(chunk) || this.memory.has(chunk);
  }

  /** Streams bytes [start, end) to a reader as they become available. */
  async *read(start: number, end: number, signal: AbortSignal): AsyncGenerator<Buffer> {
    const reader: Reader = { position: start };
    this.readers.add(reader);
    this.lastFocus = start;
    let stalledSince: number | null = null;
    let readFailures = 0;
    try {
      while (reader.position < end) {
        if (signal.aborted || this.closed) throw new MediaUnavailable("Read was cancelled");
        const held = this.heldAt(reader.position);
        if (held !== null) {
          const length = Math.min(held.until, end, reader.position + READ_BYTES) - reader.position;
          let bytes: Buffer;
          try {
            bytes =
              held.target === "disk"
                ? await this.store.read(reader.position, length)
                : await this.memoryStore.read(reader.position, length);
          } catch (cause) {
            // The bytes went between the check and the read, such as a segment the cache gave
            // back. They are fetched again on the next pass; repeated failures are real ones.
            readFailures += 1;
            if (readFailures > 8) throw cause;
            continue;
          }
          readFailures = 0;
          stalledSince = null;
          reader.position += length;
          this.lastFocus = reader.position;
          if (held.target === "disk") this.touch(reader.position - 1);
          this.emit("reader");
          this.prefetch(reader.position);
          this.releaseMemoryBehind();
          yield bytes;
          continue;
        }
        if (this.changed) throw new MediaChanged("The file changed on the server");
        stalledSince ??= Date.now();
        if (Date.now() - stalledSince > STALL_LIMIT_MS)
          throw this.lastFailure ?? new MediaUnavailable("Media is unavailable");
        this.demand(reader.position);
        if (this.sources.size === 0 && this.lastFailure instanceof MediaUnavailable)
          throw this.lastFailure;
        await this.nextChange(signal, 1_000);
      }
    } finally {
      this.readers.delete(reader);
      this.emit("reader");
    }
  }

  private async nextChange(signal: AbortSignal, timeoutMs: number): Promise<void> {
    const timeout = AbortSignal.timeout(timeoutMs);
    await once(this, "progress", { signal: AbortSignal.any([signal, timeout]) }).catch(
      ignoreFailure,
    );
  }

  private touch(offset: number): void {
    const segment = Math.floor(offset / this.geometry.segmentBytes);
    this.segmentUsedAtMs.set(segment, Date.now());
  }

  /** Starts fetching ahead of a reader where a gap is coming, before the reader reaches it. */
  private prefetch(position: number): void {
    if (this.changed || this.sources.size === 0) return;
    const target: Target = this.wantsDisk() ? "disk" : "memory";
    const horizon = Math.min(this.spec.sizeBytes, position + this.lookahead(target));
    const first = this.disk.chunkOf(position);
    const last = this.disk.chunkOf(Math.max(position, horizon - 1));
    for (let chunk = first; chunk <= last; chunk += 1) {
      if (this.isHeld(chunk)) continue;
      const offset = Math.max(position, this.disk.startOf(chunk));
      if (!this.covered(offset)) this.demand(offset);
      return;
    }
  }

  /** Whether a fetch already running will reach `offset` soon. */
  private covered(offset: number): boolean {
    for (const fetch of this.fetches)
      if (
        this.writingFrom(fetch) <= offset &&
        offset < fetch.end &&
        offset - fetch.cursor <= this.geometry.chunkBytes * 2
      )
        return true;
    return false;
  }

  /** Makes sure a fetch is bringing the bytes at `offset`. */
  demand(offset: number): void {
    if (this.closed || this.changed || this.covered(offset)) return;
    const foreground = [...this.fetches].filter((fetch) => !fetch.background);
    // A player asks for new places as it seeks, so the oldest request is the one it has left.
    if (foreground.length >= MAX_FOREGROUND_FETCHES) foreground[0]?.controller.abort();
    this.startFetch(offset, false);
  }

  private startFetch(offset: number, background: boolean): Fetch | null {
    const first = this.disk.chunkOf(offset);
    if (first >= this.disk.count) return null;
    let after = first;
    while (after < this.disk.count && !this.isHeld(after)) after += 1;
    if (after === first) return null;
    const target: Target = this.wantsDisk() ? "disk" : "memory";
    const fetch: Fetch = {
      start: this.disk.startOf(first),
      end: after >= this.disk.count ? this.spec.sizeBytes : this.disk.startOf(after),
      target,
      paced: this.pins === 0,
      background,
      controller: new AbortController(),
      cursor: this.disk.startOf(first),
      done: Promise.resolve(),
    };
    this.fetches.add(fetch);
    fetch.done = this.runFetch(fetch)
      .catch((cause: unknown) => {
        if (cause instanceof SpaceExhausted) this.diskRefusedUntil = Date.now() + 30_000;
        if (fetch.controller.signal.aborted && !(cause instanceof SpaceExhausted)) return;
        this.lastFailure = cause instanceof Error ? cause : new Error(String(cause));
        this.emit("failure", this.lastFailure);
        if (background) throw cause;
      })
      .finally(() => {
        this.fetches.delete(fetch);
        this.scheduleSave();
        this.emit("progress");
      });
    if (!background) fetch.done.catch(ignoreFailure);
    return fetch;
  }

  private pickSource(): UpstreamSource | null {
    const sources = [...this.sources.values()];
    return sources.find((source) => source.kind === "download") ?? sources.at(-1) ?? null;
  }

  private async request(fetch: Fetch): Promise<Response> {
    let source = this.pickSource();
    if (source === null) throw new MediaUnavailable("This part of the media is not on this device");
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(new URL(source.path, source.origin), {
        headers: {
          authorization: `Bearer ${source.token}`,
          range: `bytes=${fetch.start}-${fetch.end - 1}`,
          "accept-encoding": "identity",
        },
        redirect: "manual",
        signal: fetch.controller.signal,
      });
      if ([401, 403, 404].includes(response.status) && attempt === 0 && source.refresh) {
        await response.body?.cancel().catch(ignoreFailure);
        const refreshed = await source.refresh();
        if (refreshed !== null) {
          source = refreshed;
          continue;
        }
      }
      if (response.status !== 206) {
        await response.body?.cancel().catch(ignoreFailure);
        if (response.status === 200 || response.status === 416)
          throw new MediaChanged("The file changed");
        throw new Error(`Media request failed (HTTP ${response.status})`);
      }
      const etag = response.headers.get("etag");
      const range = response.headers.get("content-range");
      if (
        (etag !== null && etag !== this.spec.revision) ||
        range !== `bytes ${fetch.start}-${fetch.end - 1}/${this.spec.sizeBytes}`
      ) {
        await response.body?.cancel().catch(ignoreFailure);
        throw new MediaChanged("The file changed on the server");
      }
      return response;
    }
  }

  private async runFetch(fetch: Fetch): Promise<void> {
    let idleSince = Date.now();
    let response: Response;
    try {
      response = await this.request(fetch);
    } catch (cause) {
      if (cause instanceof MediaChanged) this.markChanged();
      throw cause;
    }
    if (response.body === null) throw new Error("Media response had no body");
    const body = response.body.getReader();
    const onAbort = () => void body.cancel().catch(ignoreFailure);
    fetch.controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (fetch.cursor < fetch.end) {
        if (fetch.paced) {
          // Fetch only a window ahead of the readers; stop once no reader has come for a while.
          for (;;) {
            if (fetch.controller.signal.aborted) return;
            const furthest = Math.max(-1, ...[...this.readers].map((reader) => reader.position));
            if (furthest >= 0) idleSince = Date.now();
            else if (Date.now() - idleSince > IDLE_FETCH_MS) return;
            if (furthest >= 0 && fetch.cursor - furthest <= this.lookahead(fetch.target)) break;
            if (furthest < 0 && fetch.cursor - fetch.start <= this.geometry.chunkBytes * 2) break;
            await once(this, "reader", {
              signal: AbortSignal.any([fetch.controller.signal, AbortSignal.timeout(1_000)]),
            }).catch(ignoreFailure);
          }
        }
        const chunk = this.disk.chunkOf(fetch.cursor);
        if (fetch.cursor === this.disk.startOf(chunk) && this.isHeld(chunk)) return;
        const { value, done } = await body.read();
        if (done) break;
        if (fetch.controller.signal.aborted) return;
        const data = value.subarray(0, Math.min(value.length, fetch.end - fetch.cursor));
        if (fetch.target === "disk") await this.store.write(fetch.cursor, data);
        else await this.memoryStore.write(fetch.cursor, data);
        const before = fetch.cursor;
        fetch.cursor += data.length;
        this.markWritten(fetch, before);
        this.emit("progress");
      }
      if (fetch.cursor < fetch.end) throw new Error("Media response ended early");
    } finally {
      fetch.controller.signal.removeEventListener("abort", onAbort);
      await body.cancel().catch(ignoreFailure);
    }
  }

  /** Records every chunk the fetch has now written in full. */
  private markWritten(fetch: Fetch, before: number): void {
    const map = fetch.target === "disk" ? this.disk : this.memory;
    for (let chunk = map.chunkOf(before); chunk < map.count; chunk += 1) {
      if (map.startOf(chunk) < fetch.start) continue;
      if (map.endOf(chunk) > fetch.cursor) break;
      map.set(chunk);
    }
    if (fetch.target === "disk") {
      this.touch(fetch.cursor - 1);
      this.scheduleSave();
    }
  }

  /** Drops in-memory chunks no reader will come back for. */
  private releaseMemoryBehind(): void {
    if (this.memory.heldCount === 0) return;
    const behind =
      Math.min(...[...this.readers].map((reader) => reader.position)) - MEMORY_BEHIND_BYTES;
    const limit = Number.isFinite(behind) ? behind : Number.POSITIVE_INFINITY;
    for (let chunk = 0; chunk < this.memory.count && this.memory.endOf(chunk) <= limit; chunk += 1)
      if (this.memory.has(chunk) && !this.kept.has(chunk)) this.dropMemory(chunk);
  }

  private dropMemory(chunk: number): void {
    this.memory.clear(chunk);
    this.memoryStore.dropChunk(chunk);
    this.kept.delete(chunk);
  }

  /**
   * Holds chunks fetched before the file opened, such as the start of the next episode. They
   * stay in memory until no player reads the file, however far its readers move.
   */
  async adoptMemory(chunks: ReadonlyMap<number, Buffer>): Promise<number> {
    let adopted = 0;
    for (const [chunk, bytes] of chunks) {
      if (chunk >= this.memory.count || this.isHeld(chunk)) continue;
      if (bytes.length !== this.memory.endOf(chunk) - this.memory.startOf(chunk)) continue;
      await this.memoryStore.write(this.memory.startOf(chunk), bytes);
      this.memory.set(chunk);
      this.kept.add(chunk);
      adopted += bytes.length;
    }
    if (adopted > 0) this.emit("progress");
    return adopted;
  }

  /** Lets go of every chunk held in memory, once no player reads the file. */
  releaseMemory(): void {
    for (let chunk = 0; chunk < this.memory.count; chunk += 1)
      if (this.memory.has(chunk)) this.dropMemory(chunk);
  }

  private markChanged(): void {
    if (this.changed) return;
    this.changed = true;
    for (const fetch of this.fetches) fetch.controller.abort();
    this.emit("changed");
    this.emit("progress");
  }

  /**
   * Fetches every missing chunk into the disk, starting from what a player needs first. Settles
   * when the file is complete; fails when the server or the disk stops it.
   */
  async download(signal: AbortSignal): Promise<void> {
    while (!this.disk.complete) {
      if (signal.aborted) throw signal.reason;
      if (this.closed) throw new MediaUnavailable("The file was closed");
      if (this.changed) throw new MediaChanged("The file changed on the server");
      if (!this.wantsDisk()) throw new SpaceExhausted();
      const chunk = nextChunkToDownload(this.disk, this.lastFocus, INDEX_BYTES);
      if (chunk === -1) break;
      const offset = this.disk.startOf(chunk);
      const running = [...this.fetches].find(
        (fetch) =>
          fetch.target === "disk" && fetch.start <= offset && offset < fetch.end && !fetch.paced,
      );
      if (running !== undefined) {
        await this.nextChange(signal, 1_000);
        continue;
      }
      // Anything in memory there is dropped: the disk copy is the one that lasts.
      if (this.memory.has(chunk)) this.dropMemory(chunk);
      const fetch = this.startFetch(offset, true);
      if (fetch === null) continue;
      const stop = () => fetch.controller.abort();
      signal.addEventListener("abort", stop, { once: true });
      try {
        await fetch.done;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    }
    await this.save();
  }

  /** Stops fetches a player started; a download's own fetches carry on. */
  stopForeground(): void {
    for (const fetch of this.fetches) if (!fetch.background) fetch.controller.abort();
  }

  /** Stops fetches that only fill the file in the background. */
  stopBackground(): void {
    for (const fetch of this.fetches) if (fetch.background) fetch.controller.abort();
  }

  /** Byte ranges held on disk. */
  heldRanges(): ReadonlyArray<readonly [number, number]> {
    return this.disk.ranges();
  }

  /** Gives back one segment of disk space; its chunks are fetched again if wanted. */
  async dropSegment(index: number): Promise<void> {
    const start = index * this.geometry.segmentBytes;
    const end = Math.min(this.spec.sizeBytes, start + this.geometry.segmentBytes);
    for (
      let chunk = this.disk.chunkOf(start);
      chunk < this.disk.count && this.disk.startOf(chunk) < end;
      chunk += 1
    )
      this.disk.clear(chunk);
    this.segmentUsedAtMs.delete(index);
    await this.save();
    await this.store.dropSegment(index);
  }

  /** Gives back every segment no reader or fetch is using. */
  async dropUnused(): Promise<void> {
    for (const { index } of this.segments)
      if (!this.segmentBusy(index)) await this.dropSegment(index);
  }

  scheduleSave(): void {
    if (this.closed || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch(ignoreFailure);
    }, 2_000);
    this.saveTimer.unref?.();
  }

  /** Records what is held. Bytes reach the disk before the record saying they are there. */
  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const previous = this.saving ?? Promise.resolve();
    const next = previous.then(async () => {
      await this.store.flush();
      const index: StoredIndex = {
        version: 1,
        spec: this.spec,
        chunkBytes: this.geometry.chunkBytes,
        segmentBytes: this.geometry.segmentBytes,
        chunks: this.disk.encode(),
        segmentUsedAtMs: Object.fromEntries(this.segmentUsedAtMs),
      };
      const path = join(this.directory, "index.json");
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(index));
      await rename(temporary, path);
    });
    this.saving = next.catch(ignoreFailure);
    await next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const fetch of this.fetches) fetch.controller.abort();
    await Promise.all([...this.fetches].map((fetch) => fetch.done.catch(ignoreFailure)));
    await this.save().catch(ignoreFailure);
    this.closed = true;
    this.emit("progress");
    await this.store.close();
    await this.memoryStore.close();
  }

  /** Deletes everything held for this file. */
  async destroy(): Promise<void> {
    this.closed = true;
    for (const fetch of this.fetches) fetch.controller.abort();
    await Promise.all([...this.fetches].map((fetch) => fetch.done.catch(ignoreFailure)));
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.emit("progress");
    await this.store.close();
    await this.memoryStore.close();
    await rm(this.directory, { recursive: true, force: true });
  }
}
