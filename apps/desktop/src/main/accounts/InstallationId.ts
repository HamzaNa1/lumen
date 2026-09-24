import { Uuid } from "@lumen/contracts";
import { Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const installationSchema = Schema.Struct({ id: Uuid });

export const getOrCreateInstallationId = async (path: string): Promise<string> => {
  try {
    const stored = Schema.decodeUnknownSync(installationSchema)(JSON.parse(await readFile(path, "utf8")));
    return stored.id;
  } catch {
    const id = randomUUID();
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify({ id }), { mode: 0o600 });
    await rename(temporary, path);
    return id;
  }
};
