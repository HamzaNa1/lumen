import type { FetchLike, ServerApi } from "@lumen/client";
import { parseArtworkUrl } from "../../shared/artworkUrl";

/** The part of an Electron session artwork needs: Chromium's fetch, and a way to empty its cache. */
export interface ArtworkSession {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly clearCache: () => Promise<void>;
}

/**
 * The on-disk partition holding one connection's images. Chromium keys its cache by URL alone, so
 * two accounts on one server must never share a partition.
 */
export const artworkPartition = (connectionId: string): string =>
  `persist:artwork-${encodeURIComponent(connectionId)}`;

/**
 * Loads artwork through Chromium's HTTP cache, which outlives the app, instead of Node's fetch,
 * which has none. Chromium stores, validates and evicts; the access token is still attached here
 * in the main process and never reaches the renderer.
 */
export class ArtworkCache {
  constructor(private readonly openSession: (partition: string) => ArtworkSession) {}

  /** A transport whose responses are kept for this connection alone. */
  transportFor(connectionId: string): FetchLike {
    const session = this.openSession(artworkPartition(connectionId));
    // Nothing but the request's own token identifies the account: the partition holds no cookies.
    return (input, init) => session.fetch(String(input), { ...init, credentials: "omit" });
  }

  /**
   * Answers a renderer's artwork URL for the active account. The image streams through as plain
   * bytes, so the renderer decodes it like any other and nothing holds a copy in JavaScript.
   */
  async respond(
    url: string,
    active: { readonly connectionId: string; readonly client: ServerApi } | null,
  ): Promise<Response> {
    const target = parseArtworkUrl(url);
    if (target === null || active === null) return new Response(null, { status: 404 });
    const answer = await active.client
      .artworkResponse(target.artwork, {
        width: target.width,
        transport: this.transportFor(active.connectionId),
      })
      .catch(() => null);
    if (answer === null) return new Response(null, { status: 404 });
    return new Response(answer.response.body, {
      headers: { "content-type": answer.mimeType, "x-content-type-options": "nosniff" },
    });
  }

  /** Drops everything kept for a connection that is being removed. */
  async forget(connectionId: string): Promise<void> {
    await this.openSession(artworkPartition(connectionId)).clearCache();
  }
}
