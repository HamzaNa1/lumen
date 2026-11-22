import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  type FetchLike,
  type RouteProbeResult,
  type ServerIdentity,
  ServerUnreachableError,
  selectBestRoute,
} from "@lumen/client";
import {
  classifyRouteScope,
  type LanServerCandidate,
  makeServerRoute,
  mergeServerRoutes,
  normalizeOrigin,
  type ServerRoute,
} from "@lumen/contracts";
import type { AccountRegistry, StoredAccount } from "../accounts/AccountRegistry";
import { configuredDiscoveryConfig, discoverLanServers } from "./LanDiscoveryClient";
import { type AccountSession, ServerClient } from "./ServerClient";

const DEFAULT_LOCAL_ORIGINS = ["http://127.0.0.1:3210"];
const INTERFACE_POLL_INTERVAL_MS = 5_000;
const REMOTE_RECHECK_INTERVAL_MS = 30_000;
const FOCUS_RECHECK_COOLDOWN_MS = 10_000;

export class RouteIdentityMismatchError extends Error {
  constructor(message = "Server identity changed; remove this connection and enroll it again") {
    super(message);
    this.name = "RouteIdentityMismatchError";
  }
}

export const hasSessionToken = (session: AccountSession | null): boolean =>
  typeof session?.accessToken === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u.test(
    session.accessToken,
  );

const parseTokenSecret = (
  accessToken: string,
): { readonly sessionId: string; readonly secretHash: string } | null => {
  const parts = accessToken.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
  const secret = Buffer.from(parts[1], "base64url");
  if (secret.length !== 32) return null;
  return {
    sessionId: parts[0],
    secretHash: createHash("sha256").update(secret).digest("hex"),
  };
};

const verifyProof = (
  accessToken: string,
  serverId: string,
  challenge: string,
  proof: string,
): boolean => {
  const parsed = parseTokenSecret(accessToken);
  if (parsed === null) return false;
  const expected = createHmac("sha256", parsed.secretHash)
    .update(`${serverId}:${challenge}`)
    .digest("hex");
  const actualBuf = Buffer.from(proof, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
};

const networkFingerprint = (): string => {
  const entries: string[] = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      entries.push(`${name}:${info.family}:${info.address}`);
    }
  }
  entries.sort();
  return entries.join("|");
};

const localDiscoveryOrigins = (): ReadonlyArray<string> => {
  const override = process.env.LUMEN_E2E_LOCAL_ORIGINS?.trim();
  if (override !== undefined) {
    if (override === "" || override.toLowerCase() === "off") return [];
    return override
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .flatMap((value) => {
        try {
          return [normalizeOrigin(value)];
        } catch {
          return [];
        }
      });
  }
  // When e2e tests turn off LAN discovery, skip probing the host's default port 3210 too.
  if (!configuredDiscoveryConfig().enabled) return [];
  return DEFAULT_LOCAL_ORIGINS;
};

const scopePriority = (origin: string): number => {
  const scope = classifyRouteScope(origin);
  return scope === "local" ? 0 : scope === "lan" ? 1 : 2;
};

export interface RouteManagerOptions {
  readonly registry: AccountRegistry;
  readonly clients: Map<string, ServerClient>;
  readonly serverTransport: FetchLike;
  readonly onRouteChanged: (connectionId: string, origin: string) => void;
  readonly discoverLan?: (signal?: AbortSignal) => Promise<ReadonlyArray<LanServerCandidate>>;
}

/**
 * Coordinates multi-route selection, local and LAN auto-detection, cryptographic route verification
 * before presenting bearer tokens on candidate routes, and automatic failover / promotion.
 */
export class RouteManager {
  private readonly failovers = new Map<string, Promise<string | null>>();
  private readonly promotionChecks = new Map<string, Promise<void>>();
  private readonly discoverLanImpl: (
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<LanServerCandidate>>;
  private lastFocusCheckAtMs = 0;

  constructor(private readonly options: RouteManagerOptions) {
    this.discoverLanImpl =
      options.discoverLan ??
      ((signal) =>
        discoverLanServers({ timeoutMs: 350, ...(signal === undefined ? {} : { signal }) }));
  }

  /**
   * Verifies that `origin` reaches `expectedServerId`. When the server advertises `serverRoutes`
   * and a session token is held, confirms possession of the session hash via challenge-response
   * before any bearer secret is ever sent on that route.
   */
  async verifyOrigin(
    origin: string,
    expectedServerId: string,
    session: AccountSession | null,
    signal?: AbortSignal,
    requireProof = false,
  ): Promise<ServerIdentity> {
    const probeClient = new ServerClient({
      origin,
      fetchImpl: this.options.serverTransport,
    });
    const identity = await probeClient.identity(signal);
    if (identity.serverId !== expectedServerId) throw new RouteIdentityMismatchError();
    if (
      identity.capabilities?.serverRoutes === true &&
      session !== null &&
      hasSessionToken(session)
    ) {
      const parsed = parseTokenSecret(session.accessToken);
      if (parsed === null) throw new Error("Sign-in required");
      const challenge = randomBytes(16).toString("hex");
      const proof = await probeClient.verifyRoute(parsed.sessionId, challenge, signal);
      if (!verifyProof(session.accessToken, expectedServerId, challenge, proof))
        throw new RouteIdentityMismatchError();
    } else if (requireProof) {
      throw new Error("Server cannot verify this auto-detected route");
    }
    return identity;
  }

  /**
   * Probes all saved routes (plus UDP-discovered and default local routes for this server) and
   * returns the highest-priority reachable route: local before LAN before remote.
   */
  async resolveAccountRoute(
    account: StoredAccount,
    session: AccountSession | null,
    options: { readonly excludeOrigin?: string; readonly skipUdpDiscovery?: boolean } = {},
  ): Promise<RouteProbeResult> {
    let discoveredOrigins: string[] = [];
    if (!options.skipUdpDiscovery) {
      const discovered = await this.discoverLanImpl().catch(() => []);
      discoveredOrigins = discovered
        .filter((candidate) => candidate.serverId === account.serverId)
        .map((candidate) => candidate.origin);
    }

    const dismissed = new Set(account.dismissedRoutes);
    const localCandidates = localDiscoveryOrigins().filter((origin) => !dismissed.has(origin));

    const candidates = mergeServerRoutes({
      existing: account.routes,
      detectedOrigins: [...discoveredOrigins, ...localCandidates],
      dismissedOrigins: account.dismissedRoutes,
    }).filter((route) =>
      options.excludeOrigin === undefined ? true : route.origin !== options.excludeOrigin,
    );

    if (candidates.length === 0) throw new ServerUnreachableError();

    const winner = await selectBestRoute({
      routes: candidates,
      activeOrigin: account.origin,
      probe: async (route, signal) => {
        const requireProof =
          route.source === "detected" && session !== null && hasSessionToken(session);
        const identity = await this.verifyOrigin(
          route.origin,
          account.serverId,
          session,
          signal,
          requireProof,
        );
        return { route, origin: route.origin, identity };
      },
    });

    const toStore = [...discoveredOrigins];
    if (winner.route.source === "detected" && !toStore.includes(winner.origin))
      toStore.push(winner.origin);
    if (toStore.length > 0) {
      await this.options.registry.mergeDetectedRoutes(account.serverId, toStore).catch(() => false);
    }
    return winner;
  }

  /**
   * Fetches local and LAN routes advertised by the server (plus UDP discovery), verifies any
   * candidate local loopback routes before saving them, and promotes the live client immediately
   * when a higher-priority route (local > LAN > remote) is reachable.
   */
  async syncServerRoutes(
    connectionId: string,
    client: ServerClient,
    session: AccountSession | null,
  ): Promise<boolean> {
    const account = this.options.registry.find(connectionId);
    if (account === null) return false;
    const [advertised, udp] = await Promise.all([
      client.supportsServerRoutes ? client.advertisedRoutes().catch(() => []) : Promise.resolve([]),
      this.discoverLanImpl().catch(() => []),
    ]);

    const dismissed = new Set(account.dismissedRoutes);
    const lanOrigins = new Set<string>();
    const localCandidates = new Set<string>();

    for (const route of advertised) {
      if (dismissed.has(route.origin)) continue;
      if (route.scope === "local") localCandidates.add(route.origin);
      else if (route.scope === "lan") lanOrigins.add(route.origin);
    }
    for (const candidate of udp) {
      if (candidate.serverId !== account.serverId || dismissed.has(candidate.origin)) continue;
      if (classifyRouteScope(candidate.origin) === "local") localCandidates.add(candidate.origin);
      else lanOrigins.add(candidate.origin);
    }
    for (const origin of localDiscoveryOrigins()) {
      if (!dismissed.has(origin)) localCandidates.add(origin);
    }

    // Only keep auto-detected loopback routes that actually verify on this machine so remote
    // devices never clutter their routes list with an unreachable 127.0.0.1 address.
    const verifiedLocalOrigins: string[] = [];
    if (localCandidates.size > 0) {
      const checks = await Promise.all(
        [...localCandidates].map(async (origin) => {
          if (origin === client.serverOrigin) return origin;
          const requireProof = session !== null && hasSessionToken(session);
          try {
            await this.verifyOrigin(
              origin,
              account.serverId,
              session,
              AbortSignal.timeout(1_000),
              requireProof,
            );
            return origin;
          } catch {
            return null;
          }
        }),
      );
      for (const origin of checks) if (origin !== null) verifiedLocalOrigins.push(origin);
    }

    const detectedOrigins = [...verifiedLocalOrigins, ...lanOrigins];
    const changed = await this.options.registry.mergeDetectedRoutes(
      account.serverId,
      detectedOrigins,
      { replaceDetected: client.supportsServerRoutes },
    );

    const updated = this.options.registry.find(connectionId);
    if (updated !== null) {
      const currentPriority = scopePriority(client.serverOrigin);
      const betterRoutes = updated.routes.filter(
        (route) => scopePriority(route.origin) < currentPriority,
      );
      if (betterRoutes.length > 0) {
        const promoted = await this.probeCandidateRoutes(updated, betterRoutes, session);
        if (promoted !== null && promoted.origin !== client.serverOrigin) {
          await this.switchClientOrigin(connectionId, client, promoted.origin);
          return true;
        }
      }
    }
    if (changed) this.options.onRouteChanged(connectionId, client.serverOrigin);
    return changed;
  }

  /** Switches a live client to `newOrigin`, persists it, and informs listeners. */
  async switchClientOrigin(
    connectionId: string,
    client: ServerClient,
    newOrigin: string,
  ): Promise<void> {
    const normalized = normalizeOrigin(newOrigin);
    if (client.serverOrigin !== normalized) client.setServerOrigin(normalized);
    await this.options.registry.updateOrigin(connectionId, normalized);
    this.options.onRouteChanged(connectionId, normalized);
  }

  /** Fails over a live client whose active route just became unreachable. */
  failover(
    connectionId: string,
    client: ServerClient,
    failedOrigin: string,
  ): Promise<string | null> {
    const existing = this.failovers.get(connectionId);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      if (client.serverOrigin !== failedOrigin) return client.serverOrigin;
      const account = this.options.registry.find(connectionId);
      if (account === null) return null;
      const session = client.currentSession ?? (await this.options.registry.session(connectionId));
      try {
        const winner = await this.resolveAccountRoute(account, session, {
          excludeOrigin: failedOrigin,
        });
        if (winner.origin === failedOrigin) return null;
        await this.switchClientOrigin(connectionId, client, winner.origin);
        return winner.origin;
      } catch {
        return null;
      }
    })().finally(() => {
      this.failovers.delete(connectionId);
    });
    this.failovers.set(connectionId, pending);
    return pending;
  }

  /**
   * Automatically re-checks higher-priority routes (local and LAN) for a live connection and
   * promotes it when a better route becomes reachable. When `checkCurrent` is true (e.g. after a
   * network change or system resume), also verifies the active route and fails over if needed.
   */
  recheckActiveRoute(
    connectionId: string,
    options: { readonly checkCurrent?: boolean } = {},
  ): Promise<void> {
    const existing = this.promotionChecks.get(connectionId);
    if (existing !== undefined) return existing;
    const task = (async () => {
      const client = this.options.clients.get(connectionId);
      const account = this.options.registry.find(connectionId);
      if (client === undefined || account === null) return;
      const session = client.currentSession ?? (await this.options.registry.session(connectionId));
      const currentPriority = scopePriority(client.serverOrigin);

      if (options.checkCurrent) {
        try {
          const winner = await this.resolveAccountRoute(account, session);
          if (winner.origin !== client.serverOrigin)
            await this.switchClientOrigin(connectionId, client, winner.origin);
          await this.syncServerRoutes(connectionId, client, session).catch(() => false);
          return;
        } catch {
          return;
        }
      }

      if (currentPriority === 0) return;

      const udp = await this.discoverLanImpl().catch(() => []);
      const udpOrigins = udp
        .filter((candidate) => candidate.serverId === account.serverId)
        .map((candidate) => candidate.origin);
      const dismissed = new Set(account.dismissedRoutes);
      const candidateOrigins = [
        ...udpOrigins.filter((origin) => !dismissed.has(origin)),
        ...localDiscoveryOrigins().filter((origin) => !dismissed.has(origin)),
      ];
      const lanUdpOrigins = udpOrigins.filter(
        (origin) => !dismissed.has(origin) && classifyRouteScope(origin) === "lan",
      );
      if (lanUdpOrigins.length > 0)
        await this.options.registry.mergeDetectedRoutes(account.serverId, lanUdpOrigins);

      const latest = this.options.registry.find(connectionId);
      if (latest === null) return;
      const higherCandidates = mergeServerRoutes({
        existing: latest.routes,
        detectedOrigins: candidateOrigins,
        dismissedOrigins: latest.dismissedRoutes,
      }).filter((route) => scopePriority(route.origin) < currentPriority);
      if (higherCandidates.length === 0) return;

      const winner = await this.probeCandidateRoutes(latest, higherCandidates, session);
      if (winner !== null && winner.origin !== client.serverOrigin) {
        if (winner.route.source === "detected")
          await this.options.registry.mergeDetectedRoutes(latest.serverId, [winner.origin]);
        await this.switchClientOrigin(connectionId, client, winner.origin);
      }
    })().finally(() => {
      this.promotionChecks.delete(connectionId);
    });
    this.promotionChecks.set(connectionId, task);
    return task;
  }

  /** Triggers a throttled automatic route re-check when the app window regains focus. */
  onWindowFocus(connectionId: string): void {
    const now = Date.now();
    if (now - this.lastFocusCheckAtMs < FOCUS_RECHECK_COOLDOWN_MS) return;
    this.lastFocusCheckAtMs = now;
    void this.recheckActiveRoute(connectionId);
  }

  /**
   * Starts lightweight background monitoring for network interface changes and periodic local/LAN
   * promotion while connected over a remote route. Returns a cleanup function.
   */
  startMonitoring(activeConnectionId: () => string | null): () => void {
    let lastFingerprint = networkFingerprint();
    const interfaceTimer = setInterval(() => {
      const next = networkFingerprint();
      if (next === lastFingerprint) return;
      lastFingerprint = next;
      const connectionId = activeConnectionId();
      if (connectionId !== null) void this.recheckActiveRoute(connectionId, { checkCurrent: true });
    }, INTERFACE_POLL_INTERVAL_MS);
    interfaceTimer.unref?.();

    const promotionTimer = setInterval(() => {
      const connectionId = activeConnectionId();
      if (connectionId === null) return;
      const client = this.options.clients.get(connectionId);
      if (client === undefined || scopePriority(client.serverOrigin) === 0) return;
      void this.recheckActiveRoute(connectionId);
    }, REMOTE_RECHECK_INTERVAL_MS);
    promotionTimer.unref?.();

    return () => {
      clearInterval(interfaceTimer);
      clearInterval(promotionTimer);
    };
  }

  /**
   * Probes a manually entered route for an existing server connection:
   * - If reachable and matching `serverId`, returns `{ reachable: true, identity }`.
   * - If reachable with a different `serverId` or incompatible API, throws.
   * - If currently unreachable (e.g. adding a home LAN route while away), returns `{ reachable: false }`.
   */
  async probeManualRoute(
    origin: string,
    expectedServerId: string,
    session: AccountSession | null,
  ): Promise<
    { readonly reachable: true; readonly identity: ServerIdentity } | { readonly reachable: false }
  > {
    const normalized = normalizeOrigin(origin);
    try {
      const identity = await this.verifyOrigin(
        normalized,
        expectedServerId,
        session,
        AbortSignal.timeout(2_000),
        false,
      );
      return { reachable: true, identity };
    } catch (cause) {
      if (cause instanceof RouteIdentityMismatchError)
        throw new Error("That address belongs to a different Lumen server.");
      if (
        cause instanceof ServerUnreachableError ||
        (cause instanceof Error && cause.name === "TimeoutError") ||
        (cause instanceof Error && cause.name === "AbortError")
      )
        return { reachable: false };
      throw cause;
    }
  }

  /** Scans this machine (loopback) and the local network (UDP) for reachable Lumen servers. */
  async discoverLanCandidates(): Promise<ReadonlyArray<LanServerCandidate>> {
    const [udpRaw, localOrigins] = await Promise.all([
      discoverLanServers({ timeoutMs: 550 }).catch(() => []),
      Promise.resolve(localDiscoveryOrigins()),
    ]);
    const origins = [...new Set([...localOrigins, ...udpRaw.map((entry) => entry.origin)])];
    if (origins.length === 0) return [];
    const verified = await Promise.all(
      origins.map(async (origin): Promise<LanServerCandidate | null> => {
        try {
          const identity = await new ServerClient({
            origin,
            fetchImpl: this.options.serverTransport,
          }).identity(AbortSignal.timeout(1_200));
          return {
            serverId: identity.serverId,
            displayName: identity.displayName,
            origin,
          };
        } catch {
          return null;
        }
      }),
    );
    const byServer = new Map<string, LanServerCandidate>();
    for (const entry of verified) {
      if (entry === null) continue;
      const existing = byServer.get(entry.serverId);
      if (existing === undefined || scopePriority(entry.origin) < scopePriority(existing.origin))
        byServer.set(entry.serverId, entry);
    }
    return [...byServer.values()].sort(
      (a, b) =>
        scopePriority(a.origin) - scopePriority(b.origin) || a.origin.localeCompare(b.origin),
    );
  }

  private async probeCandidateRoutes(
    account: StoredAccount,
    routes: ReadonlyArray<ServerRoute>,
    session: AccountSession | null,
  ): Promise<RouteProbeResult | null> {
    try {
      return await selectBestRoute({
        routes,
        activeOrigin: account.origin,
        probe: async (route, signal) => {
          const requireProof =
            route.source === "detected" && session !== null && hasSessionToken(session);
          const identity = await this.verifyOrigin(
            route.origin,
            account.serverId,
            session,
            signal,
            requireProof,
          );
          return { route, origin: route.origin, identity };
        },
      });
    } catch {
      return null;
    }
  }
}

export const defaultRouteFor = (origin: string): ServerRoute => makeServerRoute(origin, "manual");
