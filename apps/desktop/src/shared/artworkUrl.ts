import { ARTWORK_WIDTHS, ArtworkRef } from "@lumen/contracts";
import { Option, Schema } from "effect";

/** The scheme the main process answers artwork on, for the active account. */
export const ARTWORK_SCHEME = "lumen-artwork";

/** Where the renderer loads an image. Only the main process holds the token to fetch it. */
export const artworkUrl = (artwork: ArtworkRef, width: number): string => {
  const query = new URLSearchParams({ width: String(width) });
  if (artwork.revision !== null) query.set("revision", artwork.revision);
  return `${ARTWORK_SCHEME}://artwork/${encodeURIComponent(artwork.id)}?${query.toString()}`;
};

const decodeRef = Schema.decodeUnknownOption(ArtworkRef);

/** The image a URL from `artworkUrl` names, or null for anything else. */
export const parseArtworkUrl = (
  value: string,
): { readonly artwork: ArtworkRef; readonly width: number } | null => {
  const url = URL.parse(value);
  if (url?.protocol !== `${ARTWORK_SCHEME}:` || url.host !== "artwork") return null;
  const width = ARTWORK_WIDTHS.find((step) => String(step) === url.searchParams.get("width"));
  const artwork = Option.getOrNull(
    decodeRef({ id: url.pathname.slice(1), revision: url.searchParams.get("revision") }),
  );
  return width === undefined || artwork === null ? null : { artwork, width };
};
