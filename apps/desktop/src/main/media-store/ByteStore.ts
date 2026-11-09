import { type FileHandle, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ignoreFailure } from "../failures";

/** A write needed a new segment and the disk was too full to allow it. */
export class SpaceExhausted extends Error {
  constructor() {
    super("The disk is almost full");
  }
}

/** Where one file's bytes are held, addressed by their offset in the file. */
export interface ByteStore {
  readonly write: (offset: number, data: Uint8Array) => Promise<void>;
  /** Reads exactly `length` bytes, or fails when any of them is not held. */
  readonly read: (offset: number, length: number) => Promise<Buffer>;
  readonly close: () => Promise<void>;
}

const segmentName = (index: number): string => `seg-${String(index).padStart(6, "0")}.bin`;

/**
 * Keeps a file as fixed-size segment files rather than one sparse file: a write far into the file
 * allocates only its own segment on every filesystem, and the cache can give back space a segment
 * at a time.
 */
export class DiskByteStore implements ByteStore {
  private readonly handles = new Map<number, Promise<FileHandle>>();
  private readonly dirty = new Set<number>();
  private readonly known = new Map<number, number>();

  private constructor(
    readonly directory: string,
    readonly segmentBytes: number,
    /** Asked before a segment is first created; refusing it makes the write fail. */
    private readonly allowSegment: () => Promise<boolean>,
  ) {}

  static async open(
    directory: string,
    segmentBytes: number,
    allowSegment: () => Promise<boolean>,
  ): Promise<DiskByteStore> {
    const store = new DiskByteStore(directory, segmentBytes, allowSegment);
    for (const name of await readdir(directory).catch(() => [])) {
      const match = /^seg-(\d{6})\.bin$/u.exec(name);
      if (match === null) continue;
      const size = await stat(join(directory, name))
        .then((details) => details.size)
        .catch(() => null);
      if (size !== null) store.known.set(Number(match[1]), size);
    }
    return store;
  }

  /** How many bytes each segment file holds, as far as this store has seen. */
  get segments(): ReadonlyMap<number, number> {
    return this.known;
  }

  get bytes(): number {
    let total = 0;
    for (const size of this.known.values()) total += size;
    return total;
  }

  private handle(index: number, create: boolean): Promise<FileHandle> {
    const existing = this.handles.get(index);
    if (existing !== undefined) return existing;
    const opening = (async () => {
      const path = join(this.directory, segmentName(index));
      if (!this.known.has(index)) {
        if (!create) throw new Error("Segment is not held");
        if (!(await this.allowSegment())) throw new SpaceExhausted();
        const handle = await open(path, "w+");
        this.known.set(index, 0);
        return handle;
      }
      return open(path, "r+");
    })();
    this.handles.set(index, opening);
    opening.catch(() => {
      if (this.handles.get(index) === opening) this.handles.delete(index);
    });
    return opening;
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    let written = 0;
    while (written < data.length) {
      const position = offset + written;
      const index = Math.floor(position / this.segmentBytes);
      const within = position - index * this.segmentBytes;
      const length = Math.min(data.length - written, this.segmentBytes - within);
      const handle = await this.handle(index, true);
      let done = 0;
      while (done < length) {
        const result = await handle.write(data, written + done, length - done, within + done);
        done += result.bytesWritten;
      }
      this.known.set(index, Math.max(this.known.get(index) ?? 0, within + length));
      this.dirty.add(index);
      written += length;
    }
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const position = offset + filled;
      const index = Math.floor(position / this.segmentBytes);
      const within = position - index * this.segmentBytes;
      const wanted = Math.min(length - filled, this.segmentBytes - within);
      const handle = await this.handle(index, false);
      const { bytesRead } = await handle.read(buffer, filled, wanted, within);
      if (bytesRead === 0) throw new Error("Segment ended early");
      filled += bytesRead;
    }
    return buffer;
  }

  /** Makes everything written so far survive a crash before it is recorded as held. */
  async flush(): Promise<void> {
    const pending = [...this.dirty];
    this.dirty.clear();
    for (const index of pending) {
      const handle = this.handles.get(index);
      if (handle !== undefined) await (await handle).datasync().catch(ignoreFailure);
    }
  }

  /** Deletes one segment. Its handle is closed first, which Windows requires. */
  async dropSegment(index: number): Promise<void> {
    const handle = this.handles.get(index);
    this.handles.delete(index);
    this.dirty.delete(index);
    this.known.delete(index);
    await (await handle?.catch(() => null))?.close().catch(ignoreFailure);
    await rm(join(this.directory, segmentName(index)), { force: true });
  }

  async close(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles)
      await (await handle.catch(() => null))?.close().catch(ignoreFailure);
  }
}

/**
 * Holds bytes only in memory, for streams nothing is kept from. The player reads close behind
 * what is fetched, so only a window around it is ever held.
 */
export class MemoryByteStore implements ByteStore {
  private readonly chunks = new Map<number, Buffer>();

  constructor(private readonly chunkBytes: number) {}

  async write(offset: number, data: Uint8Array): Promise<void> {
    let written = 0;
    while (written < data.length) {
      const position = offset + written;
      const index = Math.floor(position / this.chunkBytes);
      const within = position - index * this.chunkBytes;
      const length = Math.min(data.length - written, this.chunkBytes - within);
      let chunk = this.chunks.get(index);
      if (chunk === undefined) {
        chunk = Buffer.alloc(this.chunkBytes);
        this.chunks.set(index, chunk);
      }
      chunk.set(data.subarray(written, written + length), within);
      written += length;
    }
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const position = offset + filled;
      const index = Math.floor(position / this.chunkBytes);
      const within = position - index * this.chunkBytes;
      const wanted = Math.min(length - filled, this.chunkBytes - within);
      const chunk = this.chunks.get(index);
      if (chunk === undefined) throw new Error("Chunk is not held");
      chunk.copy(buffer, filled, within, within + wanted);
      filled += wanted;
    }
    return buffer;
  }

  dropChunk(index: number): void {
    this.chunks.delete(index);
  }

  async close(): Promise<void> {
    this.chunks.clear();
  }
}
