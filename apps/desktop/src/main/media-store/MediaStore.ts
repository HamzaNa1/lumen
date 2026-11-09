import { mkdir, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { segmentsOverBudget } from "@lumen/client";
import type { StorageUsage } from "@lumen/contracts";
import { MediaFile, type MediaGeometry, type MediaSpec, mediaKey } from "./MediaFile";

export interface DiskSpace {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export const defaultGeometry: MediaGeometry = {
  chunkBytes: 1024 * 1024,
  segmentBytes: 32 * 1024 * 1024,
};

const listDirectories = async (path: string): Promise<string[]> =>
  (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

/**
 * Every file this device holds bytes of. Files a download pins stay until the download goes;
 * everything else is streaming cache, kept within its budget and given back first when the disk
 * runs low.
 */
export class MediaStore {
  private readonly files = new Map<string, MediaFile>();
  private readonly opening = new Map<string, Promise<MediaFile>>();
  private enforcing: Promise<void> | null = null;
  /** Bytes the streaming cache may keep. */
  cacheBudgetBytes = 0;
  /** Downloads pause while less than this share of the disk is free. */
  minimumFreePercent = 10;
  /** Called when free space changes enough that paused downloads may resume. */
  onSpaceFreed: () => void = () => undefined;

  private constructor(
    readonly root: string,
    readonly geometry: MediaGeometry,
    private readonly space: () => Promise<DiskSpace>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  static async load(options: {
    readonly root: string;
    readonly geometry?: MediaGeometry;
    readonly space?: (store: MediaStore) => Promise<DiskSpace>;
    readonly fetchImpl?: typeof fetch;
  }): Promise<MediaStore> {
    await mkdir(options.root, { recursive: true });
    let store: MediaStore | null = null;
    const space =
      options.space === undefined
        ? async () => {
            const details = await statfs(options.root);
            return {
              freeBytes: details.bavail * details.bsize,
              totalBytes: details.blocks * details.bsize,
            };
          }
        : () => (options.space as (store: MediaStore) => Promise<DiskSpace>)(store as MediaStore);
    store = new MediaStore(
      options.root,
      options.geometry ?? defaultGeometry,
      space,
      options.fetchImpl ?? fetch,
    );
    for (const server of await listDirectories(options.root))
      for (const source of await listDirectories(join(options.root, server)))
        for (const revision of await listDirectories(join(options.root, server, source))) {
          const directory = join(options.root, server, source, revision);
          const spec = await MediaFile.describe(directory);
          if (spec === null || mediaKey(spec) !== `${server}/${source}/${revision}`) {
            await rm(directory, { recursive: true, force: true });
            continue;
          }
          await store.open(spec).catch(() => rm(directory, { recursive: true, force: true }));
        }
    return store;
  }

  /** Every file held, opened or not. */
  get all(): ReadonlyArray<MediaFile> {
    return [...this.files.values()];
  }

  find(spec: Pick<MediaSpec, "serverId" | "sourceId" | "revision">): MediaFile | null {
    return this.files.get(mediaKey(spec)) ?? null;
  }

  async open(spec: MediaSpec): Promise<MediaFile> {
    const key = mediaKey(spec);
    const existing = this.files.get(key);
    if (existing !== undefined) return existing;
    const pending = this.opening.get(key);
    if (pending !== undefined) return pending;
    const opening = MediaFile.open({
      root: this.root,
      spec,
      geometry: this.geometry,
      allowSegment: (file) => this.allowSegment(file),
      fetchImpl: this.fetchImpl,
    }).then((file) => {
      file.keepsBytes = () => file.pins > 0 || this.cacheBudgetBytes > 0;
      this.files.set(key, file);
      return file;
    });
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(key);
    }
  }

  /** Opens a file for a player. The cache is trimmed once the player lets it go. */
  async acquire(
    spec: MediaSpec,
  ): Promise<{ readonly file: MediaFile; readonly release: () => void }> {
    const file = await this.open(spec);
    file.users += 1;
    let released = false;
    return {
      file,
      release: () => {
        if (released) return;
        released = true;
        file.users -= 1;
        // What the player was fetching is not wanted once no player reads the file.
        if (file.users === 0) file.stopForeground();
        void this.enforceCache();
      },
    };
  }

  async pin(spec: MediaSpec): Promise<MediaFile> {
    const file = await this.open(spec);
    file.pins += 1;
    return file;
  }

  /** Lets go of a download's file and deletes what is kept of it. */
  async discard(spec: Pick<MediaSpec, "serverId" | "sourceId" | "revision">): Promise<void> {
    const file = this.find(spec);
    if (file === null) return;
    file.pins = Math.max(0, file.pins - 1);
    if (file.pins > 0) return;
    if (file.users > 0) {
      file.stopBackground();
      await file.dropUnused();
    } else {
      this.files.delete(file.key);
      await file.destroy();
    }
    this.onSpaceFreed();
  }

  async diskSpace(): Promise<DiskSpace> {
    return this.space();
  }

  minimumFreeBytes(totalBytes: number): number {
    return Math.ceil((totalBytes * this.minimumFreePercent) / 100);
  }

  private cacheBytes(): number {
    let total = 0;
    for (const file of this.files.values()) if (file.pins === 0) total += file.store.bytes;
    return total;
  }

  /** Whether a new segment may be written for this file: disk space first, then the cache budget. */
  private async allowSegment(file: MediaFile): Promise<boolean> {
    const needed = this.geometry.segmentBytes;
    if (file.pins === 0) {
      if (this.cacheBytes() + needed > this.cacheBudgetBytes)
        await this.trimCache(Math.max(0, this.cacheBudgetBytes - needed));
      if (this.cacheBytes() + needed > this.cacheBudgetBytes) return false;
    }
    let space = await this.space();
    if (space.freeBytes - needed >= this.minimumFreeBytes(space.totalBytes)) return true;
    // Cache is the first thing to give back when the disk runs low.
    await this.trimCache(0);
    space = await this.space();
    return file.pins > 0 && space.freeBytes - needed >= this.minimumFreeBytes(space.totalBytes);
  }

  /** Drops the least recently used cache segments until the cache fits in `budgetBytes`. */
  private async trimCache(budgetBytes: number): Promise<void> {
    const cached = [...this.files.values()].filter((file) => file.pins === 0);
    const segments = cached.flatMap((file) =>
      file.segments.map((segment) => ({
        key: `${file.key}#${segment.index}`,
        bytes: segment.bytes,
        lastUsedAtMs: segment.usedAtMs,
        busy: file.segmentBusy(segment.index),
        file,
        index: segment.index,
      })),
    );
    const evicted = new Set(segmentsOverBudget(segments, budgetBytes));
    for (const segment of segments)
      if (evicted.has(segment.key)) await segment.file.dropSegment(segment.index);
    for (const file of cached)
      if (file.segments.length === 0 && !file.busy && file.pins === 0) {
        this.files.delete(file.key);
        await file.destroy();
      }
  }

  /** Brings the streaming cache back within its budget. */
  enforceCache(): Promise<void> {
    if (this.enforcing !== null) return this.enforcing;
    const enforcing = this.trimCache(this.cacheBudgetBytes)
      .catch((cause: unknown) => console.error("Failed to trim the streaming cache", cause))
      .finally(() => {
        if (this.enforcing === enforcing) this.enforcing = null;
      });
    this.enforcing = enforcing;
    return enforcing;
  }

  /** Empties the streaming cache now. */
  async clearCache(): Promise<void> {
    await this.trimCache(0);
    this.onSpaceFreed();
  }

  async usage(): Promise<StorageUsage> {
    const space = await this.space();
    let downloadBytes = 0;
    for (const file of this.files.values()) if (file.pins > 0) downloadBytes += file.store.bytes;
    return {
      downloadBytes,
      cacheBytes: this.cacheBytes(),
      freeBytes: space.freeBytes,
      totalBytes: space.totalBytes,
      minimumFreeBytes: this.minimumFreeBytes(space.totalBytes),
    };
  }

  /** Whether free space allows downloads to carry on, with a margin so they do not stop and start. */
  async hasRoomToResume(): Promise<boolean> {
    const space = await this.space();
    const margin = Math.ceil(space.totalBytes / 100);
    return (
      space.freeBytes >=
      this.minimumFreeBytes(space.totalBytes) + margin + this.geometry.segmentBytes
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.files.values()].map((file) => file.close()));
  }
}
