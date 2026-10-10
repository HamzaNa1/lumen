import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const readLocalFile = async (path: string, maxBytes: number): Promise<Uint8Array | null> => {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = await file.stat();
      if (!details.isFile() || details.size > maxBytes) return null;
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length <= maxBytes) {
        const bytes = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - length));
        const read = await file.read(bytes, 0, bytes.length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
        if (length > maxBytes) return null;
        chunks.push(bytes.subarray(0, read.bytesRead));
      }
      return Buffer.concat(chunks, length);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
};

export const readResponseBytes = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  if (response.body === null) throw new Error("Response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeded the size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
