import { createHash } from "node:crypto";
import { readLocalFile } from "../core/BoundedInput";
import { notFound } from "../core/Errors";
import type { AssetFile } from "../services/AssetService";
import { serveFile } from "./ServeFile";

// Matches the largest image the catalog accepts as artwork.
const MAX_REVISIONED_BYTES = 20 * 1024 * 1024;
const REVISION = /^[0-9a-f]{64}$/u;

const IMMUTABLE_ARTWORK_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * Answers a request for one image. A request naming a revision — the SHA-256 of the bytes it
 * expects — may be kept by the client for good, but only when the file still holds exactly those
 * bytes: the catalog learns of a replaced file at the next scan, so the file is hashed here rather
 * than trusted. Anything else is served to be revalidated on every use.
 */
export const serveArtwork = async (options: {
  readonly request: Request;
  readonly asset: AssetFile;
  readonly revision: string | null;
}): Promise<Response> => {
  const { request, asset, revision } = options;
  // A browser profile can host different accounts; a private cache is not an account boundary.
  const headers = { vary: "Cookie, Authorization" };
  if (revision !== null && REVISION.test(revision) && asset.size <= MAX_REVISIONED_BYTES) {
    const bytes = await readLocalFile(asset.path, MAX_REVISIONED_BYTES);
    if (bytes === null) throw notFound("Artwork is unavailable");
    if (createHash("sha256").update(bytes).digest("hex") === revision)
      // The hashed bytes are the ones sent, so a file replaced meanwhile cannot slip through.
      return new Response(bytes, {
        headers: {
          ...headers,
          "cache-control": IMMUTABLE_ARTWORK_CACHE_CONTROL,
          etag: `"${revision}"`,
          "content-type": asset.mimeType,
          "content-length": String(bytes.length),
          "x-content-type-options": "nosniff",
        },
      });
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
