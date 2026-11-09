/**
 * Which fixed-size chunks of one file are held. A chunk is only marked once every one of its bytes
 * is stored, so a marked chunk can always be served whole; the last chunk may be shorter.
 */
export class ChunkMap {
  readonly count: number;
  private readonly bits: Uint8Array;
  private held = 0;

  constructor(
    readonly sizeBytes: number,
    readonly chunkBytes: number,
    encoded?: string,
  ) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error("Invalid file size");
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("Invalid chunk size");
    this.count = Math.ceil(sizeBytes / chunkBytes);
    this.bits = new Uint8Array(Math.ceil(this.count / 8));
    if (encoded !== undefined) {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      if (bytes.length !== this.bits.length) throw new Error("Chunk map does not match the file");
      for (let index = 0; index < this.count; index += 1)
        if (((bytes[index >> 3] ?? 0) & (1 << (index & 7))) !== 0) this.set(index);
    }
  }

  get heldCount(): number {
    return this.held;
  }

  get complete(): boolean {
    return this.held === this.count;
  }

  /** Bytes in held chunks. */
  get heldBytes(): number {
    if (this.held === 0) return 0;
    const last = this.count - 1;
    return (
      this.held * this.chunkBytes - (this.has(last) ? this.chunkBytes - this.lengthOf(last) : 0)
    );
  }

  has(index: number): boolean {
    return (
      index >= 0 && index < this.count && ((this.bits[index >> 3] ?? 0) & (1 << (index & 7))) !== 0
    );
  }

  set(index: number): void {
    if (index < 0 || index >= this.count || this.has(index)) return;
    this.bits[index >> 3] = (this.bits[index >> 3] ?? 0) | (1 << (index & 7));
    this.held += 1;
  }

  clear(index: number): void {
    if (!this.has(index)) return;
    this.bits[index >> 3] = (this.bits[index >> 3] ?? 0) & ~(1 << (index & 7));
    this.held -= 1;
  }

  chunkOf(offset: number): number {
    return Math.floor(offset / this.chunkBytes);
  }

  startOf(index: number): number {
    return index * this.chunkBytes;
  }

  /** Where a chunk ends, exclusive. */
  endOf(index: number): number {
    return Math.min(this.sizeBytes, (index + 1) * this.chunkBytes);
  }

  lengthOf(index: number): number {
    return this.endOf(index) - this.startOf(index);
  }

  /** The first chunk from `from` (inclusive) to `to` (exclusive) that is missing, or -1. */
  nextMissing(from: number, to = this.count): number {
    for (let index = Math.max(0, from); index < Math.min(to, this.count); index += 1)
      if (!this.has(index)) return index;
    return -1;
  }

  /** Where the held bytes starting at `offset` run out, exclusive; `offset` itself if none are. */
  heldUntil(offset: number): number {
    let index = this.chunkOf(offset);
    while (index < this.count && this.has(index)) index += 1;
    return Math.max(offset, Math.min(this.sizeBytes, index * this.chunkBytes));
  }

  /** Held bytes as merged [start, end) ranges. */
  ranges(): ReadonlyArray<readonly [number, number]> {
    const ranges: [number, number][] = [];
    for (let index = 0; index < this.count; index += 1) {
      if (!this.has(index)) continue;
      const last = ranges.at(-1);
      if (last !== undefined && last[1] === this.startOf(index)) last[1] = this.endOf(index);
      else ranges.push([this.startOf(index), this.endOf(index)]);
    }
    return ranges;
  }

  encode(): string {
    let text = "";
    for (const byte of this.bits) text += String.fromCharCode(byte);
    return btoa(text);
  }
}

/**
 * The next chunk a download should fetch. A player reads a file's index first, and many formats
 * keep it at the end, so the first and last few chunks come first; then everything from where
 * the viewer is watching onwards, and finally whatever lies before it.
 */
export const nextChunkToDownload = (
  map: ChunkMap,
  focusOffset: number,
  indexBytes: { readonly head: number; readonly tail: number },
): number => {
  const head = Math.min(map.count, Math.ceil(indexBytes.head / map.chunkBytes));
  const tail = Math.max(0, map.count - Math.ceil(indexBytes.tail / map.chunkBytes));
  const focus = Math.min(map.count, Math.max(0, map.chunkOf(focusOffset)));
  for (const [from, to] of [
    [0, head],
    [tail, map.count],
    [focus, map.count],
    [0, focus],
  ] as const) {
    const index = map.nextMissing(from, to);
    if (index !== -1) return index;
  }
  return -1;
};
