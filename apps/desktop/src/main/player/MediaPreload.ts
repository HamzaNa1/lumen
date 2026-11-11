import { ignoreFailure } from "../failures";
import { type MediaSpec, mediaKey, rangeRequest, servesRange } from "../media-store/MediaFile";

const HEAD_SECONDS = 15;
const MIN_HEAD_BYTES = 8 * 1024 * 1024;
const MAX_HEAD_BYTES = 48 * 1024 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The chunks a player reads before it shows a frame: the first seconds of the file, and its end,
 * where a Matroska or MP4 index often sits.
 */
export const preloadChunks = (
  sizeBytes: number,
  durationSeconds: number | null,
  chunkBytes: number,
): ReadonlyArray<number> => {
  const byRate =
    durationSeconds === null || durationSeconds <= 0
      ? MIN_HEAD_BYTES
      : Math.round((sizeBytes / durationSeconds) * HEAD_SECONDS);
  const head = Math.min(sizeBytes, MAX_HEAD_BYTES, Math.max(MIN_HEAD_BYTES, byRate));
  const count = Math.ceil(sizeBytes / chunkBytes);
  const chunks = new Set<number>();
  for (let chunk = 0; chunk * chunkBytes < head; chunk += 1) chunks.add(chunk);
  for (let chunk = Math.floor(Math.max(0, sizeBytes - TAIL_BYTES) / chunkBytes); chunk < count; )
    chunks.add(chunk++);
  return [...chunks].sort((a, b) => a - b);
};

export interface PreloadRequest {
  readonly spec: MediaSpec;
  readonly origin: string;
  readonly path: string;
  readonly token: string;
  readonly durationSeconds: number | null;
  /** Chunks this device already keeps, which are not fetched again. */
  readonly held: (chunk: number) => boolean;
}

export interface PreloadOutcome {
  readonly bytes: number;
  readonly failed: boolean;
}

interface Pending {
  readonly key: string;
  readonly chunks: Map<number, Buffer>;
  readonly controller: AbortController;
}

/**
 * The start and end of the item a viewer will likely play next, held in memory and nowhere else
 * until the player opens that file and takes them. One file at a time; nothing is retried.
 */
export class MediaPreload {
  private pending: Pending | null = null;

  constructor(
    private readonly chunkBytes: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Replaces whatever is held with the chunks of `request`, settling once they are fetched. */
  async start(request: PreloadRequest): Promise<PreloadOutcome> {
    this.drop();
    const { spec } = request;
    const pending: Pending = {
      key: mediaKey(spec),
      chunks: new Map(),
      controller: new AbortController(),
    };
    this.pending = pending;
    const wanted = preloadChunks(spec.sizeBytes, request.durationSeconds, this.chunkBytes).filter(
      (chunk) => !request.held(chunk),
    );
    let bytes = 0;
    try {
      for (const run of runsOf(wanted)) {
        bytes += await this.fetchRun(request, pending, run);
      }
      return { bytes, failed: false };
    } catch {
      return { bytes, failed: true };
    }
  }

  /** Hands over what is held for this file, if anything, and lets it go. */
  take(
    spec: Pick<MediaSpec, "serverId" | "sourceId" | "revision">,
  ): ReadonlyMap<number, Buffer> | null {
    const pending = this.pending;
    if (pending === null || pending.key !== mediaKey(spec)) return null;
    this.drop();
    return pending.chunks;
  }

  drop(): void {
    this.pending?.controller.abort();
    this.pending = null;
  }

  private async fetchRun(
    request: PreloadRequest,
    pending: Pending,
    [first, last]: readonly [number, number],
  ): Promise<number> {
    const { spec } = request;
    const start = first * this.chunkBytes;
    const end = Math.min(spec.sizeBytes, (last + 1) * this.chunkBytes);
    const response = await this.fetchImpl(
      new URL(request.path, request.origin),
      rangeRequest(request.token, start, end, pending.controller.signal),
    );
    if (
      response.status !== 206 ||
      !servesRange(response, spec, start, end) ||
      response.body === null
    ) {
      await response.body?.cancel().catch(ignoreFailure);
      throw new Error(`Preload was refused (HTTP ${response.status})`);
    }
    const reader = response.body.getReader();
    let chunk = first;
    let buffer = Buffer.allocUnsafe(Math.min(this.chunkBytes, end - start));
    let filled = 0;
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.length && chunk <= last) {
          const length = Math.min(value.length - offset, buffer.length - filled);
          buffer.set(value.subarray(offset, offset + length), filled);
          filled += length;
          offset += length;
          if (filled < buffer.length) continue;
          pending.chunks.set(chunk, buffer);
          bytes += buffer.length;
          chunk += 1;
          const chunkStart = chunk * this.chunkBytes;
          buffer = Buffer.allocUnsafe(Math.max(0, Math.min(this.chunkBytes, end - chunkStart)));
          filled = 0;
        }
      }
    } finally {
      await reader.cancel().catch(ignoreFailure);
    }
    if (chunk <= last) throw new Error("Preload ended early");
    return bytes;
  }
}

/** Consecutive chunks, as the first and last of each run. */
const runsOf = (chunks: ReadonlyArray<number>): ReadonlyArray<readonly [number, number]> => {
  const runs: Array<[number, number]> = [];
  for (const chunk of chunks) {
    const run = runs.at(-1);
    if (run !== undefined && run[1] === chunk - 1) run[1] = chunk;
    else runs.push([chunk, chunk]);
  }
  return runs;
};
