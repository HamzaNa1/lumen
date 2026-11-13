import fs from "node:fs/promises";
import { join, relative } from "node:path";
import type { ObservedFile, RootObservation } from "./LibraryDiff";

const mediaExtensions = new Set([
  ".3g2",
  ".3gp",
  ".aac",
  ".ac3",
  ".aif",
  ".aiff",
  ".alac",
  ".ape",
  ".asf",
  ".avi",
  ".divx",
  ".dts",
  ".f4v",
  ".flac",
  ".flv",
  ".m2ts",
  ".m2v",
  ".m4a",
  ".m4v",
  ".mka",
  ".mkv",
  ".mov",
  ".mp2",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".mxf",
  ".oga",
  ".ogg",
  ".ogv",
  ".opus",
  ".rm",
  ".rmvb",
  ".ts",
  ".vob",
  ".wav",
  ".webm",
  ".wma",
  ".wmv",
]);

const audioExtensions = new Set([
  ".aac",
  ".ac3",
  ".aif",
  ".aiff",
  ".alac",
  ".ape",
  ".dts",
  ".flac",
  ".m4a",
  ".mka",
  ".mp2",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
]);

const extensionOf = (path: string): string => path.slice(path.lastIndexOf(".")).toLowerCase();

const isMedia = (path: string): boolean => mediaExtensions.has(extensionOf(path));

export const mediaKind = (path: string): "video" | "audio" | null =>
  !isMedia(path) ? null : audioExtensions.has(extensionOf(path)) ? "audio" : "video";

export const observeRoot = async (
  root: { readonly id: string; readonly path: string },
  warn: (path: string, cause: unknown) => void,
): Promise<RootObservation> => {
  const files = new Map<string, ObservedFile>();
  const unreadable: string[] = [];
  const walk = async (
    current: string,
    entries: Awaited<ReturnType<typeof readEntries>>,
  ): Promise<void> => {
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(current, entry.name);
      if (!entry.isDirectory() && (!entry.isFile() || !isMedia(entry.name))) continue;
      try {
        // Recheck the entry: it may have become a symlink since readdir.
        const details = await fs.lstat(absolutePath);
        if (details.isSymbolicLink()) continue;
        if (details.isDirectory()) await walk(absolutePath, await readEntries(absolutePath));
        else if (details.isFile())
          files.set(absolutePath, {
            rootId: root.id,
            absolutePath,
            relativePath: relative(root.path, absolutePath),
            fileSizeBytes: details.size,
            modifiedAtMs: Math.trunc(details.mtimeMs),
            inode: String(details.ino),
            device: String(details.dev),
          });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        unreadable.push(absolutePath);
        warn(absolutePath, cause);
      }
    }
  };
  let entries: Awaited<ReturnType<typeof readEntries>>;
  try {
    entries = await readEntries(root.path);
  } catch (cause) {
    warn(root.path, cause);
    return { rootId: root.id, result: "unavailable", files, unreadable };
  }
  await walk(root.path, entries);
  return {
    rootId: root.id,
    result: entries.length === 0 ? "empty-unconfirmed" : "complete",
    files,
    unreadable,
  };
};

const readEntries = (path: string) => fs.readdir(path, { withFileTypes: true });
