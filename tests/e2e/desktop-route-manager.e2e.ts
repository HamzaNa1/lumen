import { readFile } from "node:fs/promises";
import { get, request } from "node:https";
import {
  makeServerRoute,
  mergeServerRoutes,
  normalizeOrigin,
  type ServerAdvertisedRoutes,
  sortServerRoutes,
} from "@lumen/contracts";
import type {
  AccountRegistry,
  StoredAccount,
} from "../../apps/desktop/src/main/accounts/AccountRegistry";
import {
  PinnedCertificates,
  type PinSource,
} from "../../apps/desktop/src/main/api/PinnedCertificates";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { pinnedSocketOpener } from "../../apps/desktop/src/main/api/watchSocket";
import type { FetchLike } from "../../packages/client/src/ServerApi";
import { type Account, expect, test } from "./support/server";

const zeroDelays = [0, 0, 0, 0];
const refused = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const sessionOf = (admin: Account) => ({
  userId: admin.userId,
  role: "admin" as const,
  sessionId: admin.sessionId,
  accessToken: admin.accessToken,
  accessExpiresAtMs: Date.now() + 60_000,
});

/** Sends requests for `aliases` to `target`, refuses `unreachable`, and passes the rest through. */
const routedTransport =
  (target: string, aliases: ReadonlyArray<string>, unreachable: ReadonlyArray<string>): FetchLike =>
  (url, init) => {
    if (unreachable.includes(url.origin)) return refused();
    return fetch(
      aliases.includes(url.origin) ? new URL(url.pathname + url.search, target) : url,
      init,
    );
  };

/** The registry calls RouteManager makes, kept in `accounts`. */
const fakeRegistry = (
  accounts: Map<string, StoredAccount>,
  admin: Account,
  active: () => string | null = () => null,
): AccountRegistry =>
  ({
    active: () => {
      const connectionId = active();
      return connectionId === null ? null : (accounts.get(connectionId) ?? null);
    },
    find: (connectionId: string) => accounts.get(connectionId) ?? null,
    session: async () => sessionOf(admin),
    updateOrigin: async (connectionId: string, origin: string) => {
      const current = accounts.get(connectionId);
      if (current === undefined) return false;
      accounts.set(connectionId, { ...current, origin: normalizeOrigin(origin) });
      return true;
    },
    removeRoute: async (connectionId: string, origin: string) => {
      const current = accounts.get(connectionId);
      if (current === undefined) throw new Error("Connection not found");
      const normalized = normalizeOrigin(origin);
      const remaining = current.routes.filter((route) => route.origin !== normalized);
      const fallback = sortServerRoutes(remaining)[0];
      if (fallback === undefined) throw new Error("A server must keep at least one route");
      accounts.set(connectionId, {
        ...current,
        origin: current.origin === normalized ? fallback.origin : current.origin,
        routes: remaining,
      });
    },
    mergeDetectedRoutes: async (
      connectionId: string,
      detectedOrigins: ReadonlyArray<string>,
      options?: { readonly replaceDetected?: boolean },
    ) => {
      const current = accounts.get(connectionId);
      if (current === undefined) return false;
      const routes = mergeServerRoutes({
        existing: current.routes,
        detectedOrigins,
        dismissedOrigins: current.dismissedRoutes,
        credentialOrigin: current.credentialOrigin,
        ...(options?.replaceDetected === undefined
          ? {}
          : { replaceDetected: options.replaceDetected }),
      });
      accounts.set(connectionId, { ...current, routes });
      return JSON.stringify(routes) !== JSON.stringify(current.routes);
    },
    updateTls: async (connectionId: string, tls: NonNullable<StoredAccount["tls"]> | null) => {
      const current = accounts.get(connectionId);
      if (current === undefined) return false;
      const { tls: _previous, ...rest } = current;
      accounts.set(connectionId, tls === null ? rest : { ...rest, tls });
      return true;
    },
  }) as unknown as AccountRegistry;

const routesOf = (accounts: Map<string, StoredAccount>, connectionId: string) =>
  accounts.get(connectionId)?.routes.map((route) => route.origin);

test.use({
  serverEnvironment: {
    LUMEN_LAN_ORIGINS: "http://192.168.1.50:3210,https://lumen.home.arpa,http://203.0.113.7:3210",
    LUMEN_E2E_DISCOVERY_PORT: "0",
  },
});

test("desktop verifies route changes and protects credentials across server versions", async ({
  server,
  admin,
}) => {
  const { RouteIdentityMismatchError, RouteManager } = await import(
    "../../apps/desktop/src/main/api/RouteManager"
  );
  const info = await (await server.request("/api/v1/server")).json();
  const supportsRoutes = info.capabilities?.serverRoutes === true;
  // An account signed in over HTTPS must not downgrade its bearer token onto auto-detected
  // plain HTTP routes (from /api/v1/server/routes, UDP discovery, or stale saved routes).
  const httpsOrigin = "https://media.example.com";
  const localOrigin = new URL(server.origin).origin;
  const accounts = new Map<string, StoredAccount>();
  let activeConnectionId: string | null = null;
  const makeRegistry = (): AccountRegistry =>
    fakeRegistry(accounts, admin, () => activeConnectionId);
  const httpsAccount: StoredAccount = {
    connectionId: "conn-https",
    serverId: info.serverId,
    serverName: info.displayName,
    origin: httpsOrigin,
    credentialOrigin: httpsOrigin,
    routes: [makeServerRoute(localOrigin, "detected"), makeServerRoute(httpsOrigin, "manual")],
    dismissedRoutes: [],
    username: "admin",
    userId: admin.userId,
    role: "admin",
    lastConnectedAtMs: Date.now(),
  };
  accounts.set(httpsAccount.connectionId, httpsAccount);
  const homeLanOrigin = "https://lumen.home.arpa";
  const plainLanOrigin = "http://192.168.1.50:3210";
  // Away from home: neither advertised LAN route answers.
  const transport = routedTransport(localOrigin, [httpsOrigin], [homeLanOrigin, plainLanOrigin]);
  const adminSession = sessionOf(admin);
  const clients = new Map<string, ServerClient>();
  const httpsClient = new ServerClient({ origin: httpsOrigin, fetchImpl: transport });
  httpsClient.setSession(adminSession);
  await httpsClient.identity();
  clients.set(httpsAccount.connectionId, httpsClient);
  let udpDiscoveries = 0;
  const manager = new RouteManager({
    registry: makeRegistry(),
    clients,
    serverTransport: transport,
    onRouteChanged: () => undefined,
    discoverLan: async () => {
      udpDiscoveries += 1;
      return [{ serverId: info.serverId, displayName: info.displayName, origin: localOrigin }];
    },
    detectedRouteRetryDelaysMs: zeroDelays,
  });
  const resolved = await manager.resolveAccountRoute(httpsAccount, httpsClient.currentSession);
  expect(resolved.origin).toBe(httpsOrigin);
  await manager.syncServerRoutes(
    httpsAccount.connectionId,
    httpsClient,
    httpsClient.currentSession,
  );
  expect(httpsClient.serverOrigin).toBe(httpsOrigin);
  // The plain HTTP route goes, and an advertised route that does not answer is never added.
  expect(routesOf(accounts, httpsAccount.connectionId)).toEqual([httpsOrigin]);
  await manager.recheckActiveRoute(httpsAccount.connectionId);
  expect(httpsClient.serverOrigin).toBe(httpsOrigin);
  expect(udpDiscoveries).toBe(0);

  // Loopback-issued tokens stay off auto-detected plain HTTP LAN routes too, even reachable ones,
  // while still accepting HTTPS LAN routes.
  const homeManager = new RouteManager({
    registry: makeRegistry(),
    clients,
    serverTransport: routedTransport(localOrigin, [homeLanOrigin, plainLanOrigin], []),
    onRouteChanged: () => undefined,
    discoverLan: async () => [],
    detectedRouteRetryDelaysMs: zeroDelays,
  });
  const localAccount: StoredAccount = {
    ...httpsAccount,
    connectionId: "conn-local",
    origin: localOrigin,
    credentialOrigin: localOrigin,
    routes: [makeServerRoute(localOrigin, "manual")],
  };
  accounts.set(localAccount.connectionId, localAccount);
  const localClient = new ServerClient({
    origin: localOrigin,
    fetchImpl: routedTransport(localOrigin, [homeLanOrigin, plainLanOrigin], []),
  });
  localClient.setSession(adminSession);
  await localClient.identity();
  clients.set(localAccount.connectionId, localClient);
  await homeManager.syncServerRoutes(
    localAccount.connectionId,
    localClient,
    localClient.currentSession,
  );
  expect(routesOf(accounts, localAccount.connectionId)).toEqual(
    supportsRoutes ? [localOrigin, homeLanOrigin] : [localOrigin],
  );

  // Tokens explicitly signed in over plain HTTP LAN may learn plain HTTP LAN and local routes.
  const lanOrigin = "http://192.168.1.20:3210";
  const lanAccount: StoredAccount = {
    ...httpsAccount,
    connectionId: "conn-lan",
    origin: lanOrigin,
    credentialOrigin: lanOrigin,
    routes: [makeServerRoute(lanOrigin, "manual")],
  };
  accounts.set(lanAccount.connectionId, lanAccount);
  const lanTransport = routedTransport(localOrigin, [lanOrigin, homeLanOrigin], [plainLanOrigin]);
  const lanClient = new ServerClient({ origin: lanOrigin, fetchImpl: lanTransport });
  lanClient.setSession(adminSession);
  await lanClient.identity();
  clients.set(lanAccount.connectionId, lanClient);
  const lanManager = new RouteManager({
    registry: makeRegistry(),
    clients,
    serverTransport: lanTransport,
    onRouteChanged: () => undefined,
    discoverLan: async () => [],
    detectedRouteRetryDelaysMs: zeroDelays,
  });
  await lanManager.syncServerRoutes(lanAccount.connectionId, lanClient, lanClient.currentSession);
  expect(lanClient.serverOrigin).toBe(supportsRoutes ? localOrigin : lanOrigin);
  expect(routesOf(accounts, lanAccount.connectionId)).toEqual(
    supportsRoutes
      ? // Within LAN, the encrypted route ranks ahead of the plain one; the unreachable one is left out.
        [localOrigin, homeLanOrigin, lanOrigin]
      : [lanOrigin],
  );

  // A failed /api/v1/server/routes refresh must preserve cached detected fallback routes,
  // while a successful empty response still prunes stale detected entries.
  let routesRefreshMode: "fail" | "empty" | "pass" = "fail";
  const flakyTransport: FetchLike = (url, init) => {
    if (url.pathname === "/api/v1/server/routes") {
      if (routesRefreshMode === "fail")
        return Promise.resolve(new Response("unavailable", { status: 503 }));
      if (routesRefreshMode === "empty")
        return Promise.resolve(
          new Response(JSON.stringify({ routes: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
    }
    return routedTransport(localOrigin, [httpsOrigin], [homeLanOrigin, plainLanOrigin])(url, init);
  };
  const cachedRoutes = [
    makeServerRoute(homeLanOrigin, "detected"),
    makeServerRoute(httpsOrigin, "manual"),
  ];
  accounts.set(httpsAccount.connectionId, { ...httpsAccount, routes: cachedRoutes });
  const flakyClient = new ServerClient({ origin: httpsOrigin, fetchImpl: flakyTransport });
  flakyClient.setSession(adminSession);
  await flakyClient.identity();
  clients.set(httpsAccount.connectionId, flakyClient);
  const flakyManager = new RouteManager({
    registry: makeRegistry(),
    clients,
    serverTransport: flakyTransport,
    onRouteChanged: () => undefined,
    discoverLan: async () => [],
    detectedRouteRetryDelaysMs: zeroDelays,
  });
  await flakyManager.syncServerRoutes(
    httpsAccount.connectionId,
    flakyClient,
    flakyClient.currentSession,
  );
  expect(routesOf(accounts, httpsAccount.connectionId)).toEqual([homeLanOrigin, httpsOrigin]);
  routesRefreshMode = "empty";
  await flakyManager.syncServerRoutes(
    httpsAccount.connectionId,
    flakyClient,
    flakyClient.currentSession,
  );
  expect(routesOf(accounts, httpsAccount.connectionId)).toEqual(
    supportsRoutes ? [httpsOrigin] : [homeLanOrigin, httpsOrigin],
  );

  // Legacy refresh-token sessions cannot prove route identity cryptographically, so route
  // resolution ignores detected and UDP-discovered routes even when they claim the same serverId.
  const legacyRemoteOrigin = "http://remote.lumen.test:3210";
  const spoofDetectedOrigin = "http://192.168.1.99:3210";
  const spoofUdpOrigin = "http://192.168.1.88:3210";
  const legacyAccount: StoredAccount = {
    ...httpsAccount,
    connectionId: "conn-legacy",
    origin: legacyRemoteOrigin,
    credentialOrigin: legacyRemoteOrigin,
    routes: [
      makeServerRoute(spoofDetectedOrigin, "detected"),
      makeServerRoute(legacyRemoteOrigin, "manual"),
    ],
  };
  accounts.set(legacyAccount.connectionId, legacyAccount);
  const probedOrigins: string[] = [];
  let legacyUdpDiscoveries = 0;
  const legacyTransport: FetchLike = (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    probedOrigins.push(url.origin);
    if (url.origin === spoofDetectedOrigin || url.origin === spoofUdpOrigin) {
      return Promise.resolve(
        new Response(JSON.stringify(info), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const raw = url.toString();
    return fetch(
      raw.startsWith(legacyRemoteOrigin) ? raw.replace(legacyRemoteOrigin, localOrigin) : raw,
      init,
    );
  };
  const legacyManager = new RouteManager({
    registry: makeRegistry(),
    clients,
    serverTransport: legacyTransport,
    onRouteChanged: () => undefined,
    discoverLan: async () => {
      legacyUdpDiscoveries += 1;
      return [{ serverId: info.serverId, displayName: info.displayName, origin: spoofUdpOrigin }];
    },
  });
  const legacySession = {
    userId: admin.userId,
    role: "admin" as const,
    sessionId: admin.sessionId,
    accessToken: "legacy-token",
    accessExpiresAtMs: Date.now() + 60_000,
    refreshToken: "legacy-refresh-token",
  };
  const legacyResolved = await legacyManager.resolveAccountRoute(legacyAccount, legacySession);
  expect(legacyResolved.origin).toBe(legacyRemoteOrigin);
  expect(legacyResolved.route.source).toBe("manual");
  expect(legacyUdpDiscoveries).toBe(0);
  expect(probedOrigins).not.toContain(spoofDetectedOrigin);
  expect(probedOrigins).not.toContain(spoofUdpOrigin);
  await expect(
    legacyManager.verifyOrigin(spoofDetectedOrigin, info.serverId, legacySession, undefined, true),
  ).rejects.toThrow("Server cannot verify this auto-detected route");

  // Removing the active route must never point a signed-in client at a fallback that failed
  // identity verification: keep the active route intact for the active connection, and detach
  // any cached inactive client instead of redirecting it.
  const imposterOrigin = "http://192.168.1.77:3210";
  const guardedAccount: StoredAccount = {
    ...httpsAccount,
    connectionId: "conn-guarded",
    origin: localOrigin,
    // Issued over plain HTTP on the LAN, so the token may also use the plain imposter address.
    credentialOrigin: "http://192.168.1.20:3210",
    routes: [makeServerRoute(localOrigin, "manual"), makeServerRoute(imposterOrigin, "manual")],
  };
  accounts.set(guardedAccount.connectionId, guardedAccount);
  const imposterTransport: FetchLike = (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
    if (url.origin === imposterOrigin) {
      if (url.pathname === "/api/v1/server") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ...info, capabilities: { ...info.capabilities, serverRoutes: true } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }
      if (url.pathname === "/api/v1/server/verify") {
        return Promise.resolve(
          new Response(JSON.stringify({ proof: "0".repeat(64) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    return fetch(url.toString(), init);
  };
  const guardedClient = new ServerClient({ origin: localOrigin, fetchImpl: imposterTransport });
  guardedClient.setSession(adminSession);
  clients.set(guardedAccount.connectionId, guardedClient);
  activeConnectionId = guardedAccount.connectionId;
  const guardedManager = new RouteManager({
    registry: makeRegistry(),
    clients,
    serverTransport: imposterTransport,
    onRouteChanged: () => undefined,
    discoverLan: async () => [],
  });
  // A token issued over loopback may not go to the plain LAN address, so that address cannot be
  // the only route left.
  accounts.set(guardedAccount.connectionId, { ...guardedAccount, credentialOrigin: localOrigin });
  await expect(
    guardedManager.removeRoute(guardedAccount.connectionId, localOrigin),
  ).rejects.toThrow("A server must keep at least one route this connection can use");
  accounts.set(guardedAccount.connectionId, guardedAccount);
  await expect(
    guardedManager.removeRoute(guardedAccount.connectionId, localOrigin),
  ).rejects.toThrow(RouteIdentityMismatchError);
  expect(guardedClient.serverOrigin).toBe(localOrigin);
  expect(clients.get(guardedAccount.connectionId)).toBe(guardedClient);
  expect(accounts.get(guardedAccount.connectionId)?.origin).toBe(localOrigin);
  expect(accounts.get(guardedAccount.connectionId)?.routes.map((route) => route.origin)).toEqual([
    localOrigin,
    imposterOrigin,
  ]);

  // When the connection is not active, removing the route detaches the cached signed-in client
  // instead of leaving it pointed at the unverified fallback.
  activeConnectionId = null;
  expect(await guardedManager.removeRoute(guardedAccount.connectionId, localOrigin)).toBe(false);
  expect(clients.has(guardedAccount.connectionId)).toBe(false);
  expect(guardedClient.currentSession).toBeNull();
  expect(guardedClient.serverOrigin).toBe(localOrigin);
});

test("desktop adds an auto-detected route only once it answers", async ({ server, admin }) => {
  const { RouteManager } = await import("../../apps/desktop/src/main/api/RouteManager");
  const info = await (await server.request("/api/v1/server")).json();
  const localOrigin = new URL(server.origin).origin;
  // Signed in over plain HTTP on the LAN, so both advertised LAN routes may carry the token.
  const lanOrigin = "http://192.168.1.20:3210";
  const plainLanOrigin = "http://192.168.1.50:3210";
  const homeLanOrigin = "https://lumen.home.arpa";
  const udpOrigin = "http://192.168.1.70:3210";
  // A LAN can use publicly routed addresses; a UDP reply still came from this network.
  const routedUdpOrigin = "http://203.0.113.7:3210";
  let udp: string[] = [];
  let discovering: Promise<void> | undefined;
  const accounts = new Map<string, StoredAccount>();
  const account: StoredAccount = {
    connectionId: "conn",
    serverId: info.serverId,
    serverName: info.displayName,
    origin: lanOrigin,
    credentialOrigin: lanOrigin,
    routes: [makeServerRoute(lanOrigin, "manual")],
    // Loopback routes would answer at once; the test lets them in only where it means to.
    dismissedRoutes: [localOrigin, "http://127.0.0.1:3210"],
    username: "admin",
    userId: admin.userId,
    role: "admin",
    lastConnectedAtMs: Date.now(),
  };
  accounts.set(account.connectionId, account);

  type Reply = "answer" | "refuse" | "busy" | "stranger" | "hang";
  let reply: (origin: string, attempt: number) => Reply = () => "answer";
  const attempts = new Map<string, number>();
  let hanging: (() => void) | null = null;
  let hangAborted = false;
  let holdRouteList = false;
  let lan: "up" | "down" | "stranger" = "up";
  let strangerSawSession = false;
  let routeLists = 0;
  const hang = (init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        hangAborted = true;
        reject(init.signal?.reason);
      });
      hanging?.();
    });
  const transport: FetchLike = (url, init) => {
    if (url.pathname === "/api/v1/server/routes") routeLists += 1;
    if (holdRouteList && url.pathname === "/api/v1/server/routes") return hang(init);
    if (url.origin === lanOrigin) {
      if (lan === "up") return fetch(new URL(url.pathname + url.search, localOrigin), init);
      if (lan === "down") return refused();
      if (url.pathname === "/api/v1/server")
        return Promise.resolve(json({ ...info, serverId: "another-server" }));
      strangerSawSession = true;
      return refused();
    }
    const attempt = (attempts.get(url.origin) ?? 0) + (url.pathname === "/api/v1/server" ? 1 : 0);
    attempts.set(url.origin, attempt);
    switch (reply(url.origin, attempt)) {
      case "refuse":
        return refused();
      case "busy":
        return Promise.resolve(new Response("", { status: 408 }));
      case "stranger":
        return Promise.resolve(json({ ...info, serverId: "another-server" }));
      case "hang":
        return hang(init);
      case "answer":
        return fetch(new URL(url.pathname + url.search, localOrigin), init);
    }
  };
  const client = new ServerClient({ origin: lanOrigin, fetchImpl: transport });
  client.setSession(sessionOf(admin));
  await client.identity();
  const clients = new Map([[account.connectionId, client]]);
  const switches: string[] = [];
  let listChanges = 0;
  const manager = new RouteManager({
    registry: fakeRegistry(accounts, admin),
    clients,
    serverTransport: transport,
    onRouteChanged: (_connectionId, origin) => switches.push(origin),
    onRouteListChanged: () => {
      listChanges += 1;
    },
    discoverLan: async () => {
      await discovering;
      return udp.map((origin) => ({
        serverId: info.serverId,
        displayName: info.displayName,
        origin,
      }));
    },
    detectedRouteRetryDelaysMs: zeroDelays,
  });
  const sync = () => manager.syncServerRoutes(account.connectionId, client, client.currentSession);
  const update = (change: Partial<StoredAccount>) =>
    accounts.set(account.connectionId, {
      ...(accounts.get(account.connectionId) ?? account),
      ...change,
    });
  const backOnLan = () => {
    client.setServerOrigin(lanOrigin);
    update({ origin: lanOrigin });
  };

  // A route that misses its first tries joins once it answers, even after another answered at once.
  // Another server answering is final, so that route is tried once and left out.
  udp = [udpOrigin, routedUdpOrigin];
  let whileRetrying: ReturnType<typeof routesOf>;
  reply = (origin, attempt) => {
    if (origin === homeLanOrigin) return "stranger";
    if (origin !== plainLanOrigin || attempt > 2) return "answer";
    if (attempt === 2) whileRetrying = routesOf(accounts, account.connectionId);
    return attempt === 1 ? "busy" : "refuse";
  };
  await sync();
  // Routes that answered on the first try were already listed while the slower one retried.
  expect(whileRetrying).toEqual([lanOrigin, udpOrigin, routedUdpOrigin]);
  expect(routesOf(accounts, account.connectionId)).toEqual([
    lanOrigin,
    udpOrigin,
    plainLanOrigin,
    routedUdpOrigin,
  ]);
  expect(attempts.get(plainLanOrigin)).toBe(3);
  expect(attempts.get(udpOrigin)).toBe(1);
  expect(attempts.get(homeLanOrigin)).toBe(1);
  // Learning backup routes shows them without moving the client, which would reconnect its watch group.
  expect(listChanges).toBeGreaterThan(0);
  expect(switches).toEqual([]);

  // Away from the server's network nothing answers and no UDP reply comes: every try is spent,
  // the routes the server still advertises stay for when the device returns, and none joins.
  attempts.clear();
  udp = [];
  reply = () => "refuse";
  await sync();
  expect(routesOf(accounts, account.connectionId)).toEqual([
    lanOrigin,
    plainLanOrigin,
    routedUdpOrigin,
  ]);
  expect(attempts.get(plainLanOrigin)).toBe(5);
  expect(attempts.get(homeLanOrigin)).toBe(5);

  // Once a LAN route answers, the ones that used every try without answering leave.
  attempts.clear();
  reply = (origin) => (origin === homeLanOrigin ? "answer" : "refuse");
  await sync();
  expect(routesOf(accounts, account.connectionId)).toEqual([homeLanOrigin, lanOrigin]);
  expect(attempts.get(plainLanOrigin)).toBe(5);

  // Only loopback answering says nothing about the LAN, so the learned LAN route stays.
  backOnLan();
  update({ dismissedRoutes: ["http://127.0.0.1:3210"] });
  reply = (origin) => (origin === localOrigin ? "answer" : "refuse");
  await sync();
  expect(routesOf(accounts, account.connectionId)).toEqual([localOrigin, homeLanOrigin, lanOrigin]);

  // A loopback route the viewer set up (a local proxy, say) retires the detected one, so nothing
  // bypasses it, even while no route answers.
  backOnLan();
  const proxyOrigin = "http://localhost:8080";
  update({
    routes: [
      ...(accounts.get(account.connectionId)?.routes ?? []),
      makeServerRoute(proxyOrigin, "manual"),
    ],
  });
  reply = () => "refuse";
  await sync();
  expect(routesOf(accounts, account.connectionId)).toEqual([proxyOrigin, homeLanOrigin, lanOrigin]);
  update({
    routes: (accounts.get(account.connectionId)?.routes ?? []).filter(
      (route) => route.origin !== proxyOrigin,
    ),
    dismissedRoutes: [localOrigin, "http://127.0.0.1:3210"],
  });

  // A newer sync cancels the one still waiting on a route, which then changes nothing.
  backOnLan();
  reply = (origin) => (origin === plainLanOrigin ? "hang" : "refuse");
  const waiting = new Promise<void>((resolve) => {
    hanging = resolve;
  });
  const first = sync();
  await waiting;
  reply = (origin) => (origin === plainLanOrigin ? "answer" : "refuse");
  const second = sync();
  expect(await first).toBe(false);
  expect(hangAborted).toBe(true);
  await second;
  expect(routesOf(accounts, account.connectionId)).toEqual([lanOrigin, plainLanOrigin]);

  // It also stops waiting for a route list that has not arrived.
  hangAborted = false;
  holdRouteList = true;
  const listing = new Promise<void>((resolve) => {
    hanging = resolve;
  });
  const stalled = sync();
  await listing;
  holdRouteList = false;
  const fresh = sync();
  expect(await stalled).toBe(false);
  expect(hangAborted).toBe(true);
  await fresh;

  // Restoring an account and the periodic check keep a discovered route only once it answers.
  const strayOrigin = "http://192.168.1.90:3210";
  udp = [strayOrigin];
  reply = () => "refuse";
  const learned = routesOf(accounts, account.connectionId);
  await manager.resolveAccountRoute(
    accounts.get(account.connectionId) ?? account,
    client.currentSession,
  );
  await manager.recheckActiveRoute(account.connectionId);
  expect(routesOf(accounts, account.connectionId)).toEqual(learned);

  // A wake or network change during a periodic check still gets its full sync once that check ends.
  let discovered: () => void = () => undefined;
  discovering = new Promise<void>((resolve) => {
    discovered = resolve;
  });
  const periodic = manager.recheckActiveRoute(account.connectionId);
  const woken = manager.recheckActiveRoute(account.connectionId, { checkCurrent: true });
  const listsBefore = routeLists;
  discovered();
  discovering = undefined;
  await Promise.all([periodic, woken]);
  await expect.poll(() => routeLists).toBeGreaterThan(listsBefore);

  // After a wake the server answers at a new address that refuses its first probe, so the wake's own
  // route check fails; the background sync still runs and keeps trying the new address.
  const movedOrigin = "http://192.168.1.80:3210";
  lan = "down";
  udp = [movedOrigin];
  attempts.clear();
  reply = (origin, attempt) => (origin === movedOrigin && attempt > 1 ? "answer" : "refuse");
  await manager.recheckActiveRoute(account.connectionId, { checkCurrent: true });
  await expect.poll(() => routesOf(accounts, account.connectionId)).toContain(movedOrigin);

  // If the wake's address now answers as another server, the sync never sends it the session.
  lan = "stranger";
  attempts.clear();
  reply = () => "refuse";
  await manager.recheckActiveRoute(account.connectionId, { checkCurrent: true });
  // The wake's own check tries the moved address once and the sync five more times.
  await expect.poll(() => attempts.get(movedOrigin)).toBe(6);
  expect(strangerSawSession).toBe(false);
  lan = "up";
  udp = [strayOrigin];
  backOnLan();

  // A check still holding a replaced client cannot cancel the sync of the client that replaced it.
  hangAborted = false;
  holdRouteList = true;
  const listingAgain = new Promise<void>((resolve) => {
    hanging = resolve;
  });
  const current = sync();
  await listingAgain;
  const replaced = new ServerClient({ origin: lanOrigin, fetchImpl: transport });
  expect(
    await manager.syncServerRoutes(account.connectionId, replaced, client.currentSession),
  ).toBe(false);
  expect(hangAborted).toBe(false);
  holdRouteList = false;
  const after = sync();
  expect(await current).toBe(false);
  await after;

  // Signing out stops the tries still to come.
  attempts.clear();
  reply = (_origin, attempt) => {
    if (attempt === 1) clients.delete(account.connectionId);
    return "refuse";
  };
  expect(await sync()).toBe(false);
  expect(attempts.get(strayOrigin)).toBe(1);
});

test("desktop account file ends with the latest of overlapping writes", async () => {
  const { writePrivateJson } = await import("../../apps/desktop/src/main/storage/writePrivateJson");
  const path = test.info().outputPath("connections.json");
  // Background route sync writes while sign-in and activation do. The larger, older snapshot takes
  // longer to write, so it lands last unless writes to one file keep their order.
  const older = { accounts: "x".repeat(8_000_000) };
  const newer = { accounts: "latest" };
  await Promise.all([writePrivateJson(path, older), writePrivateJson(path, newer)]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(newer);
});

/** GETs a JSON path over HTTPS, trusting what `pins` trusts for the origin's host. */
const getOverTls = (pins: PinnedCertificates, origin: string, path: string): Promise<unknown> => {
  const url = new URL(path, origin);
  const trust = pins.tlsOptions(url.hostname);
  return new Promise((resolve, reject) => {
    get(url, { ca: [...trust.ca], checkServerIdentity: trust.checkServerIdentity }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      response.on("error", reject);
    }).on("error", reject);
  });
};

/** HTTPS over Node that trusts what `pins` trusts for each host, sending `aliases` to a target. */
const pinnedTransport =
  (pins: PinnedCertificates, aliases: ReadonlyMap<string, URL>): FetchLike =>
  (url, init) => {
    if (url.protocol !== "https:") return fetch(url, init);
    const target = aliases.get(url.host) ?? url;
    const trust = pins.tlsOptions(url.hostname);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: target.hostname,
          port: target.port,
          path: url.pathname + url.search,
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          ca: [...trust.ca],
          checkServerIdentity: trust.checkServerIdentity,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve(
              new Response(new Uint8Array(Buffer.concat(chunks)), {
                status: response.statusCode ?? 500,
                headers: { "content-type": String(response.headers["content-type"] ?? "") },
              }),
            ),
          );
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(typeof init.body === "string" ? init.body : undefined);
    });
  };

test.describe("desktop route transports", () => {
  test.use({
    serverEnvironment: { LUMEN_TLS_PORT: "0", LUMEN_LAN_ORIGINS: "https://lumen.home.arpa" },
  });

  test("verifies an HTTPS route from LUMEN_LAN_ORIGINS with the server's certificate", async ({
    server,
    admin,
  }) => {
    const { RouteManager } = await import("../../apps/desktop/src/main/api/RouteManager");
    const info = await server.api<{ serverId: string; displayName: string }>("/server");
    const advertised = await server.api<ServerAdvertisedRoutes>("/server/routes", {
      token: admin.accessToken,
    });
    const tlsOrigin = advertised.tls?.routes[0]?.origin;
    expect(tlsOrigin).toBeDefined();
    const localOrigin = new URL(server.origin).origin;
    const homeLanOrigin = "https://lumen.home.arpa";
    const accounts = new Map<string, StoredAccount>();
    const account: StoredAccount = {
      connectionId: "conn",
      serverId: info.serverId,
      serverName: info.displayName,
      origin: localOrigin,
      credentialOrigin: localOrigin,
      routes: [makeServerRoute(localOrigin, "manual")],
      dismissedRoutes: ["http://127.0.0.1:3210"],
      username: "admin",
      userId: admin.userId,
      role: "admin",
      lastConnectedAtMs: Date.now(),
    };
    accounts.set(account.connectionId, account);
    // The desktop trusts certificates from its accounts the same way.
    const pins = new PinnedCertificates(() => [...accounts.values()]);
    const transport = pinnedTransport(
      pins,
      new Map([["lumen.home.arpa", new URL(tlsOrigin ?? localOrigin)]]),
    );
    const client = new ServerClient({ origin: localOrigin, fetchImpl: transport });
    client.setSession(sessionOf(admin));
    await client.identity();
    const manager = new RouteManager({
      registry: fakeRegistry(accounts, admin),
      clients: new Map([[account.connectionId, client]]),
      serverTransport: transport,
      onRouteChanged: () => undefined,
      discoverLan: async () => [],
      detectedRouteRetryDelaysMs: zeroDelays,
    });
    await manager.syncServerRoutes(account.connectionId, client, client.currentSession);
    expect(routesOf(accounts, account.connectionId)).toContain(homeLanOrigin);
  });

  test("opens watch groups on the advertised route and scopes TLS pins to their hosts", async ({
    server,
    admin,
  }) => {
    const info = await server.api<{ serverId: string; capabilities?: { serverRoutes?: boolean } }>(
      "/server",
    );
    const advertised = info.capabilities?.serverRoutes
      ? await server.api<ServerAdvertisedRoutes>("/server/routes", { token: admin.accessToken })
      : undefined;
    const tlsOrigin = advertised?.tls?.routes[0]?.origin;
    let pins = new PinnedCertificates(() => []);
    if (advertised?.tls && tlsOrigin) {
      const certificate = advertised.tls.certificate;
      const pinnedOn = (origins: string[]): PinnedCertificates =>
        new PinnedCertificates((): PinSource[] => [
          { origin: "http://remote.lumen.test:3210", routes: [], tls: { certificate, origins } },
        ]);
      pins = pinnedOn([tlsOrigin]);
      expect(await getOverTls(pins, tlsOrigin, "/api/v1/server")).toMatchObject({
        serverId: info.serverId,
      });
      await expect(
        getOverTls(new PinnedCertificates(() => []), tlsOrigin, "/api/v1/server"),
      ).rejects.toThrow();
      await expect(
        getOverTls(pinnedOn(["https://192.168.1.50:3211"]), tlsOrigin, "/api/v1/server"),
      ).rejects.toThrow();
    }
    const socketUrl = new URL("/api/v1/watch-groups", tlsOrigin ?? server.origin);
    socketUrl.protocol = tlsOrigin ? "wss:" : "ws:";
    const socket = pinnedSocketOpener(pins)(socketUrl);
    try {
      const firstMessage = new Promise<unknown>((resolve, reject) => {
        socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
        socket.onerror = () => reject(new Error("Watch socket failed to connect"));
      });
      socket.onopen = () => socket.send(JSON.stringify({ token: admin.accessToken }));
      expect(await firstMessage).toMatchObject({ type: "ready" });
    } finally {
      socket.close();
    }
  });
});
