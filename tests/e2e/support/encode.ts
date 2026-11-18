import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const encoded = new Map<string, Promise<string>>();
let directory: Promise<string> | undefined;

/**
 * Writes what FFmpeg makes from `args` to `path`. Each distinct encode runs once per worker and
 * every later call gets its own copy, so a test may change or delete its file freely. Encoding
 * runs off the event loop, so a test's servers and proxies keep answering meanwhile.
 */
export const encode = async (args: readonly string[], path: string): Promise<void> => {
  const key = JSON.stringify([...args, extname(path)]);
  let made = encoded.get(key);
  if (made === undefined) {
    directory ??= mkdtemp(join(tmpdir(), "lumen-e2e-encoded-")).then((created) => {
      process.once("exit", () => rmSync(created, { recursive: true, force: true }));
      return created;
    });
    made = directory.then(async (root) => {
      const output = join(root, `${randomUUID()}${extname(path)}`);
      await run("ffmpeg", [...args, output]);
      return output;
    });
    encoded.set(key, made);
    made.catch(() => encoded.delete(key));
  }
  await copyFile(await made, path);
};
