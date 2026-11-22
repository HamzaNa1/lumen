import { createHash, createHmac, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import {
  classifyRouteScope,
  type LanDiscoveryRequest,
  makeServerRoute,
  mergeServerRoutes,
  normalizeOrigin,
  sendsTokenInClear,
  sortServerRoutes,
  tokenAllowsPlainHttp,
  usableServerRoutes,
} from "@lumen/contracts";
import type {
  AccountRegistry,
  StoredAccount,
} from "../../apps/desktop/src/main/accounts/AccountRegistry";
import {
  RouteIdentityMismatchError,
  RouteManager,
} from "../../apps/desktop/src/main/api/RouteManager";
import { ServerClient } from "../../apps/desktop/src/main/api/ServerClient";
import { detectLanRoutes } from "../../apps/server/src/http/LanRoutes";
import { ServerUnreachableError } from "../../packages/client/src/errors";
import { selectBestRoute } from "../../packages/client/src/RouteSelector";
import { bearerCredentials, type FetchLike, ServerApi } from "../../packages/client/src/ServerApi";
import { expect, Server, test } from "./support/server";

const probeUdpDiscovery = async (
  port: number,
): Promise<
  Array<{ readonly serverId: string; readonly displayName: string; readonly origin: string }>
> => {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const payload = Buffer.from(
    JSON.stringify({ type: "lumen.discover", version: 1 } satisfies LanDiscoveryRequest),
    "utf8",
  );
  const found: Array<{
    readonly serverId: string;
    readonly displayName: string;
    readonly origin: string;
  }> = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = AbortSignal.timeout(1_500);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      deadline.removeEventListener("abort", onTimeout);
      socket.close();
      if (error !== undefined) reject(error);
      else resolve(found);
    };
    const onTimeout = () => finish();
    deadline.addEventListener("abort", onTimeout, { once: true });
    socket.on("error", finish);
    socket.on("message", (buffer, rinfo) => {
      const reply = JSON.parse(buffer.toString("utf8")) as {
        serverId: string;
        displayName: string;
        port: number;
      };
      found.push({
        serverId: reply.serverId,
        displayName: reply.displayName,
        origin: normalizeOrigin(`http://${rinfo.address}:${reply.port}`),
      });
      finish();
    });
    socket.bind(0, () => {
      socket.send(payload, port, "127.0.0.1", (error) => {
        if (error !== null) finish(error);
      });
    });
  });
};

test("classifies, sorts, merges routes and detects server local and LAN interfaces", () => {
  expect(classifyRouteScope("http://127.0.0.1:3210")).toBe("local");
  expect(classifyRouteScope("http://localhost:3210")).toBe("local");
  expect(classifyRouteScope("http://[::1]:3210")).toBe("local");
  expect(classifyRouteScope("http://[::ffff:127.0.0.1]:3210")).toBe("local");

  expect(classifyRouteScope("http://192.168.1.50:3210")).toBe("lan");
  expect(classifyRouteScope("http://10.0.0.12:3210")).toBe("lan");
  expect(classifyRouteScope("http://172.16.0.4:3210")).toBe("lan");
  expect(classifyRouteScope("http://172.31.255.1:3210")).toBe("lan");
  expect(classifyRouteScope("http://[fd12:3456::1]:3210")).toBe("lan");
  expect(classifyRouteScope("http://[::ffff:192.168.1.50]:3210")).toBe("lan");
  expect(classifyRouteScope("http://nas.local:3210")).toBe("lan");
  expect(classifyRouteScope("https://lumen.home.arpa")).toBe("lan");
  expect(classifyRouteScope("http://homeserver:3210")).toBe("lan");

  expect(classifyRouteScope("https://media.example.com")).toBe("remote");
  expect(classifyRouteScope("http://100.64.0.5:3210")).toBe("remote");
  expect(classifyRouteScope("http://172.32.0.1:3210")).toBe("remote");
  expect(classifyRouteScope("http://1.1.1.1:3210")).toBe("remote");

  const sorted = sortServerRoutes(
    [
      makeServerRoute("https://media.example.com", "manual"),
      makeServerRoute("http://192.168.1.50:3210", "detected"),
      makeServerRoute("http://nas.local:3210", "manual"),
      makeServerRoute("http://10.0.0.5:3210", "detected"),
      makeServerRoute("http://127.0.0.1:3210", "detected"),
    ],
    "http://10.0.0.5:3210",
  );
  expect(sorted.map((route) => route.origin)).toEqual([
    "http://127.0.0.1:3210",
    "http://nas.local:3210",
    "http://10.0.0.5:3210",
    "http://192.168.1.50:3210",
    "https://media.example.com",
  ]);

  const merged = mergeServerRoutes({
    existing: [
      makeServerRoute("https://media.example.com", "manual"),
      makeServerRoute("http://192.168.1.20:3210", "detected"),
    ],
    manualOrigins: ["http://192.168.1.20:3210"],
    detectedOrigins: [
      "http://127.0.0.1:3210",
      "http://192.168.1.50:3210",
      "http://172.17.0.2:3210",
    ],
    dismissedOrigins: ["http://172.17.0.2:3210"],
    replaceDetected: true,
  });
  expect(merged).toEqual([
    { origin: "http://127.0.0.1:3210", source: "detected", scope: "local" },
    { origin: "http://192.168.1.20:3210", source: "manual", scope: "lan" },
    { origin: "http://192.168.1.50:3210", source: "detected", scope: "lan" },
    { origin: "https://media.example.com", source: "manual", scope: "remote" },
  ]);

  // Bearer-token transport rule: only tokens issued over plain HTTP outside loopback and
  // Tailscale/VPN tunnels may be reused on auto-detected plain HTTP routes.
  expect(tokenAllowsPlainHttp("https://media.example.com")).toBe(false);
  expect(tokenAllowsPlainHttp("https://192.168.1.20:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://127.0.0.1:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://localhost:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://[::1]:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://100.101.102.103:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://[::ffff:100.101.102.103]:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://[fd7a:115c:a1e0::1]:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://box.tail1234.ts.net:3210")).toBe(false);
  expect(tokenAllowsPlainHttp("http://192.168.1.20:3210")).toBe(true);
  expect(tokenAllowsPlainHttp("http://nas.local:3210")).toBe(true);
  expect(tokenAllowsPlainHttp("http://remote.lumen.test:3210")).toBe(true);
  expect(tokenAllowsPlainHttp(null)).toBe(false);

  const detectedLan = makeServerRoute("http://192.168.1.20:3210", "detected");
  const detectedLocal = makeServerRoute("http://127.0.0.1:3210", "detected");
  const detectedHttpsLan = makeServerRoute("https://lumen.home.arpa", "detected");
  const manualLan = makeServerRoute("http://192.168.1.20:3210", "manual");
  const manualHttps = makeServerRoute("https://media.example.com", "manual");

  expect(sendsTokenInClear(detectedLan, "https://media.example.com")).toBe(true);
  expect(sendsTokenInClear(detectedLocal, "https://media.example.com")).toBe(true);
  expect(sendsTokenInClear(detectedHttpsLan, "https://media.example.com")).toBe(false);
  expect(sendsTokenInClear(manualLan, "https://media.example.com")).toBe(false);
  expect(sendsTokenInClear(detectedLan, "http://127.0.0.1:3210")).toBe(true);
  expect(sendsTokenInClear(detectedLan, "http://100.101.102.103:3210")).toBe(true);
  expect(sendsTokenInClear(detectedLan, "http://192.168.1.10:3210")).toBe(false);
  expect(sendsTokenInClear(detectedLocal, "http://192.168.1.10:3210")).toBe(false);

  expect(
    usableServerRoutes(
      [detectedLocal, detectedLan, detectedHttpsLan, manualHttps],
      "https://media.example.com",
    ),
  ).toEqual([detectedHttpsLan, manualHttps]);

  expect(
    mergeServerRoutes({
      existing: [detectedLocal, detectedLan, manualHttps],
      detectedOrigins: [
        "http://192.168.1.50:3210",
        "http://127.0.0.1:3210",
        "https://lumen.home.arpa",
      ],
      credentialOrigin: "https://media.example.com",
    }),
  ).toEqual([detectedHttpsLan, manualHttps]);

  const detected = detectLanRoutes({
    host: "::",
    port: 3210,
    extraOrigins: ["https://lumen.home.arpa"],
    interfaces: {
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      docker0: [
        {
          address: "172.17.0.1",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "02:42:ac:11:00:01",
          internal: false,
          cidr: "172.17.0.1/16",
        },
      ],
      en0: [
        {
          address: "192.168.1.50",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.50/24",
        },
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          scopeid: 4,
          cidr: "fe80::1/64",
        },
        {
          address: "fd00::50",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          scopeid: 0,
          cidr: "fd00::50/64",
        },
      ],
      utun: [
        {
          address: "100.64.0.5",
          netmask: "255.192.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "100.64.0.5/10",
        },
      ],
    },
  });
  expect(detected).toEqual([
    { origin: "https://lumen.home.arpa", scope: "lan" },
    { origin: "http://127.0.0.1:3210", scope: "local" },
    { origin: "http://[::1]:3210", scope: "local" },
    { origin: "http://192.168.1.50:3210", scope: "lan" },
    { origin: "http://172.17.0.1:3210", scope: "lan" },
    { origin: "http://[fd00::50]:3210", scope: "lan" },
  ]);
  expect(detectLanRoutes({ host: "127.0.0.1", port: 3210 })).toEqual([
    { origin: "http://127.0.0.1:3210", scope: "local" },
  ]);
});

test("selectBestRoute prioritizes local and LAN over remote and falls back when unreachable", async () => {
  const identity = { serverId: "srv-1", displayName: "Home", apiVersion: "1.0.0" };
  const local = makeServerRoute("http://127.0.0.1:3210", "detected");
  const lan = makeServerRoute("http://192.168.1.50:3210", "detected");
  const remote = makeServerRoute("https://media.example.com", "manual");

  // Local beats LAN and Remote even when Remote answers first inside the grace window.
  let releaseLocal!: () => void;
  const localGate = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const localWins = selectBestRoute({
    routes: [remote, lan, local],
    lanGraceMs: 500,
    sameScopeGraceMs: 500,
    probe: async (route) => {
      if (route.origin === local.origin) await localGate;
      return { route, origin: route.origin, identity };
    },
  });
  releaseLocal();
  expect((await localWins).origin).toBe(local.origin);

  // Local and LAN fail immediately -> falls back to remote without waiting.
  const fallback = await selectBestRoute({
    routes: [local, lan, remote],
    probe: async (route) => {
      if (route.scope !== "remote") throw new ServerUnreachableError();
      return { route, origin: route.origin, identity };
    },
  });
  expect(fallback.origin).toBe(remote.origin);

  // LAN hangs (blackholed) -> settles on remote after lanGraceMs and aborts the LAN probe.
  let lanAborted = false;
  const blackholeFallback = await selectBestRoute({
    routes: [lan, remote],
    lanGraceMs: 40,
    lanTimeoutMs: 5_000,
    probe: async (route, signal) => {
      if (route.origin === lan.origin) {
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              lanAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      return { route, origin: route.origin, identity };
    },
  });
  expect(blackholeFallback.origin).toBe(remote.origin);
  expect(lanAborted).toBe(true);
});

test("server advertises local and LAN routes, verifies session challenges without secrets, and answers UDP LAN discovery", async () => {
  const root = test.info().outputPath("routes-server");
  const server = new Server(root);
  await server.start({
    LUMEN_LAN_ORIGINS: "http://192.168.1.50:3210,https://lumen.home.arpa",
    LUMEN_E2E_DISCOVERY_PORT: "0",
  });
  try {
    const discoveryPort = server.discoveryPort;
    expect(discoveryPort).not.toBeNull();
    const info = await (await server.request("/api/v1/server")).json();
    expect(info.capabilities?.serverRoutes).toBe(true);

    // Unauthenticated requests cannot read internal local/LAN routes.
    expect((await server.request("/api/v1/server/routes")).status).toBe(401);

    const admin = await server.register("admin");
    const routesRes = await server.request("/api/v1/server/routes", {
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(routesRes.status).toBe(200);
    expect(await routesRes.json()).toEqual({
      routes: [
        { origin: "http://192.168.1.50:3210", scope: "lan" },
        { origin: "https://lumen.home.arpa", scope: "lan" },
        { origin: new URL(server.origin).origin, scope: "local" },
      ],
    });

    // Challenge verification proves server identity without ever sending the bearer secret.
    const [, secretB64 = ""] = admin.accessToken.split(".");
    const secretHash = createHash("sha256")
      .update(Buffer.from(secretB64, "base64url"))
      .digest("hex");
    const challenge = randomBytes(16).toString("hex");
    const verifyRes = await server.request("/api/v1/server/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: admin.sessionId, challenge }),
    });
    expect(verifyRes.status).toBe(200);
    const { proof } = (await verifyRes.json()) as { proof: string };
    const expectedProof = createHmac("sha256", secretHash)
      .update(`${info.serverId}:${challenge}`)
      .digest("hex");
    expect(proof).toBe(expectedProof);

    // Unknown or revoked sessions are rejected.
    const unknownVerify = await server.request("/api/v1/server/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: crypto.randomUUID(), challenge }),
    });
    expect(unknownVerify.status).toBe(401);

    // UDP LAN discovery returns the server's reachable origin and identity.
    const discovered = await probeUdpDiscovery(discoveryPort ?? 0);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toEqual({
      serverId: info.serverId,
      displayName: info.displayName,
      origin: new URL(server.origin).origin,
    });

    // ServerApi failover switches origin on GET when the primary origin is unreachable.
    let failoverCalls = 0;
    const api = new ServerApi({
      origin: "http://127.0.0.1:1",
      credentials: bearerCredentials(() => admin.accessToken),
      onUnreachable: async () => {
        failoverCalls += 1;
        return new URL(server.origin).origin;
      },
    });
    const me = await api.me();
    expect(me.username).toBe("admin");
    expect(failoverCalls).toBe(1);
    expect(api.serverOrigin).toBe(new URL(server.origin).origin);

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
    expect(accounts.get(httpsAccount.connectionId)?.routes.map((route) => route.origin)).toEqual([
      "https://lumen.home.arpa",
      httpsOrigin,
    ]);
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
    expect(accounts.get(localAccount.connectionId)?.routes.map((route) => route.origin)).toEqual([
      localOrigin,
      "https://lumen.home.arpa",
    ]);

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
    expect(lanClient.serverOrigin).toBe(localOrigin);
    expect(accounts.get(lanAccount.connectionId)?.routes.map((route) => route.origin)).toEqual([
      localOrigin,
      lanOrigin,
      "http://192.168.1.50:3210",
      "https://lumen.home.arpa",
    ]);

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
    expect(accounts.get(httpsAccount.connectionId)?.routes.map((route) => route.origin)).toEqual([
      "https://lumen.home.arpa",
      httpsOrigin,
    ]);
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
      legacyManager.verifyOrigin(
        spoofDetectedOrigin,
        info.serverId,
        legacySession,
        undefined,
        true,
      ),
    ).rejects.toThrow("Server cannot verify this auto-detected route");

    // Removing the active route must never point a signed-in client at a fallback that failed
    // identity verification: keep the active route intact for the active connection, and detach
    // any cached inactive client instead of redirecting it.
    const imposterOrigin = "http://192.168.1.77:3210";
    const guardedAccount: StoredAccount = {
      ...httpsAccount,
      connectionId: "conn-guarded",
      origin: localOrigin,
      credentialOrigin: localOrigin,
      routes: [makeServerRoute(localOrigin, "manual"), makeServerRoute(imposterOrigin, "manual")],
    };
    accounts.set(guardedAccount.connectionId, guardedAccount);
    const imposterTransport: FetchLike = (input, init) => {
      const url = typeof input === "string" ? new URL(input) : input;
      if (url.origin === imposterOrigin) {
        if (url.pathname === "/api/v1/server") {
          return Promise.resolve(
            new Response(JSON.stringify(info), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
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
  } finally {
    await server.stop();
  }
});
