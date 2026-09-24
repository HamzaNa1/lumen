import { app } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IpcAccount, IpcAccounts } from "@lumen/contracts";
import { createTokenVault, writePrivateJson, type VaultValue } from "./TokenVault";
import type { AccountSession } from "../api/ServerClient";

interface StoredAccount {
  readonly connectionId: string;
  readonly serverId: string;
  readonly serverLabel: string;
  readonly origin: string;
  readonly username: string;
  readonly userId: string;
  readonly role: "admin" | "user" | "guest";
  readonly lastConnectedAtMs: number | null;
}

interface RegistryData {
  readonly activeConnectionId: string | null;
  readonly accounts: ReadonlyArray<StoredAccount>;
}

const emptyRegistry: RegistryData = { activeConnectionId: null, accounts: [] };

export class AccountRegistry {
  private readonly path: string;
  private readonly vaults = new Map<string, VaultValue>();
  private data: RegistryData = emptyRegistry;

  private constructor(path: string, data: RegistryData) {
    this.path = path;
    this.data = data;
  }

  static async open(): Promise<AccountRegistry> {
    const path = join(app.getPath("userData"), "connections.json");
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as RegistryData;
      return new AccountRegistry(path, {
        activeConnectionId: data.activeConnectionId ?? null,
        accounts: Array.isArray(data.accounts) ? data.accounts.map((account) => ({ ...account, role: account.role ?? "user" })) : [],
      });
    } catch {
      return new AccountRegistry(path, emptyRegistry);
    }
  }

  private async vaultFor(connectionId: string): Promise<VaultValue> {
    const existing = this.vaults.get(connectionId);
    if (existing !== undefined) return existing;
    const vault = await createTokenVault(`tokens-${connectionId}.bin`);
    this.vaults.set(connectionId, vault);
    return vault;
  }

  async list(): Promise<IpcAccounts> {
    const accounts = await Promise.all(this.data.accounts.map(async (account): Promise<IpcAccount> => ({
      ...account,
      secureStorageAvailable: (await this.vaultFor(account.connectionId)).available,
    })));
    return { activeConnectionId: this.data.activeConnectionId, accounts };
  }

  active(): StoredAccount | null {
    return this.data.accounts.find((account) => account.connectionId === this.data.activeConnectionId) ?? null;
  }

  find(connectionId: string): StoredAccount | null {
    return this.data.accounts.find((account) => account.connectionId === connectionId) ?? null;
  }

  async save(input: {
    readonly connectionId: string;
    readonly serverId: string;
    readonly serverLabel: string;
    readonly origin: string;
    readonly username: string;
    readonly userId: string;
    readonly role: "admin" | "user" | "guest";
    readonly sessionId: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly accessExpiresAtMs: number;
    readonly refreshExpiresAtMs: number;
  }): Promise<void> {
    const record: StoredAccount = {
      connectionId: input.connectionId,
      serverId: input.serverId,
      serverLabel: input.serverLabel,
      origin: input.origin,
      username: input.username,
      userId: input.userId,
      role: input.role,
      lastConnectedAtMs: Date.now(),
    };
    const next: RegistryData = {
      activeConnectionId: input.connectionId,
      accounts: [...this.data.accounts.filter((account) => account.connectionId !== input.connectionId), record],
    };
    const vault = await this.vaultFor(input.connectionId);
    await vault.write(JSON.stringify({
      userId: input.userId,
      role: input.role,
      sessionId: input.sessionId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      accessExpiresAtMs: input.accessExpiresAtMs,
      refreshExpiresAtMs: input.refreshExpiresAtMs,
    }));
    await writePrivateJson(this.path, next);
    this.data = next;
  }

  async activate(connectionId: string): Promise<void> {
    if (this.find(connectionId) === null) throw new Error("Connection not found");
    this.data = { ...this.data, activeConnectionId: connectionId };
    await writePrivateJson(this.path, this.data);
  }

  async updateRole(connectionId: string, role: "admin" | "user" | "guest"): Promise<void> {
    if (this.find(connectionId) === null) throw new Error("Connection not found");
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) => account.connectionId === connectionId ? { ...account, role } : account),
    };
    await writePrivateJson(this.path, this.data);
  }

  async session(connectionId: string): Promise<AccountSession | null> {
    const vault = await this.vaultFor(connectionId);
    const raw = await vault.read();
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as AccountSession;
    } catch {
      return null;
    }
  }

  async updateSession(connectionId: string, session: AccountSession): Promise<void> {
    const vault = await this.vaultFor(connectionId);
    await vault.write(JSON.stringify(session));
  }

  async remove(connectionId: string): Promise<void> {
    const vault = await this.vaultFor(connectionId);
    await vault.clear();
    this.vaults.delete(connectionId);
    this.data = {
      activeConnectionId: this.data.activeConnectionId === connectionId ? null : this.data.activeConnectionId,
      accounts: this.data.accounts.filter((account) => account.connectionId !== connectionId),
    };
    await writePrivateJson(this.path, this.data);
  }
}
