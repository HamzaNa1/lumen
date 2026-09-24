import { randomBytes } from "node:crypto";
import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface VaultValue {
  readonly available: boolean;
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export const createTokenVault = async (fileName: string): Promise<VaultValue> => {
  const filePath = join(app.getPath("userData"), fileName);
  const canUseSafeStorage = safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== "basic_text";
  if (canUseSafeStorage) {
    return {
      available: true,
      read: async () => {
        try {
          const bytes = await readFile(filePath);
          try {
            return safeStorage.decryptString(bytes);
          } catch {
            const plain = bytes.toString("utf8");
            const parsed = JSON.parse(plain) as { accessToken?: unknown; refreshToken?: unknown };
            if (typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string") return null;
            const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
            await writeFile(temporary, safeStorage.encryptString(plain), { mode: 0o600 });
            await rename(temporary, filePath);
            return plain;
          }
        } catch {
          return null;
        }
      },
      write: async (value) => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(temporary, safeStorage.encryptString(value), { mode: 0o600 });
        await rename(temporary, filePath);
      },
      clear: async () => {
        await rm(filePath, { force: true });
      },
    };
  }
  return {
    available: false,
    read: async () => {
      try { return await readFile(filePath, "utf8"); } catch { return null; }
    },
    write: async (value) => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, filePath);
    },
    clear: async () => {
      await rm(filePath, { force: true });
    },
  };
};

export const writePrivateJson = async (filePath: string, value: unknown): Promise<void> => {
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, filePath);
};
