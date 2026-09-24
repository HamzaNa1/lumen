import { readLocalFile } from "./BoundedInput";

export interface LocalMetadata {
  readonly title?: string;
  readonly overview?: string;
  readonly year?: number;
  readonly releaseDate?: string;
  readonly contentRating?: string;
  readonly communityRating?: number;
  readonly genres?: string[];
  readonly studios?: string[];
  readonly tags?: string[];
  readonly externalIds?: Record<string, string>;
}

const decode = (value: string): string => value
  .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity) => {
    const names: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (names[entity] !== undefined) return names[entity];
    const radix = entity.startsWith("&#x") ? 16 : 10;
    const value = Number.parseInt(entity.slice(radix === 16 ? 3 : 2, -1), radix);
    return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
  }).trim();

const values = (xml: string, tag: string): string[] => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "giu"))]
  .map((match) => decode((match[1] ?? "").replace(/<[^>]*>/gu, ""))).filter(Boolean);

export const readLocalNfo = async (path: string): Promise<LocalMetadata | null> => {
  try {
    const bytes = await readLocalFile(path, 256 * 1024);
    if (bytes === null) return null;
    const xml = new TextDecoder().decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return null;
    const first = (tag: string) => values(xml, tag)[0];
    const year = Number(first("year") ?? first("premiered")?.slice(0, 4));
    const rating = Number(first("rating"));
    const externalIds: Record<string, string> = {};
    for (const match of xml.matchAll(/<uniqueid\s+type=["']([^"']+)["'][^>]*>([^<]+)<\/uniqueid>/giu)) {
      if (match[1] && match[2]) externalIds[match[1].toLowerCase()] = decode(match[2]);
    }
    const tmdb = first("tmdbid");
    if (tmdb) externalIds.tmdb = tmdb;
    return {
      title: first("title"), overview: first("plot") ?? first("outline"),
      year: Number.isInteger(year) && year >= 1800 && year <= 9999 ? year : undefined,
      releaseDate: first("premiered") ?? first("releasedate"),
      contentRating: first("mpaa") ?? first("contentrating"),
      communityRating: Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : undefined,
      genres: values(xml, "genre"), studios: values(xml, "studio"), tags: values(xml, "tag"), externalIds,
    };
  } catch {
    return null;
  }
};
