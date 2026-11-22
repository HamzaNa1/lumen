import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
import { discoverLanServers } from "./LanDiscoveryClient";
import { type AccountSession, ServerClient } from "./ServerClient";

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

export interface RouteManagerOptions {
  readonly registry: AccountRegistry;
  readonly clients: Map<string, ServerClient>;
  readonly serverTransport: FetchLike;
  readonly onRouteChanged: (connectionId: string, origin: string) => void;
  readonly discoverLan?: (signal?: AbortSignal) => Promise<ReadonlyArray<LanServerCandidate>>;
}

/**
 * Coordinates multi-route selection, LAN auto-detection, cryptographic route verification before
 * presenting bearer tokens on candidate LAN routes, and automatic failover / LAN promotion.
 */
export class RouteManager {
  private readonly failovers = new Map<string, Promise<string | null>>();
  private readonly lanChecks = new Map<string, Promise<void>>();
  private readonly discoverLanImpl: (
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<LanServerCandidate>>;

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
   * Probes all saved routes (plus any UDP-discovered LAN route for this server) and returns the
   * highest-priority reachable route, always prioritizing LAN over remote.
   */
  async resolveAccountRoute(
    account: StoredAccount,
    session: AccountSession | null,
    options: { readonly excludeOrigin?: string; readonly skipUdpDiscovery?: boolean } = {},
  ): Promise<RouteProbeResult> {
    let udpOrigins: string[] = [];
    if (!options.skipUdpDiscovery) {
      const discovered = await this.discoverLanImpl().catch(() => []);
      udpOrigins = discovered
        .filter((candidate) => candidate.serverId === account.serverId)
        .map((candidate) => candidate.origin);
    }

    const candidates = mergeServerRoutes({
      existing: account.routes,
      detectedOrigins: udpOrigins,
      dismissedOrigins: account.dismissedRoutes,
    }).filter((route) =>
      options.excludeOrigin === undefined ? true : route.origin !== options.excludeOrigin,
    );

    if (udpOrigins.length > 0) {
      await this.options.registry
        .mergeDetectedRoutes(account.serverId, udpOrigins)
        .catch(() => false);
    }

    if (candidates.length === 0) throw new ServerUnreachableError();

    return selectBestRoute({
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
  }

  /**
   * Fetches LAN routes advertised by the server (plus UDP LAN discovery), stores them as detected
   * routes, and promotes the live client immediately if it is currently on a remote route and a
   * LAN route is reachable.
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
    const detectedOrigins = [
      ...advertised.filter((route) => route.scope === "lan").map((route) => route.origin),
      ...udp
        .filter((candidate) => candidate.serverId === account.serverId)
        .map((candidate) => candidate.origin),
    ];
    let changed = await this.options.registry.mergeDetectedRoutes(
      account.serverId,
      detectedOrigins,
      { replaceDetected: client.supportsServerRoutes },
    );

    const updated = this.options.registry.find(connectionId);
    if (updated !== null && classifyRouteScope(client.serverOrigin) === "remote") {
      const lanRoutes = updated.routes.filter((route) => route.scope === "lan");
      if (lanRoutes.length > 0) {
        const promoted = await this.probeLanRoutes(updated, lanRoutes, session);
        if (promoted !== null && promoted.origin !== client.serverOrigin) {
          await this.switchClientOrigin(connectionId, client, promoted.origin);
          changed = true;
        }
      }
    }
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
   * Re-checks LAN routes when a connection is currently on a remote route (e.g. after waking from
   * sleep on a new network) and promotes to LAN if verified reachable.
   */
  promoteToLanIfAvailable(connectionId: string): Promise<void> {
    const existing = this.lanChecks.get(connectionId);
    if (existing !== undefined) return existing;
    const task = (async () => {
      const client = this.options.clients.get(connectionId);
      const account = this.options.registry.find(connectionId);
      if (client === undefined || account === null) return;
      if (classifyRouteScope(client.serverOrigin) === "lan") return;
      const session = client.currentSession ?? (await this.options.registry.session(connectionId));
      const udp = await this.discoverLanImpl().catch(() => []);
      const udpOrigins = udp
        .filter((candidate) => candidate.serverId === account.serverId)
        .map((candidate) => candidate.origin);
      if (udpOrigins.length > 0)
        await this.options.registry.mergeDetectedRoutes(account.serverId, udpOrigins);
      const latest = this.options.registry.find(connectionId);
      if (latest === null) return;
      const lanRoutes = latest.routes.filter((route) => route.scope === "lan");
      if (lanRoutes.length === 0) return;
      const winner = await this.probeLanRoutes(latest, lanRoutes, session);
      if (winner !== null && winner.origin !== client.serverOrigin)
        await this.switchClientOrigin(connectionId, client, winner.origin);
    })().finally(() => {
      this.lanChecks.delete(connectionId);
    });
    this.lanChecks.set(connectionId, task);
    return task;
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

  /** Scans the local network for reachable Lumen servers and confirms each via HTTP identity. */
  async discoverLanCandidates(): Promise<ReadonlyArray<LanServerCandidate>> {
    const raw = await discoverLanServers({ timeoutMs: 550 }).catch(() => []);
    if (raw.length === 0) return [];
    const verified = await Promise.all(
      raw.map(async (candidate): Promise<LanServerCandidate | null> => {
        try {
          const identity = await new ServerClient({
            origin: candidate.origin,
            fetchImpl: this.options.serverTransport,
          }).identity(AbortSignal.timeout(1_200));
          return {
            serverId: identity.serverId,
            displayName: identity.displayName,
            origin: candidate.origin,
          };
        } catch {
          return null;
        }
      }),
    );
    const byServer = new Map<string, LanServerCandidate>();
    for (const entry of verified) {
      if (entry !== null && !byServer.has(entry.serverId)) byServer.set(entry.serverId, entry);
    }
    return [...byServer.values()];
  }

  private async probeLanRoutes(
    account: StoredAccount,
    lanRoutes: ReadonlyArray<ServerRoute>,
    session: AccountSession | null,
  ): Promise<RouteProbeResult | null> {
    try {
      return await selectBestRoute({
        routes: lanRoutes,
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
