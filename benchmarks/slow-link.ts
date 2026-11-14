import { request } from "node:http";
import { Transform } from "node:stream";
import { NetworkProxy } from "../tests/e2e/support/proxy";

/**
 * Puts a server behind a link where each request waits `rttMs` for its answer and every response
 * shares `megabitsPerSecond`. Records when each request reached the link and the range it asked.
 */
export const slowLink = async (upstream: string, rttMs: number, megabitsPerSecond: number) => {
  const proxy = await new NetworkProxy(upstream).start();
  const sent: { atMs: number; path: string; range: string | null }[] = [];
  let linkFreeAtMs = 0;
  const pace = () =>
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (megabitsPerSecond <= 0) return callback(null, chunk);
        const now = performance.now();
        linkFreeAtMs =
          Math.max(now, linkFreeAtMs) + (chunk.byteLength * 8) / (megabitsPerSecond * 1000);
        setTimeout(() => callback(null, chunk), linkFreeAtMs - now);
      },
    });
  proxy.intercept = async (incoming, response) => {
    sent.push({
      atMs: Date.now(),
      path: incoming.url ?? "/",
      range: incoming.headers.range ?? null,
    });
    await new Promise((resolve) => setTimeout(resolve, rttMs));
    const outbound = request(
      new URL(incoming.url ?? "/", upstream),
      { method: incoming.method, headers: incoming.headers },
      (remote) => {
        response.writeHead(remote.statusCode ?? 502, remote.headers);
        remote.pipe(pace()).pipe(response);
      },
    );
    outbound.on("error", () => response.destroy());
    response.on("close", () => outbound.destroy());
    incoming.pipe(outbound);
    return true;
  };
  return { origin: proxy.origin, sent, close: () => proxy.close() };
};

export const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};
