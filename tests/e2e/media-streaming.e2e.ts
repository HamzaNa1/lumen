import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaFile } from "../../apps/desktop/src/main/media-store/MediaFile";
import { defaultGeometry } from "../../apps/desktop/src/main/media-store/MediaStore";
import { expect, test } from "./support/server";

const CHUNK = defaultGeometry.chunkBytes;

/**
 * A server holding one file, answering ranges as Lumen's server does. A request from the start
 * sends `headBytes` and then holds the rest back, as a long file is still arriving while the
 * player looks elsewhere in it.
 */
const serveFile = async (media: Buffer, revision: string, headBytes: number) => {
  const server: HttpServer = createServer((request, response) => {
    const match = /bytes=(\d+)-(\d*)/u.exec(request.headers.range ?? "");
    const start = Number(match?.[1] ?? 0);
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
  const file = await MediaFile.open({
    root,
    spec: {
      serverId: "server",
      sourceId: "source",
      revision,
      sizeBytes,
      mimeType: "video/x-matroska",
    },
    geometry: defaultGeometry,
    allowSegment: async () => true,
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
  return {
    media,
    read,
    readThenLeave,
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
