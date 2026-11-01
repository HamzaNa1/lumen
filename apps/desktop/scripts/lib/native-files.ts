import { readdirSync } from "node:fs";
import { join } from "node:path";

export const nativeFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return nativeFiles(path);
    return entry.isFile() ? [path] : [];
  });
