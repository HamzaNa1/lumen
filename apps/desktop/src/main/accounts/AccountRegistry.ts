import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountList,
  type AccountSummary,
  makeServerRoute,
  mergeServerRoutes,
  normalizeOrigin,
  type ServerRoute,
  sortServerRoutes,
  type UserRole,
} from "@lumen/contracts";
import { app } from "electron";
import type { AccountSession } from "../api/ServerClient";
import { createTokenVault, type VaultValue, writePrivateJson } from "./TokenVault";

export interface StoredAccount {
  readonly connectionId: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly origin: string;
  readonly routes: ReadonlyArray<ServerRoute>;
  readonly dismissedRoutes: ReadonlyArray<string>;
  readonly username: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly lastConnectedAtMs: number | null;
}

interface RegistryData {
  readonly activeConnectionId: string | null;
  readonly accounts: ReadonlyArray<StoredAccount>;
}

const emptyRegistry: RegistryData = { activeConnectionId: null, accounts: [] };

const normalizedOrRaw = (origin: string): string => {
  try {
    return normalizeOrigin(origin);
  } catch {
    return origin;
  }
};

const routesEqual = (
  left: ReadonlyArray<ServerRoute>,
  right: ReadonlyArray<ServerRoute>,
): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.origin === right[index]?.origin &&
      entry.source === right[index]?.source &&
      entry.scope === right[index]?.scope,
  );

/** Earlier versions stored a single origin and a device-local label where server routes and name now live. */
const storedAccount = ({
  serverLabel,
  ...account
}: Omit<StoredAccount, "routes" | "dismissedRoutes"> & {
  readonly serverLabel?: string;
  readonly routes?: ReadonlyArray<ServerRoute>;
  readonly dismissedRoutes?: ReadonlyArray<string>;
}): StoredAccount => {
  const origin = normalizedOrRaw(account.origin);
  const dismissedRoutes = Array.isArray(account.dismissedRoutes)
    ? [...new Set(account.dismissedRoutes.map(normalizedOrRaw))]
    : [];
  const rawRoutes = Array.isArray(account.routes) ? account.routes : [];
  const hasOrigin = rawRoutes.some((route) => normalizedOrRaw(route.origin) === origin);
  const routes = mergeServerRoutes({
    existing: rawRoutes,
    manualOrigins: hasOrigin ? [] : [origin],
    dismissedOrigins: dismissedRoutes,
  });
  return {
    ...account,
    origin,
    routes: routes.length > 0 ? routes : [makeServerRoute(origin, "manual")],
    dismissedRoutes,
    serverName: account.serverName ?? serverLabel ?? "Lumen Server",
    role: account.role === "admin" ? "admin" : "user",
  };
};

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
        accounts: Array.isArray(data.accounts) ? data.accounts.map(storedAccount) : [],
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

  async list(): Promise<AccountList> {
    const accounts = await Promise.all(
      this.data.accounts.map(
        async (account): Promise<AccountSummary> => ({
          connectionId: account.connectionId,
          serverId: account.serverId,
          serverName: account.serverName,
          origin: account.origin,
          routes: sortServerRoutes(account.routes, account.origin),
          username: account.username,
          userId: account.userId,
          role: account.role,
          lastConnectedAtMs: account.lastConnectedAtMs,
          secureStorageAvailable: (await this.vaultFor(account.connectionId)).available,
        }),
      ),
    );
    return { activeConnectionId: this.data.activeConnectionId, accounts };
  }

  active(): StoredAccount | null {
    return (
      this.data.accounts.find((account) => account.connectionId === this.data.activeConnectionId) ??
      null
    );
  }

  find(connectionId: string): StoredAccount | null {
    return this.data.accounts.find((account) => account.connectionId === connectionId) ?? null;
  }

  async save(input: {
    readonly connectionId: string;
    readonly serverId: string;
    readonly serverName: string;
    readonly origin: string;
    readonly detectedOrigins?: ReadonlyArray<string>;
    readonly username: string;
    readonly userId: string;
    readonly role: UserRole;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly accessExpiresAtMs: number;
  }): Promise<void> {
    const origin = normalizeOrigin(input.origin);
    const siblings = this.data.accounts.filter((account) => account.serverId === input.serverId);
    const existingRoutes = siblings.flatMap((account) => account.routes);
    const dismissedRoutes = [
      ...new Set(siblings.flatMap((account) => account.dismissedRoutes)),
    ].filter((dismissed) => dismissed !== origin);
    const routes = mergeServerRoutes({
      existing: existingRoutes,
      manualOrigins: [origin],
      detectedOrigins: input.detectedOrigins ?? [],
      dismissedOrigins: dismissedRoutes,
    });
    const record: StoredAccount = {
      connectionId: input.connectionId,
      serverId: input.serverId,
      serverName: input.serverName,
      origin,
      routes,
      dismissedRoutes,
      username: input.username,
      userId: input.userId,
      role: input.role,
      lastConnectedAtMs: Date.now(),
    };
    const next: RegistryData = {
      activeConnectionId: input.connectionId,
      accounts: [
        ...this.data.accounts
          .filter((account) => account.connectionId !== input.connectionId)
          .map((account) =>
            account.serverId === input.serverId
              ? { ...account, serverName: input.serverName, routes, dismissedRoutes }
              : account,
          ),
        record,
      ],
    };
    const vault = await this.vaultFor(input.connectionId);
    await vault.write(
      JSON.stringify({
        userId: input.userId,
        role: input.role,
        sessionId: input.sessionId,
        accessToken: input.accessToken,
        accessExpiresAtMs: input.accessExpiresAtMs,
      }),
    );
    await writePrivateJson(this.path, next);
    this.data = next;
  }

  async activate(connectionId: string): Promise<void> {
    if (this.find(connectionId) === null) throw new Error("Connection not found");
    this.data = { ...this.data, activeConnectionId: connectionId };
    await writePrivateJson(this.path, this.data);
  }

  async updateRole(connectionId: string, role: UserRole): Promise<void> {
    if (this.find(connectionId) === null) throw new Error("Connection not found");
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) =>
        account.connectionId === connectionId ? { ...account, role } : account,
      ),
    };
    await writePrivateJson(this.path, this.data);
  }

  /** Updates the active origin a connection is currently reaching its server through. */
  async updateOrigin(connectionId: string, origin: string): Promise<boolean> {
    const normalized = normalizeOrigin(origin);
    const current = this.find(connectionId);
    if (current === null) return false;
    const hasRoute = current.routes.some((route) => route.origin === normalized);
    if (current.origin === normalized && hasRoute) return false;
    const routes = hasRoute
      ? current.routes
      : mergeServerRoutes({
          existing: current.routes,
          detectedOrigins: [normalized],
          dismissedOrigins: current.dismissedRoutes.filter((entry) => entry !== normalized),
        });
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) => {
        if (account.connectionId === connectionId)
          return { ...account, origin: normalized, routes };
        if (account.serverId === current.serverId && !hasRoute) return { ...account, routes };
        return account;
      }),
    };
    await writePrivateJson(this.path, this.data);
    return true;
  }

  /** Adds a manually entered route to every account on this server. */
  async addRoute(serverId: string, origin: string): Promise<void> {
    const normalized = normalizeOrigin(origin);
    const matches = this.data.accounts.filter((account) => account.serverId === serverId);
    if (matches.length === 0) throw new Error("Connection not found");
    const existingRoutes = matches.flatMap((account) => account.routes);
    const dismissedRoutes = [
      ...new Set(matches.flatMap((account) => account.dismissedRoutes)),
    ].filter((entry) => entry !== normalized);
    const routes = mergeServerRoutes({
      existing: existingRoutes,
      manualOrigins: [normalized],
      dismissedOrigins: dismissedRoutes,
    });
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) =>
        account.serverId === serverId ? { ...account, routes, dismissedRoutes } : account,
      ),
    };
    await writePrivateJson(this.path, this.data);
  }

  /** Removes a route from every account on this server; at least one route must remain. */
  async removeRoute(serverId: string, origin: string): Promise<void> {
    const normalized = normalizeOrigin(origin);
    const matches = this.data.accounts.filter((account) => account.serverId === serverId);
    if (matches.length === 0) throw new Error("Connection not found");
    const existingRoutes = mergeServerRoutes({
      existing: matches.flatMap((account) => account.routes),
    });
    const target = existingRoutes.find((route) => route.origin === normalized);
    if (target === undefined) return;
    const remaining = existingRoutes.filter((route) => route.origin !== normalized);
    const fallback = sortServerRoutes(remaining)[0];
    if (fallback === undefined) throw new Error("A server must keep at least one route");
    const fallbackOrigin = fallback.origin;
    const dismissedRoutes = [
      ...new Set([
        ...matches.flatMap((account) => account.dismissedRoutes),
        ...(target.source === "detected" ? [normalized] : []),
      ]),
    ];
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) => {
        if (account.serverId !== serverId) return account;
        return {
          ...account,
          origin: account.origin === normalized ? fallbackOrigin : account.origin,
          routes: remaining,
          dismissedRoutes,
        };
      }),
    };
    await writePrivateJson(this.path, this.data);
  }

  /** Merges auto-detected LAN routes across all accounts on a server, respecting dismissed routes. */
  async mergeDetectedRoutes(
    serverId: string,
    detectedOrigins: ReadonlyArray<string>,
    options: { readonly replaceDetected?: boolean } = {},
  ): Promise<boolean> {
    const matches = this.data.accounts.filter((account) => account.serverId === serverId);
    if (matches.length === 0) return false;
    let changed = false;
    const nextAccounts = this.data.accounts.map((account) => {
      if (account.serverId !== serverId) return account;
      const merged = mergeServerRoutes({
        existing: account.routes,
        detectedOrigins,
        dismissedOrigins: account.dismissedRoutes,
        ...(options.replaceDetected === undefined
          ? {}
          : { replaceDetected: options.replaceDetected }),
      });
      // Keep the currently active origin in the list if it was auto-detected and temporarily absent.
      const routes = merged.some((route) => route.origin === account.origin)
        ? merged
        : sortServerRoutes([...merged, makeServerRoute(account.origin, "detected")]);
      if (routesEqual(account.routes, routes)) return account;
      changed = true;
      return { ...account, routes };
    });
    if (!changed) return false;
    this.data = { ...this.data, accounts: nextAccounts };
    await writePrivateJson(this.path, this.data);
    return true;
  }

  /** Records what a server now calls itself on every account that connects to it. */
  async updateServerName(serverId: string, serverName: string): Promise<void> {
    if (
      this.data.accounts.every(
        (account) => account.serverId !== serverId || account.serverName === serverName,
      )
    )
      return;
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) =>
        account.serverId === serverId ? { ...account, serverName } : account,
      ),
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
      activeConnectionId:
        this.data.activeConnectionId === connectionId ? null : this.data.activeConnectionId,
      accounts: this.data.accounts.filter((account) => account.connectionId !== connectionId),
    };
    await writePrivateJson(this.path, this.data);
  }
}
