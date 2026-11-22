import { get } from "node:https";
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
import { expect, test } from "./support/server";

test.use({
  serverEnvironment: {
    LUMEN_LAN_ORIGINS: "http://192.168.1.50:3210,https://lumen.home.arpa",
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
    ({
      active: () =>
        activeConnectionId === null ? null : (accounts.get(activeConnectionId) ?? null),
      find: (connectionId: string) => accounts.get(connectionId) ?? null,
      session: async () => ({
        userId: admin.userId,
        role: "admin" as const,
        sessionId: admin.sessionId,
        accessToken: admin.accessToken,
        accessExpiresAtMs: Date.now() + 60_000,
      }),
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
        return true;
      },
      updateTls: async (connectionId: string, tls: NonNullable<StoredAccount["tls"]> | null) => {
        const current = accounts.get(connectionId);
        if (current === undefined) return false;
        const { tls: _previous, ...rest } = current;
        accounts.set(connectionId, tls === null ? rest : { ...rest, tls });
        return true;
      },
    }) as unknown as AccountRegistry;
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
  const transport: FetchLike = (input, init) => {
    const raw = typeof input === "string" ? input : input.toString();
    const rewritten = raw.startsWith(httpsOrigin) ? raw.replace(httpsOrigin, localOrigin) : raw;
    return fetch(rewritten, init);
  };
  const adminSession = {
    userId: admin.userId,
    role: "admin" as const,
    sessionId: admin.sessionId,
    accessToken: admin.accessToken,
    accessExpiresAtMs: Date.now() + 60_000,
  };
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
  });
  const resolved = await manager.resolveAccountRoute(httpsAccount, httpsClient.currentSession);
  expect(resolved.origin).toBe(httpsOrigin);
  await manager.syncServerRoutes(
    httpsAccount.connectionId,
    httpsClient,
    httpsClient.currentSession,
  );
  expect(httpsClient.serverOrigin).toBe(httpsOrigin);
  expect(accounts.get(httpsAccount.connectionId)?.routes.map((route) => route.origin)).toEqual(
    supportsRoutes ? ["https://lumen.home.arpa", httpsOrigin] : [httpsOrigin],
  );
  await manager.recheckActiveRoute(httpsAccount.connectionId);
  expect(httpsClient.serverOrigin).toBe(httpsOrigin);
  expect(udpDiscoveries).toBe(0);

  // Loopback-issued tokens stay off auto-detected plain HTTP LAN routes too, while still
  // accepting HTTPS LAN routes.
  const localAccount: StoredAccount = {
    ...httpsAccount,
    connectionId: "conn-local",
    origin: localOrigin,
    credentialOrigin: localOrigin,
    routes: [makeServerRoute(localOrigin, "manual")],
  };
  accounts.set(localAccount.connectionId, localAccount);
  const localClient = new ServerClient({ origin: localOrigin, fetchImpl: transport });
  localClient.setSession(adminSession);
  await localClient.identity();
  clients.set(localAccount.connectionId, localClient);
  await manager.syncServerRoutes(
    localAccount.connectionId,
    localClient,
    localClient.currentSession,
  );
  expect(accounts.get(localAccount.connectionId)?.routes.map((route) => route.origin)).toEqual(
    supportsRoutes ? [localOrigin, "https://lumen.home.arpa"] : [localOrigin],
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
  const lanTransport: FetchLike = (input, init) => {
    const raw = typeof input === "string" ? input : input.toString();
    return fetch(raw.startsWith(lanOrigin) ? raw.replace(lanOrigin, localOrigin) : raw, init);
  };
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
  });
  await lanManager.syncServerRoutes(lanAccount.connectionId, lanClient, lanClient.currentSession);
  expect(lanClient.serverOrigin).toBe(supportsRoutes ? localOrigin : lanOrigin);
  expect(accounts.get(lanAccount.connectionId)?.routes.map((route) => route.origin)).toEqual(
    supportsRoutes
      ? // Within LAN, the encrypted route ranks ahead of the plain ones.
        [localOrigin, "https://lumen.home.arpa", lanOrigin, "http://192.168.1.50:3210"]
      : [lanOrigin],
  );

  // A failed /api/v1/server/routes refresh must preserve cached detected fallback routes,
  // while a successful empty response still prunes stale detected entries.
  let routesRefreshMode: "fail" | "empty" | "pass" = "fail";
  const flakyTransport: FetchLike = (input, init) => {
    const url = typeof input === "string" ? new URL(input) : input;
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
    const raw = url.toString();
    return fetch(raw.startsWith(httpsOrigin) ? raw.replace(httpsOrigin, localOrigin) : raw, init);
  };
  const flakyClient = new ServerClient({ origin: httpsOrigin, fetchImpl: flakyTransport });
  flakyClient.setSession(adminSession);
  await flakyClient.identity();
  const flakyManager = new RouteManager({
    registry: makeRegistry(),
    clients,
    serverTransport: flakyTransport,
    onRouteChanged: () => undefined,
    discoverLan: async () => [],
  });
  await flakyManager.syncServerRoutes(
    httpsAccount.connectionId,
    flakyClient,
    flakyClient.currentSession,
  );
  expect(accounts.get(httpsAccount.connectionId)?.routes.map((route) => route.origin)).toEqual(
    supportsRoutes ? ["https://lumen.home.arpa", httpsOrigin] : [httpsOrigin],
  );
  routesRefreshMode = "empty";
  await flakyManager.syncServerRoutes(
    httpsAccount.connectionId,
    flakyClient,
    flakyClient.currentSession,
  );
  expect(accounts.get(httpsAccount.connectionId)?.routes.map((route) => route.origin)).toEqual([
    httpsOrigin,
  ]);

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

test.describe("desktop route transports", () => {
  test.use({ serverEnvironment: { LUMEN_TLS_PORT: "0" } });

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
