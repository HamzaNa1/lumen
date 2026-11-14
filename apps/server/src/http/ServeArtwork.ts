import { createHash } from "node:crypto";
import { artworkWidth } from "@lumen/contracts";
import { readLocalFile } from "../core/BoundedInput";
import { notFound } from "../core/Errors";
import type { ArtworkVariants } from "../media/ArtworkVariants";
import type { ArtworkFile } from "../services/AssetService";
import { serveFile } from "./ServeFile";

// Matches the largest image the catalog accepts as artwork.
const MAX_REVISIONED_BYTES = 20 * 1024 * 1024;
const REVISION = /^[0-9a-f]{64}$/u;
const WIDTH = /^[1-9]\d{0,4}$/u;

const IMMUTABLE_ARTWORK_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** The step to scale to, or null when the request names none or the original is no wider. */
const scaledWidth = (requested: string | null, original: number): number | null => {
  if (requested === null || !WIDTH.test(requested)) return null;
  const width = artworkWidth(Number(requested));
  return width < original ? width : null;
};

/**
 * Answers a request for one image. A request naming a revision — the SHA-256 of the bytes it
 * expects — may be kept by the client for good, but only when the file still holds exactly those
 * bytes: the catalog learns of a replaced file at the next scan, so the file is hashed here rather
 * than trusted. A scaled variant was hashed when it was made, so it is served without that check.
 * Anything else is served to be revalidated on every use.
 */
export const serveArtwork = async (options: {
  readonly request: Request;
  readonly asset: ArtworkFile;
  readonly revision: string | null;
  readonly width: string | null;
  readonly variants: ArtworkVariants;
}): Promise<Response> => {
  const { request, asset, revision, variants } = options;
  // A browser profile can host different accounts; a private cache is not an account boundary.
  const headers = { vary: "Cookie, Authorization" };
  const image = (bytes: Uint8Array<ArrayBuffer>, mimeType: string, cacheControl: string) =>
    new Response(bytes, {
      headers: {
        ...headers,
        "cache-control": cacheControl,
        "content-type": mimeType,
        "content-length": String(bytes.length),
        "x-content-type-options": "nosniff",
      },
    });
  const immutable = (bytes: Uint8Array<ArrayBuffer>, mimeType: string, etag: string) => {
    const response = image(bytes, mimeType, IMMUTABLE_ARTWORK_CACHE_CONTROL);
    response.headers.set("etag", `"${etag}"`);
    return response;
  };
  if (revision !== null && REVISION.test(revision) && asset.size <= MAX_REVISIONED_BYTES) {
    const width = scaledWidth(options.width, asset.width);
    const variantTag = `${revision}-${width}`;
    if (width !== null) {
      const stored = await variants.stored(revision, width, asset.mimeType);
      if (stored !== null) return immutable(stored.bytes, stored.mimeType, variantTag);
    }
    const bytes = await readLocalFile(asset.path, MAX_REVISIONED_BYTES);
    if (bytes === null) throw notFound("Artwork is unavailable");
    // The hashed bytes are the ones sent or scaled, so a file replaced meanwhile cannot slip through.
    if (createHash("sha256").update(bytes).digest("hex") === revision) {
      const variant =
        width === null ? null : await variants.create(bytes, revision, width, asset.mimeType);
      // The original stands in, but is not kept under a URL that should soon answer smaller.
      if (variant === "busy") return image(bytes, asset.mimeType, "no-store");
      if (variant !== null) return immutable(variant.bytes, variant.mimeType, variantTag);
      return immutable(bytes, asset.mimeType, revision);
    }
  }
  return serveFile({
    headers,
    request,
    path: asset.path,
    size: asset.size,
    modifiedAtMs: asset.modifiedAtMs,
    mimeType: asset.mimeType,
  });
};
