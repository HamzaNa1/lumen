import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const pending = new Map<string, Promise<void>>();

/** Writes `value` readable only by this user. Writes to one file land in call order. */
export const writePrivateJson = (filePath: string, value: unknown): Promise<void> => {
  const write = (pending.get(filePath) ?? Promise.resolve()).then(async () => {
    const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, filePath);
  });
  const settled = write.catch(() => undefined);
  pending.set(filePath, settled);
  void settled.then(() => {
    if (pending.get(filePath) === settled) pending.delete(filePath);
  });
  return write;
};
