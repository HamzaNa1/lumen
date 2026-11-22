import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  classifyRouteScope,
  makeServerRoute,
  mergeServerRoutes,
  sortServerRoutes,
} from "@lumen/contracts";
import { discoverLanServers } from "../../apps/desktop/src/main/api/LanDiscoveryClient";
import { detectLanRoutes } from "../../apps/server/src/http/LanRoutes";
import { ServerUnreachableError } from "../../packages/client/src/errors";
import { selectBestRoute } from "../../packages/client/src/RouteSelector";
import { bearerCredentials, ServerApi } from "../../packages/client/src/ServerApi";
import { expect, Server, test } from "./support/server";

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
    const discovered = await discoverLanServers({
      port: discoveryPort ?? 0,
      targets: ["127.0.0.1"],
      timeoutMs: 300,
    });
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
  } finally {
    await server.stop();
  }
});
