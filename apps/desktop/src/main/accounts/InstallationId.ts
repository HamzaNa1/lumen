import { Uuid } from "@lumen/contracts";
import { Schema } from "effect";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

export const deviceIdForAccount = (installationId: string, serverId: string, username: string): string => {
  const bytes = createHash("sha256").update(JSON.stringify([installationId, serverId, username.trim().toLowerCase()])).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
