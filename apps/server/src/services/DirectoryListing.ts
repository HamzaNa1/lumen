import type { Dirent } from "node:fs";
import { opendir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import type { DirectoryListing } from "@lumen/contracts";
import { conflict, internal, notFound, type ServerError } from "../core/Errors";
import { canonicalPath, isPathWithin } from "../core/Paths";
import { mediaKind } from "./LibraryObservation";

// A folder with more entries than this is listed in part, so one request stays bounded.
const entryLimit = 2000;
const concurrency = 64;

interface Root {
  readonly rootId: string;
  readonly libraryId: string;
  readonly libraryName: string;
  readonly path: string;
}

// Reading from the folder is the only check that matches what a scan can read on every
// platform: fs.access ignores Windows ACLs, and Bun's opendir does not open until the first read.
const canOpen = async (path: string): Promise<boolean> => {
  try {
    const directory = await opendir(path);
    try {
      await directory.read();
      return true;
    } finally {
      await directory.close();
    }
  } catch {
    return false;
  }
};

type Described =
  | { readonly type: "directory"; readonly name: string; readonly path: string }
  | {
      readonly type: "file";
      readonly name: string;
      readonly size: number;
      readonly kind: "video" | "audio";
    }
  | null;

const describe = async (parent: string, entry: Dirent): Promise<Described> => {
  const path = join(parent, entry.name);
  let isDirectory = entry.isDirectory();
  let isFile = entry.isFile();
  if (entry.isSymbolicLink()) {
    const target = await stat(path).catch(() => null);
    isDirectory = target?.isDirectory() ?? false;
    isFile = target?.isFile() ?? false;
  }
  if (isDirectory)
    return (await canOpen(path)) ? { type: "directory", name: entry.name, path } : null;
  const kind = isFile ? mediaKind(entry.name) : null;
  if (kind === null) return null;
  const file = await stat(path).catch(() => null);
  return file === null ? null : { type: "file", name: entry.name, size: file.size, kind };
};

const trailOf = (path: string): DirectoryListing["trail"] => {
  const trail: Array<DirectoryListing["trail"][number]> = [];
  for (let current = path; ; current = dirname(current)) {
    const top = parse(current).root === current;
    trail.unshift({ name: top ? current : basename(current), path: current });
    if (top) return trail;
  }
};

const failure = (cause: unknown): ServerError => {
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return notFound("Folder not found");
  if (code === "ENOTDIR") return conflict("Not a folder");
  if (code === "EACCES" || code === "EPERM")
    return conflict("Lumen doesn't have permission to open this folder");
  return internal("Could not read folder", cause);
};

/** Lists one folder for choosing a library root. Reads only; never writes to the filesystem. */
export const listDirectory = async (
  requested: string | null,
  roots: ReadonlyArray<Root>,
): Promise<DirectoryListing> => {
  try {
    const home = await canonicalPath(homedir()).catch(() => resolve(homedir()));
    const path = requested === null ? home : await canonicalPath(requested);
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const directories: Array<DirectoryListing["directories"][number]> = [];
    const files: Array<DirectoryListing["files"][number]> = [];
    let truncated = false;
    for (let start = 0; start < entries.length && !truncated; start += concurrency) {
      const batch = entries.slice(start, start + concurrency);
      for (const entry of await Promise.all(batch.map((entry) => describe(path, entry)))) {
        if (entry === null) continue;
        if (directories.length + files.length === entryLimit) {
          truncated = true;
          break;
        }
        if (entry.type === "directory") directories.push({ name: entry.name, path: entry.path });
        else files.push({ name: entry.name, size: entry.size, kind: entry.kind });
      }
    }
    const above = parse(path).root === path ? null : dirname(path);
    const overlapping = roots.find(
      (root) => isPathWithin(root.path, path) || isPathWithin(path, root.path),
    );
    return {
      path,
      home,
      parent: above !== null && (await canOpen(above)) ? above : null,
      trail: trailOf(path),
      directories,
      files,
      truncated,
      overlaps:
        overlapping === undefined
          ? null
          : {
              rootId: overlapping.rootId,
              libraryId: overlapping.libraryId,
              libraryName: overlapping.libraryName,
            },
    };
  } catch (cause) {
    throw failure(cause);
  }
};
