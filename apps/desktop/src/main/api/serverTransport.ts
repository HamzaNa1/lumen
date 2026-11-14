import type { FetchLike } from "@lumen/client";

export interface FetchingSession {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Reaches a server through Chromium's network stack, which keeps idle connections as long as the
 * server allows and speaks HTTP/2 or HTTP/3 to a TLS proxy, where a cancelled seek resets a stream
 * instead of closing a socket. Answers never come from Chromium's HTTP cache.
 */
export const serverTransport =
  (session: FetchingSession): FetchLike =>
  (input, init) =>
    session.fetch(String(input), { ...init, credentials: "omit", cache: "no-store" });
