import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaFile } from "../../apps/desktop/src/main/media-store/MediaFile";
import { defaultGeometry, MediaStore } from "../../apps/desktop/src/main/media-store/MediaStore";
import { MediaPreload } from "../../apps/desktop/src/main/player/MediaPreload";
import { expect, test } from "./support/server";

const CHUNK = defaultGeometry.chunkBytes;

/**
 * A server holding one file, answering ranges as Lumen's server does. A request from the start
 * sends `headBytes` and then holds the rest back, as a long file is still arriving while the
 * player looks elsewhere in it.
 */
const serveFile = async (media: Buffer, revision: string, headBytes: number) => {
  const starts: number[] = [];
  const server: HttpServer = createServer((request, response) => {
    const match = /bytes=(\d+)-(\d*)/u.exec(request.headers.range ?? "");
    const start = Number(match?.[1] ?? 0);
    starts.push(start);
    const end = match?.[2] ? Number(match[2]) : media.length - 1;
    response.writeHead(206, {
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${media.length}`,
      etag: revision,
    });
    if (start === 0) response.write(media.subarray(0, Math.min(headBytes, end + 1)));
    else response.end(media.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    starts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

/**
 * A file streamed with no cache, as every desktop streams by default: what the player has read
 * is kept in memory only while it is near a reader.
 */
const streamedFile = async (sizeBytes: number, headBytes = sizeBytes) => {
  const media = randomBytes(sizeBytes);
  const revision = "revision-1";
  const upstream = await serveFile(media, revision, headBytes);
  const root = await mkdtemp(join(tmpdir(), "lumen-media-file-"));
  const spec = {
    serverId: "server",
    sourceId: "source",
    revision,
    sizeBytes,
    mimeType: "video/x-matroska",
  };
  // Counts the bytes the file takes from each response, which is what it pulls over the network.
  const requests: { start: number; bytes: number; ended: Promise<void> }[] = [];
  const taken = new EventEmitter();
  const fetchImpl = async (input: URL, init: RequestInit) => {
    const response = await fetch(input, init);
    const upstreamBody = response.body?.getReader();
    if (upstreamBody === undefined) return response;
    const range = new Headers(init.headers).get("range") ?? "";
    let finish = () => {};
    const request = {
      start: Number(/bytes=(\d+)/u.exec(range)?.[1]),
      bytes: 0,
      ended: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    requests.push(request);
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { value, done } = await upstreamBody.read();
            if (done) {
              finish();
              controller.close();
              return;
            }
            request.bytes += value.length;
            taken.emit("bytes");
            controller.enqueue(value);
          } catch (cause) {
            finish();
            controller.error(cause);
          }
        },
        async cancel(reason) {
          finish();
          await upstreamBody.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const file = await MediaFile.open({
    root,
    spec,
    geometry: defaultGeometry,
    allowSegment: async () => true,
    fetchImpl,
  });
  file.addSource({ origin: upstream.origin, path: "/media", token: "token", kind: "playback" });
  const read = async (start: number, end: number): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const bytes of file.read(start, end, new AbortController().signal))
      parts.push(bytes);
    return Buffer.concat(parts);
  };
  /** Reads from `start` until `bytes` have arrived, then leaves, as a player closes a request. */
  const readThenLeave = async (start: number, bytes: number): Promise<void> => {
    let received = 0;
    for await (const part of file.read(start, sizeBytes, new AbortController().signal)) {
      received += part.length;
      if (received >= bytes) break;
    }
  };
  /** Resolves once the response from `start` has ended or handed the file more than `limit`. */
  const settled = async (start: number, limit: number) => {
    const request = requests.find((candidate) => candidate.start === start);
    if (request === undefined) throw new Error(`No request from ${start}`);
    const overran = (async () => {
      while (request.bytes <= limit) await once(taken, "bytes");
    })();
    await Promise.race([request.ended, overran]);
    return request.bytes;
  };
  return {
    media,
    spec,
    file,
    upstream,
    read,
    readThenLeave,
    settled,
    dispose: async () => {
      await file.close();
      await upstream.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("a player that reads a file's index at its end can read the start again", async () => {
  // MPV opens a Matroska file at the start, reads its index from the end, then seeks back to
  // the first cluster. The start must still be readable after the reader at the end has gone by.
  const stream = await streamedFile(8 * CHUNK, 2.5 * CHUNK);
  try {
    const { media } = stream;
    await stream.readThenLeave(0, 2 * CHUNK);
    const tail = media.length - 700 * 1024;
    expect((await stream.read(tail, media.length)).equals(media.subarray(tail))).toBe(true);
    const cluster = 7899;
    expect(
      (await stream.read(cluster, cluster + CHUNK)).equals(
        media.subarray(cluster, cluster + CHUNK),
      ),
    ).toBe(true);
  } finally {
    await stream.dispose();
  }
});

test("seeking back to the start after playing on reads the start again", async () => {
  // Playback that has moved on lets go of what is behind it; seeking back must fetch it again.
  const stream = await streamedFile(8 * CHUNK);
  try {
    const { media } = stream;
    await stream.readThenLeave(0, 6 * CHUNK);
    expect((await stream.read(0, CHUNK)).equals(media.subarray(0, CHUNK))).toBe(true);
  } finally {
    await stream.dispose();
  }
});

test("a request the player left behind by seeking ahead stops fetching", async () => {
  // Resuming a film: MPV reads the header, then opens a request halfway in. The request from the
  // start must stop instead of racing to the new reader with bytes nobody reads.
  const stream = await streamedFile(64 * CHUNK);
  const resume = stream.file.read(48 * CHUNK, 64 * CHUNK, new AbortController().signal);
  try {
    await stream.readThenLeave(0, 2 * CHUNK);
    await resume.next();
    // At most the header and the window paced ahead of it, 16 MiB without a known bitrate.
    expect(await stream.settled(0, 20 * CHUNK)).toBeLessThanOrEqual(20 * CHUNK);
  } finally {
    await resume.return(undefined);
    await stream.dispose();
  }
});

test("the start and end of the next file, preloaded into memory, serve the player without the server", async () => {
  const stream = await streamedFile(20 * CHUNK);
  const preload = new MediaPreload(CHUNK);
  try {
    const { media, spec, file, upstream } = stream;
    const request = {
      origin: upstream.origin,
      path: "/media",
      token: "token",
      durationSeconds: null,
      held: () => false,
    };
    // A file that changed since the server described it is not held at all.
    expect(await preload.start({ ...request, spec: { ...spec, revision: "revision-0" } })).toEqual({
      bytes: 0,
      failed: true,
    });
    // Without a duration, the first 8 MiB and the last 4 MiB are held.
    expect(await preload.start({ ...request, spec })).toEqual({ bytes: 12 * CHUNK, failed: false });
    expect(preload.take({ ...spec, sourceId: "another" })).toBeNull();
    const chunks = preload.take(spec);
    expect(preload.take(spec)).toBeNull();
    expect(await file.adoptMemory(chunks ?? new Map())).toBe(12 * CHUNK);
    const fetched = upstream.starts.length;
    // The way MPV opens a file: the start, the index at the end, then the start again.
    await stream.readThenLeave(0, 2 * CHUNK);
    const tail = media.length - 700 * 1024;
    expect((await stream.read(tail, media.length)).equals(media.subarray(tail))).toBe(true);
    expect((await stream.read(0, 8 * CHUNK)).equals(media.subarray(0, 8 * CHUNK))).toBe(true);
    // The player only reached the server for what lies after the preloaded start.
    expect(upstream.starts.slice(fetched).every((start) => start >= 8 * CHUNK)).toBe(true);
    // Once no player reads the file, the preloaded bytes are let go.
    file.releaseMemory();
    expect((await stream.read(0, CHUNK)).equals(media.subarray(0, CHUNK))).toBe(true);
    expect(upstream.starts.slice(fetched)).toContain(0);
  } finally {
    preload.drop();
    await stream.dispose();
  }
});

test("playing a file again while the cache deletes it keeps the new copy", async () => {
  // Letting go of a streamed file hands it to the cache, which deletes it while the same item
  // can already be playing again, as it does when a viewer replays what just ended.
  const root = await mkdtemp(join(tmpdir(), "lumen-media-store-"));
  const store = await MediaStore.load({ root });
  const spec = {
    serverId: "server",
    sourceId: "source",
    revision: "revision-1",
    sizeBytes: 2 * CHUNK,
    mimeType: "video/mp4",
  };
  try {
    (await store.acquire(spec)).release();
    const replay = await store.acquire(spec);
    await store.enforceCache();
    expect(existsSync(replay.file.directory)).toBe(true);
    replay.release();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
