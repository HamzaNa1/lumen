import { readFile } from "node:fs/promises";
import { type DiskSpace, defaultGeometry, MediaStore } from "./MediaStore";

const positive = (value: string | undefined): number | null => {
  const number = Number(value);
  return value !== undefined && Number.isSafeInteger(number) && number > 0 ? number : null;
};

/**
 * Opens the store under the app's data folder. Tests shrink its chunks to exercise many of them
 * with small fixtures, and describe a disk of their own size to reach its free-space limit.
 */
export const openMediaStore = async (root: string): Promise<MediaStore> => {
  const chunkBytes = positive(process.env.LUMEN_E2E_MEDIA_CHUNK_BYTES);
  const segmentBytes = positive(process.env.LUMEN_E2E_MEDIA_SEGMENT_BYTES);
  const diskFile = process.env.LUMEN_E2E_DISK_FILE;
  return MediaStore.load({
    root,
    geometry: {
      chunkBytes: chunkBytes ?? defaultGeometry.chunkBytes,
      segmentBytes: segmentBytes ?? defaultGeometry.segmentBytes,
    },
    ...(diskFile === undefined || diskFile === ""
      ? {}
      : {
          space: async (store): Promise<DiskSpace> => {
            const disk = JSON.parse(await readFile(diskFile, "utf8")) as DiskSpace;
            let held = 0;
            for (const file of store.all) held += file.store.bytes;
            return { totalBytes: disk.totalBytes, freeBytes: Math.max(0, disk.freeBytes - held) };
          },
        }),
  });
};
