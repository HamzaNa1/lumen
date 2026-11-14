import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLocalFile, readResponseBytes } from "../core/BoundedInput";
import { imageInfo } from "./ImageInfo";

/** Scaled copies of artwork, each named by the revision it was made from and its width. */
export const artworkVariantDir = (dataDir: string): string => join(dataDir, "artwork-variants");
export const ARTWORK_VARIANT_NAME = /^([0-9a-f]{64})-\d+\.(?:jpg|png)$/u;

const MAX_VARIANT_BYTES = 20 * 1024 * 1024;
const SCALE_TIMEOUT_MS = 30_000;
// Each scale is a short FFmpeg process; more than this many waiting are served the original.
const CONCURRENT_SCALES = 2;
const WAITING_SCALES = 64;

export interface ArtworkVariant {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
}

// PNG and WebP become PNG, which keeps transparency and which every FFmpeg build can write.
const formatFor = (mimeType: string) =>
  mimeType === "image/jpeg"
    ? { mimeType, extension: "jpg", codec: ["-c:v", "mjpeg", "-q:v", "3"] }
    : { mimeType: "image/png", extension: "png", codec: ["-c:v", "png"] };

const demuxers: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg_pipe",
  "image/png": "png_pipe",
  "image/webp": "webp_pipe",
};

const scale = async (
  ffmpeg: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  width: number,
): Promise<Uint8Array | null> => {
  const demuxer = demuxers[mimeType];
  if (demuxer === undefined) return null;
  const child = Bun.spawn(
    [
      ffmpeg,
      "-v",
      "error",
      "-protocol_whitelist",
      "pipe",
      "-f",
      demuxer,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-2:flags=lanczos`,
      ...formatFor(mimeType).codec,
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { stdin: new Blob([bytes]), stdout: "pipe", stderr: "ignore" },
  );
  const timer = setTimeout(() => child.kill(), SCALE_TIMEOUT_MS);
  try {
    const output = await readResponseBytes(new Response(child.stdout), MAX_VARIANT_BYTES);
    return (await child.exited) === 0 ? output : null;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
};

/**
 * Scales artwork once and keeps the result in the data directory. A variant is named by the
 * revision of the bytes it was scaled from, so it answers for that revision without the original
 * being read or hashed again.
 */
export class ArtworkVariants {
  readonly #pending = new Map<string, Promise<ArtworkVariant | "busy" | null>>();
  readonly #waiting: Array<() => void> = [];
  #running = 0;

  constructor(
    private readonly options: {
      readonly dataDir: string;
      readonly ffmpeg: () => Promise<string>;
    },
  ) {}

  #path(revision: string, width: number, mimeType: string): string {
    return join(
      artworkVariantDir(this.options.dataDir),
      `${revision}-${width}.${formatFor(mimeType).extension}`,
    );
  }

  /** The variant made earlier for this revision and width, if there is one. */
  async stored(revision: string, width: number, mimeType: string): Promise<ArtworkVariant | null> {
    const bytes = await readLocalFile(this.#path(revision, width, mimeType), MAX_VARIANT_BYTES);
    return bytes === null ? null : { bytes, mimeType: formatFor(mimeType).mimeType };
  }

  /**
   * Scales bytes the caller has checked against their revision. "busy" means too many scales are
   * already waiting; null means FFmpeg could not scale this image.
   */
  async create(
    bytes: Uint8Array<ArrayBuffer>,
    revision: string,
    width: number,
    mimeType: string,
  ): Promise<ArtworkVariant | "busy" | null> {
    const path = this.#path(revision, width, mimeType);
    const pending = this.#pending.get(path);
    if (pending !== undefined) return pending;
    const making = (async () => {
      const release = await this.#slot();
      if (release === null) return "busy" as const;
      try {
        return await this.#make(bytes, path, width, mimeType);
      } finally {
        release();
      }
    })().finally(() => this.#pending.delete(path));
    this.#pending.set(path, making);
    return making;
  }

  async #make(
    bytes: Uint8Array<ArrayBuffer>,
    path: string,
    width: number,
    mimeType: string,
  ): Promise<ArtworkVariant | null> {
    const scaled = await scale(await this.options.ffmpeg(), bytes, mimeType, width).catch(
      () => null,
    );
    if (scaled === null || imageInfo(scaled)?.width !== width) return null;
    const variant = { bytes: new Uint8Array(scaled), mimeType: formatFor(mimeType).mimeType };
    // Written aside and renamed, so a reader never sees half a file under the final name.
    const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
    await mkdir(artworkVariantDir(this.options.dataDir), { recursive: true })
      .then(() => writeFile(partial, variant.bytes, { flag: "wx" }))
      .then(() => rename(partial, path))
      .catch(() => rm(partial, { force: true }));
    return variant;
  }

  async #slot(): Promise<(() => void) | null> {
    if (this.#running < CONCURRENT_SCALES) this.#running += 1;
    else if (this.#waiting.length >= WAITING_SCALES) return null;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    // A finished scale hands its slot straight to the next one waiting.
    return () => {
      const next = this.#waiting.shift();
      if (next === undefined) this.#running -= 1;
      else next();
    };
  }
}
