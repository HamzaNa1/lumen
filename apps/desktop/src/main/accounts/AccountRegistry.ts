import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountList,
  type AccountSummary,
  makeServerRoute,
  mergeServerRoutes,
  normalizeOrigin,
  type ServerRoute,
  sendsTokenInClear,
  sortServerRoutes,
  tokenAllowsPlainHttp,
  type UserRole,
  usableServerRoutes,
} from "@lumen/contracts";
import { app } from "electron";
import { certificateFingerprint, type PinnedTls } from "../api/PinnedCertificates";
import type { AccountSession } from "../api/ServerClient";
import { writePrivateJson } from "../storage/writePrivateJson";
import { createTokenVault, type VaultValue } from "./TokenVault";

export interface StoredAccount {
  readonly connectionId: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly origin: string;
  /** The origin over which this account's current bearer token was issued. */
  readonly credentialOrigin: string;
  readonly routes: ReadonlyArray<ServerRoute>;
  readonly dismissedRoutes: ReadonlyArray<string>;
  /** The server's LAN certificate, trusted on this account's routes; absent until it advertises one. */
  readonly tls?: PinnedTls;
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

const inferCredentialOrigin = (
  origin: string,
  rawRoutes: ReadonlyArray<ServerRoute>,
  stored?: string,
): string => {
  if (typeof stored === "string" && stored.trim() !== "") return normalizedOrRaw(stored);
  if (rawRoutes.length === 0) return origin;
  const manualOrigins = rawRoutes
    .filter((route) => route.source === "manual")
    .map((route) => normalizedOrRaw(route.origin));
  if (manualOrigins.length === 0) return origin;
  const protectedOrigin = manualOrigins.find((entry) => !tokenAllowsPlainHttp(entry));
  return protectedOrigin ?? manualOrigins[0] ?? origin;
};

const pinnedTls = (value: unknown): PinnedTls | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { certificate, origins } = value as { certificate?: unknown; origins?: unknown };
  if (typeof certificate !== "string" || certificateFingerprint(certificate) === null)
    return undefined;
  return {
    certificate,
    origins: Array.isArray(origins)
      ? origins.filter((origin): origin is string => typeof origin === "string")
      : [],
  };
};

/** Earlier versions stored a single origin and a device-local label where server routes and name now live. */
const storedAccount = ({
  serverLabel,
  tls: rawTls,
  ...account
}: Omit<StoredAccount, "credentialOrigin" | "routes" | "dismissedRoutes" | "tls"> & {
  readonly tls?: unknown;
  readonly serverLabel?: string;
  readonly credentialOrigin?: string;
  readonly routes?: ReadonlyArray<ServerRoute>;
  readonly dismissedRoutes?: ReadonlyArray<string>;
}): StoredAccount => {
  const origin = normalizedOrRaw(account.origin);
  const dismissedRoutes = Array.isArray(account.dismissedRoutes)
    ? [...new Set(account.dismissedRoutes.map(normalizedOrRaw))]
    : [];
  const rawRoutes = Array.isArray(account.routes) ? account.routes : [];
  const credentialOrigin = inferCredentialOrigin(origin, rawRoutes, account.credentialOrigin);
  const hasOrigin = rawRoutes.some((route) => normalizedOrRaw(route.origin) === origin);
  const routes = mergeServerRoutes({
    existing: rawRoutes,
    manualOrigins: hasOrigin ? [] : [origin],
    dismissedOrigins: dismissedRoutes,
    credentialOrigin,
  });
  const safeRoutes = routes.length > 0 ? routes : [makeServerRoute(credentialOrigin, "manual")];
  const activeOrigin = safeRoutes.some((route) => route.origin === origin)
    ? origin
    : (safeRoutes[0]?.origin ?? credentialOrigin);
  const tls = pinnedTls(rawTls);
  return {
    ...account,
    ...(tls === undefined ? {} : { tls }),
    origin: activeOrigin,
    credentialOrigin,
    routes: safeRoutes,
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
          routes: sortServerRoutes(
            usableServerRoutes(account.routes, account.credentialOrigin),
            account.origin,
          ),
          routesNeedingSignIn: sortServerRoutes(
            account.routes.filter((route) => sendsTokenInClear(route, account.credentialOrigin)),
          ),
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

  all(): ReadonlyArray<StoredAccount> {
    return this.data.accounts;
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
    const existing = this.find(input.connectionId);
    const dismissedRoutes = (existing?.dismissedRoutes ?? []).filter(
      (dismissed) => dismissed !== origin,
    );
    const routes = mergeServerRoutes({
      existing: existing?.routes ?? [],
      manualOrigins: [origin],
      detectedOrigins: input.detectedOrigins ?? [],
      dismissedOrigins: dismissedRoutes,
      credentialOrigin: origin,
    });
    const record: StoredAccount = {
      connectionId: input.connectionId,
      serverId: input.serverId,
      serverName: input.serverName,
      origin,
      credentialOrigin: origin,
      routes,
      dismissedRoutes,
      ...(existing?.tls === undefined ? {} : { tls: existing.tls }),
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
              ? { ...account, serverName: input.serverName }
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
    const existingRoute = current.routes.find((route) => route.origin === normalized);
    if (
      existingRoute === undefined &&
      sendsTokenInClear(makeServerRoute(normalized, "detected"), current.credentialOrigin)
    )
      return false;
    if (existingRoute !== undefined && sendsTokenInClear(existingRoute, current.credentialOrigin))
      return false;
    if (current.origin === normalized && existingRoute !== undefined) return false;
    const routes =
      existingRoute !== undefined
        ? current.routes
        : mergeServerRoutes({
            existing: current.routes,
            detectedOrigins: [normalized],
            dismissedOrigins: current.dismissedRoutes.filter((entry) => entry !== normalized),
            credentialOrigin: current.credentialOrigin,
          });
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) =>
        account.connectionId === connectionId
          ? { ...account, origin: normalized, routes }
          : account,
      ),
    };
    await writePrivateJson(this.path, this.data);
    return true;
  }

  /** Adds a manually entered route to this connection. */
  async addRoute(connectionId: string, origin: string): Promise<void> {
    const normalized = normalizeOrigin(origin);
    const current = this.find(connectionId);
    if (current === null) throw new Error("Connection not found");
    const dismissedRoutes = current.dismissedRoutes.filter((entry) => entry !== normalized);
    const routes = mergeServerRoutes({
      existing: current.routes,
      manualOrigins: [normalized],
      dismissedOrigins: dismissedRoutes,
      credentialOrigin: current.credentialOrigin,
    });
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) =>
        account.connectionId === connectionId ? { ...account, routes, dismissedRoutes } : account,
      ),
    };
    await writePrivateJson(this.path, this.data);
  }

  /** Removes a route from this connection; at least one route must remain. */
  async removeRoute(connectionId: string, origin: string): Promise<void> {
    const normalized = normalizeOrigin(origin);
    const current = this.find(connectionId);
    if (current === null) throw new Error("Connection not found");
    const existingRoutes = mergeServerRoutes({
      existing: current.routes,
      credentialOrigin: current.credentialOrigin,
    });
    const target = existingRoutes.find((route) => route.origin === normalized);
    if (target === undefined) return;
    const remaining = existingRoutes.filter((route) => route.origin !== normalized);
    const fallback = sortServerRoutes(usableServerRoutes(remaining, current.credentialOrigin))[0];
    if (fallback === undefined)
      throw new Error("A server must keep at least one route this connection can use");
    const fallbackOrigin = fallback.origin;
    const dismissedRoutes = [
      ...new Set([
        ...current.dismissedRoutes,
        ...(target.source === "detected" ? [normalized] : []),
      ]),
    ];
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) => {
        if (account.connectionId !== connectionId) return account;
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

  /** Merges auto-detected routes for one connection, respecting dismissed routes and token transport. */
  async mergeDetectedRoutes(
    connectionId: string,
    detectedOrigins: ReadonlyArray<string>,
    options: { readonly replaceDetected?: boolean } = {},
  ): Promise<boolean> {
    const current = this.find(connectionId);
    if (current === null) return false;
    const merged = mergeServerRoutes({
      existing: current.routes,
      detectedOrigins,
      dismissedOrigins: current.dismissedRoutes,
      credentialOrigin: current.credentialOrigin,
      ...(options.replaceDetected === undefined
        ? {}
        : { replaceDetected: options.replaceDetected }),
    });
    const activeDetected = makeServerRoute(current.origin, "detected");
    // Keep the currently active origin in the list if it was auto-detected and temporarily absent,
    // unless it would send this connection's token over plain HTTP.
    const routes =
      merged.some((route) => route.origin === current.origin) ||
      sendsTokenInClear(activeDetected, current.credentialOrigin)
        ? merged
        : sortServerRoutes([...merged, activeDetected]);
    const nextOrigin = routes.some((route) => route.origin === current.origin)
      ? current.origin
      : (routes[0]?.origin ?? current.credentialOrigin);
    if (routesEqual(current.routes, routes) && nextOrigin === current.origin) return false;
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) =>
        account.connectionId === connectionId
          ? { ...account, origin: nextOrigin, routes }
          : account,
      ),
    };
    await writePrivateJson(this.path, this.data);
    return true;
  }

  /** Records the LAN certificate the server advertised over this account's route; null clears it. */
  async updateTls(connectionId: string, tls: PinnedTls | null): Promise<boolean> {
    const current = this.find(connectionId);
    if (current === null) return false;
    const next = tls === null ? undefined : pinnedTls(tls);
    if (
      current.tls?.certificate === next?.certificate &&
      (current.tls?.origins ?? []).join(" ") === (next?.origins ?? []).join(" ")
    )
      return false;
    this.data = {
      ...this.data,
      accounts: this.data.accounts.map((account) => {
        if (account.connectionId !== connectionId) return account;
        const { tls: _previous, ...rest } = account;
        return next === undefined ? rest : { ...rest, tls: next };
      }),
    };
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
