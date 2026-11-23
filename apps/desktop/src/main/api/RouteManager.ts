import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import {
  type FetchLike,
  type RouteProbeResult,
  ServerHttpError,
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
  routePriority,
  type ServerRoute,
  sendsTokenInClear,
  tokenAllowsPlainHttp,
  usableServerRoutes,
} from "@lumen/contracts";
import type { AccountRegistry, StoredAccount } from "../accounts/AccountRegistry";
import { configuredDiscoveryConfig, discoverLanServers } from "./LanDiscoveryClient";
import { type AccountSession, ServerClient } from "./ServerClient";

const DEFAULT_LOCAL_ORIGINS = ["http://127.0.0.1:3210"];
const INTERFACE_POLL_INTERVAL_MS = 5_000;
const REMOTE_RECHECK_INTERVAL_MS = 30_000;
const FOCUS_RECHECK_COOLDOWN_MS = 10_000;
const DETECTED_ROUTE_TIMEOUT_MS = 1_000;
// Five tries over about twelve seconds, so a brief blip does not keep a working route out.
const DETECTED_ROUTE_RETRY_DELAYS_MS = [1_000, 1_000, 2_000, 4_000];

/** Failures that may pass on their own; any other answer will not change on a retry. */
const isTransientRouteFailure = (cause: unknown): boolean =>
  cause instanceof ServerUnreachableError ||
  (cause instanceof ServerHttpError &&
    (cause.status >= 500 || cause.status === 408 || cause.status === 429)) ||
  (cause instanceof Error && cause.name === "TimeoutError");

const waitUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

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

const originPriority = (origin: string): number =>
  routePriority({ origin, scope: classifyRouteScope(origin) });

/**
 * When a viewer explicitly configured a local loopback route (for example a local reverse proxy
 * or port forward), avoid auto-adding competing loopback ports that would bypass it.
 */
const hasManualLocalRoute = (account: StoredAccount): boolean =>
  account.routes.some((route) => route.source === "manual" && route.scope === "local");

const allowsDetectedOrigin = (account: StoredAccount, origin: string): boolean => {
  try {
    return !sendsTokenInClear(makeServerRoute(origin, "detected"), account.credentialOrigin);
  } catch {
    return false;
  }
};

/** One background route sync: whom it serves, and whether a newer one or a sign-out replaced it. */
interface RouteSync {
  readonly client: ServerClient;
  readonly session: AccountSession | null;
  readonly signal: AbortSignal;
  readonly stale: () => boolean;
}

export interface RouteManagerOptions {
  readonly registry: AccountRegistry;
  readonly clients: Map<string, ServerClient>;
  readonly serverTransport: FetchLike;
  /** Called when a connection's live client moves to another origin. */
  readonly onRouteChanged: (connectionId: string, origin: string) => void;
  /** Called when a connection's saved routes change while its client stays where it is. */
  readonly onRouteListChanged?: (connectionId: string) => void;
  /** Called when a server's pinned LAN certificate is learned, replaced, or dropped. */
  readonly onPinsChanged?: () => void;
  readonly discoverLan?: (signal?: AbortSignal) => Promise<ReadonlyArray<LanServerCandidate>>;
  /** Waits between tries of an auto-detected route; tests pass zeros. */
  readonly detectedRouteRetryDelaysMs?: ReadonlyArray<number>;
}

/**
 * Coordinates multi-route selection, local and LAN auto-detection, cryptographic route verification
 * before presenting bearer tokens on candidate routes, and automatic failover / promotion.
 */
export class RouteManager {
  private readonly failovers = new Map<string, Promise<string | null>>();
  private readonly promotionChecks = new Map<string, Promise<void>>();
  private readonly routeSyncs = new Map<string, AbortController>();
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
    options: {
      readonly excludeOrigin?: string;
      readonly skipUdpDiscovery?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RouteProbeResult> {
    const canVerifyDetected = hasSessionToken(session);
    const manualLocal = hasManualLocalRoute(account);
    const allowPlainHttp = tokenAllowsPlainHttp(account.credentialOrigin);
    let discoveredOrigins: string[] = [];
    if (canVerifyDetected && !options.skipUdpDiscovery && allowPlainHttp) {
      const discovered = await this.discoverLanImpl(options.signal).catch(() => []);
      discoveredOrigins = discovered
        .filter(
          (candidate) =>
            candidate.serverId === account.serverId &&
            allowsDetectedOrigin(account, candidate.origin) &&
            (!manualLocal || classifyRouteScope(candidate.origin) !== "local"),
        )
        .map((candidate) => candidate.origin);
    }

    const dismissed = new Set(account.dismissedRoutes);
    const localCandidates =
      !canVerifyDetected || manualLocal
        ? []
        : localDiscoveryOrigins().filter(
            (origin) => !dismissed.has(origin) && allowsDetectedOrigin(account, origin),
          );

    const candidates = usableServerRoutes(
      mergeServerRoutes({
        existing: account.routes,
        detectedOrigins: [...discoveredOrigins, ...localCandidates],
        dismissedOrigins: account.dismissedRoutes,
        credentialOrigin: account.credentialOrigin,
      }),
      account.credentialOrigin,
    ).filter(
      (route) =>
        (canVerifyDetected || route.source === "manual") &&
        (options.excludeOrigin === undefined ? true : route.origin !== options.excludeOrigin),
    );

    if (candidates.length === 0) throw new ServerUnreachableError();

    const winner = await selectBestRoute({
      routes: candidates,
      activeOrigin: account.origin,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      probe: async (route, signal) => {
        const identity = await this.verifyOrigin(
          route.origin,
          account.serverId,
          session,
          signal,
          route.source === "detected",
        );
        return { route, origin: route.origin, identity };
      },
    });

    if (winner.route.source === "detected") {
      await this.options.registry
        .mergeDetectedRoutes(account.connectionId, [winner.origin])
        .catch(() => false);
    }
    return winner;
  }

  /**
   * Adds the local and LAN routes that answer from this device and promotes the client to a better
   * one. Its retries take seconds, so callers must not wait on it; a newer sync cancels it. The LAN
   * certificate is pinned from an answer that came over the route this token already travels.
   */
  async syncServerRoutes(
    connectionId: string,
    client: ServerClient,
    session: AccountSession | null,
  ): Promise<boolean> {
    // A caller holding a replaced client must not cancel the sync of the client that replaced it.
    if (this.options.clients.get(connectionId) !== client) return false;
    this.routeSyncs.get(connectionId)?.abort();
    const controller = new AbortController();
    this.routeSyncs.set(connectionId, controller);
    try {
      return await this.runRouteSync(connectionId, client, session, controller.signal);
    } finally {
      if (this.routeSyncs.get(connectionId) === controller) this.routeSyncs.delete(connectionId);
    }
  }

  private async runRouteSync(
    connectionId: string,
    client: ServerClient,
    session: AccountSession | null,
    signal: AbortSignal,
  ): Promise<boolean> {
    const account = this.options.registry.find(connectionId);
    if (account === null) return false;
    const allowPlainHttp = tokenAllowsPlainHttp(account.credentialOrigin);
    const [advertised, udp] = await Promise.all([
      client.supportsServerRoutes
        ? client.advertisedRoutes(signal).catch(() => null)
        : Promise.resolve(null),
      allowPlainHttp ? this.discoverLanImpl(signal).catch(() => []) : Promise.resolve([]),
    ]);
    const stale = () => signal.aborted || this.options.clients.get(connectionId) !== client;
    if (stale()) return false;

    const advertisedRoutes = [...(advertised?.routes ?? []), ...(advertised?.tls?.routes ?? [])];
    if (advertised !== null) {
      // Routes from LUMEN_LAN_ORIGINS are listed apart from the TLS routes but use the same
      // certificate, and the pin must cover them before they can verify.
      const pinnedOrigins = new Set(advertised.tls?.routes.map((route) => route.origin));
      for (const route of advertisedRoutes)
        if (route.scope !== "remote" && /^https:/iu.test(route.origin))
          pinnedOrigins.add(route.origin);
      const pinned = await this.options.registry
        .updateTls(
          connectionId,
          advertised.tls === undefined
            ? null
            : { certificate: advertised.tls.certificate, origins: [...pinnedOrigins] },
        )
        .catch(() => false);
      if (pinned) this.options.onPinsChanged?.();
    }

    const manualLocal = hasManualLocalRoute(account);
    const dismissed = new Set(account.dismissedRoutes);
    const candidates = new Set<string>();
    const eligible = (origin: string, anyScope = false): boolean => {
      if (dismissed.has(origin) || !allowsDetectedOrigin(account, origin)) return false;
      const scope = classifyRouteScope(origin);
      return scope === "local" ? !manualLocal : scope === "lan" || anyScope;
    };
    for (const route of advertisedRoutes)
      if (route.scope !== "remote" && eligible(route.origin)) candidates.add(route.origin);
    // A UDP reply came from this network, even from an address that looks public.
    for (const candidate of udp)
      if (candidate.serverId === account.serverId && eligible(candidate.origin, true))
        candidates.add(candidate.origin);
    for (const origin of localDiscoveryOrigins()) if (eligible(origin)) candidates.add(origin);

    const sync = { client, session, signal, stale };
    let changed = false;
    const commit = async (detected: ReadonlyArray<string>, replace: boolean): Promise<void> => {
      if (stale()) return;
      const merged = await this.options.registry.mergeDetectedRoutes(connectionId, detected, {
        replaceDetected: replace,
      });
      changed ||= merged;
      if (stale()) return;
      if (await this.promoteClient(connectionId, sync)) changed = true;
      else if (merged) this.options.onRouteListChanged?.(connectionId);
    };
    // Routes join after the try they answer in, while the others keep their remaining tries.
    const verified = await this.verifyDetectedOrigins(
      [...candidates],
      account.serverId,
      sync,
      (answered) => commit(answered, false),
    );
    if (stale()) return false;
    // No LAN route answering usually means this device is away from the server's network, so the
    // routes it learned stay for its return. Once one answers, the rest are unreachable from here.
    const latest = this.options.registry.find(connectionId);
    if (latest === null) return false;
    const kept = verified.some((origin) => classifyRouteScope(origin) === "lan")
      ? []
      : latest.routes
          .filter(
            (route) =>
              route.source === "detected" &&
              (candidates.has(route.origin) ||
                (eligible(route.origin, true) &&
                  advertisedRoutes.some((advertised) => advertised.origin === route.origin))),
          )
          .map((route) => route.origin);
    await commit([...new Set([...verified, ...kept])], advertised !== null);
    return changed && !stale();
  }

  /** Moves the client to a stored route that ranks above its current one and answers. */
  private async promoteClient(connectionId: string, sync: RouteSync): Promise<boolean> {
    const account = this.options.registry.find(connectionId);
    if (account === null) return false;
    const currentPriority = originPriority(sync.client.serverOrigin);
    const betterRoutes = usableServerRoutes(account.routes, account.credentialOrigin).filter(
      (route) => originPriority(route.origin) < currentPriority,
    );
    if (betterRoutes.length === 0) return false;
    const promoted = await this.probeCandidateRoutes(account, betterRoutes, sync.session);
    if (promoted === null || promoted.origin === sync.client.serverOrigin || sync.stale())
      return false;
    await this.switchClientOrigin(connectionId, sync.client, promoted.origin);
    return true;
  }

  /**
   * Tries each origin up to five times, retrying only failures that may pass, and hands the ones
   * each try verifies to `onVerified`. Returns every origin that verified.
   */
  private async verifyDetectedOrigins(
    origins: ReadonlyArray<string>,
    serverId: string,
    sync: RouteSync,
    onVerified: (origins: ReadonlyArray<string>) => Promise<void>,
  ): Promise<ReadonlyArray<string>> {
    const delays = this.options.detectedRouteRetryDelaysMs ?? DETECTED_ROUTE_RETRY_DELAYS_MS;
    const verified: string[] = [];
    let pending = origins;
    for (let attempt = 0; pending.length > 0 && !sync.stale(); attempt += 1) {
      const results = await Promise.all(
        pending.map(async (origin) => {
          if (origin === sync.client.serverOrigin) return { origin, verified: true, retry: false };
          try {
            await this.verifyOrigin(
              origin,
              serverId,
              sync.session,
              AbortSignal.any([sync.signal, AbortSignal.timeout(DETECTED_ROUTE_TIMEOUT_MS)]),
              true,
            );
            return { origin, verified: true, retry: false };
          } catch (cause) {
            return { origin, verified: false, retry: isTransientRouteFailure(cause) };
          }
        }),
      );
      const answered = results.filter((result) => result.verified).map((result) => result.origin);
      verified.push(...answered);
      if (answered.length > 0 && !sync.stale()) await onVerified(answered);
      pending = results.filter((result) => result.retry).map((result) => result.origin);
      const delay = delays[attempt];
      if (delay === undefined || pending.length === 0 || sync.stale()) break;
      await waitUnlessAborted(delay, sync.signal);
    }
    return verified;
  }

  /**
   * Removes `origin` from `connectionId`. When a live signed-in client is using that route,
   * verifies a remaining route before switching so credentials are never sent to an unverified
   * or mismatched fallback. Returns true when a live client switched routes.
   */
  async removeRoute(connectionId: string, origin: string): Promise<boolean> {
    const account = this.options.registry.find(connectionId);
    if (account === null) throw new Error("Connection not found");
    const normalized = normalizeOrigin(origin);
    const existingRoutes = mergeServerRoutes({
      existing: account.routes,
      credentialOrigin: account.credentialOrigin,
    });
    if (!existingRoutes.some((route) => route.origin === normalized)) return false;
    const remaining = usableServerRoutes(
      existingRoutes.filter((route) => route.origin !== normalized),
      account.credentialOrigin,
    );
    if (remaining.length === 0)
      throw new Error("A server must keep at least one route this connection can use");

    const client = this.options.clients.get(connectionId);
    if (client !== undefined && client.serverOrigin === normalized) {
      const session = client.currentSession ?? (await this.options.registry.session(connectionId));
      const candidates = hasSessionToken(session)
        ? remaining
        : remaining.filter((route) => route.source === "manual");
      try {
        const winner = await selectBestRoute({
          routes: candidates,
          activeOrigin: account.origin,
          probe: async (route, signal) => {
            const identity = await this.verifyOrigin(
              route.origin,
              account.serverId,
              session,
              signal,
              route.source === "detected",
            );
            return { route, origin: route.origin, identity };
          },
        });
        await this.options.registry.removeRoute(connectionId, normalized);
        if (this.options.clients.get(connectionId) === client) {
          await this.switchClientOrigin(connectionId, client, winner.origin);
          return true;
        }
        return false;
      } catch (cause) {
        if (this.options.registry.active()?.connectionId === connectionId) throw cause;
        client.cancelPending();
        client.setSession(null);
        this.options.clients.delete(connectionId);
      }
    }

    await this.options.registry.removeRoute(connectionId, normalized);
    return false;
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
    // A wake or network change still needs its own full check after an ordinary one in progress.
    if (existing !== undefined)
      return options.checkCurrent
        ? existing.then(
            () => this.recheckActiveRoute(connectionId, options),
            () => this.recheckActiveRoute(connectionId, options),
          )
        : existing;
    const task = (async () => {
      const client = this.options.clients.get(connectionId);
      const account = this.options.registry.find(connectionId);
      if (client === undefined || account === null) return;
      const session = client.currentSession ?? (await this.options.registry.session(connectionId));
      const currentPriority = originPriority(client.serverOrigin);

      if (options.checkCurrent) {
        try {
          const winner = await this.resolveAccountRoute(account, session);
          if (winner.origin !== client.serverOrigin)
            await this.switchClientOrigin(connectionId, client, winner.origin);
        } catch {
          // Nothing answered yet; the sync's own tries may still reach a route.
        }
        void this.syncServerRoutes(connectionId, client, session).catch(() => false);
        return;
      }

      if (currentPriority === 0) return;

      const canVerifyDetected = hasSessionToken(session);
      const manualLocal = hasManualLocalRoute(account);
      const allowPlainHttp = canVerifyDetected && tokenAllowsPlainHttp(account.credentialOrigin);
      const udp = allowPlainHttp ? await this.discoverLanImpl().catch(() => []) : [];
      const udpOrigins = udp
        .filter(
          (candidate) =>
            candidate.serverId === account.serverId &&
            allowsDetectedOrigin(account, candidate.origin),
        )
        .map((candidate) => candidate.origin);
      const dismissed = new Set(account.dismissedRoutes);
      const candidateOrigins = [
        ...udpOrigins.filter(
          (origin) =>
            !dismissed.has(origin) && (!manualLocal || classifyRouteScope(origin) !== "local"),
        ),
        ...(!canVerifyDetected || manualLocal
          ? []
          : localDiscoveryOrigins().filter(
              (origin) => !dismissed.has(origin) && allowsDetectedOrigin(account, origin),
            )),
      ];
      const latest = this.options.registry.find(connectionId);
      if (latest === null) return;
      const higherCandidates = usableServerRoutes(
        mergeServerRoutes({
          existing: latest.routes,
          detectedOrigins: candidateOrigins,
          dismissedOrigins: latest.dismissedRoutes,
          credentialOrigin: latest.credentialOrigin,
        }),
        latest.credentialOrigin,
      ).filter((route) => originPriority(route.origin) < currentPriority);
      if (higherCandidates.length === 0) return;

      const winner = await this.probeCandidateRoutes(latest, higherCandidates, session);
      if (winner !== null && winner.origin !== client.serverOrigin) {
        if (winner.route.source === "detected")
          await this.options.registry.mergeDetectedRoutes(latest.connectionId, [winner.origin]);
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
      if (client === undefined || originPriority(client.serverOrigin) === 0) return;
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
      if (existing === undefined || originPriority(entry.origin) < originPriority(existing.origin))
        byServer.set(entry.serverId, entry);
    }
    return [...byServer.values()].sort(
      (a, b) =>
        originPriority(a.origin) - originPriority(b.origin) || a.origin.localeCompare(b.origin),
    );
  }

  private async probeCandidateRoutes(
    account: StoredAccount,
    routes: ReadonlyArray<ServerRoute>,
    session: AccountSession | null,
  ): Promise<RouteProbeResult | null> {
    const usable = usableServerRoutes(routes, account.credentialOrigin);
    if (usable.length === 0) return null;
    try {
      return await selectBestRoute({
        routes: usable,
        activeOrigin: account.origin,
        probe: async (route, signal) => {
          const identity = await this.verifyOrigin(
            route.origin,
            account.serverId,
            session,
            signal,
            route.source === "detected",
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
