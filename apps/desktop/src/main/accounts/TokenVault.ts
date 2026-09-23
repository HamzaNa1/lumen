import { randomBytes } from "node:crypto";
import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface VaultValue {
  readonly available: boolean;
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export const createTokenVault = async (fileName: string): Promise<VaultValue> => {
  const filePath = join(app.getPath("userData"), fileName);
  const canUseSafeStorage = safeStorage.isEncryptionAvailable() && process.platform !== "linux";
  if (canUseSafeStorage) {
    return {
      available: true,
      read: async () => {
        try {
          const bytes = await readFile(filePath);
          return safeStorage.decryptString(bytes);
        } catch {
          return null;
        }
      },
      write: async (value) => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, safeStorage.encryptString(value), { mode: 0o600 });
      },
      clear: async () => {
        await writeFile(filePath, "", { mode: 0o600 });
      },
    };
  }
  let memory: string | null = null;
  return {
    available: false,
    read: async () => memory,
    write: async (value) => {
      memory = value;
    },
    clear: async () => {
      memory = null;
    },
  };
};

export const writePrivateJson = async (filePath: string, value: unknown): Promise<void> => {
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, filePath);
};
