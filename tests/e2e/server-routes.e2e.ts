import { createHash, createHmac, randomBytes, X509Certificate } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { connect } from "node:tls";
import {
  classifyRouteScope,
  type LanDiscoveryRequest,
  makeServerRoute,
  mergeServerRoutes,
  normalizeOrigin,
  type ServerAdvertisedRoutes,
  sendsTokenInClear,
  sortServerRoutes,
  tokenAllowsPlainHttp,
  usableServerRoutes,
} from "@lumen/contracts";
import { ServerUnreachableError } from "../../packages/client/src/errors";
import { selectBestRoute } from "../../packages/client/src/RouteSelector";
import { bearerCredentials, ServerApi } from "../../packages/client/src/ServerApi";
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

test("classifies, sorts, merges routes and detects server local, LAN and VPN interfaces", async () => {
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

  expect(classifyRouteScope("http://100.64.0.5:3210")).toBe("vpn");
  expect(classifyRouteScope("http://100.127.255.254:3210")).toBe("vpn");
  expect(classifyRouteScope("http://[::ffff:100.101.102.103]:3210")).toBe("vpn");
  expect(classifyRouteScope("http://[fd7a:115c:a1e0::1]:3210")).toBe("vpn");
  expect(classifyRouteScope("https://box.tail1234.ts.net.")).toBe("vpn");
  expect(classifyRouteScope("http://[fd7a:115c:a1e1::1]:3210")).toBe("lan");

  expect(classifyRouteScope("https://media.example.com")).toBe("remote");
  expect(classifyRouteScope("http://100.128.0.1:3210")).toBe("remote");
  expect(classifyRouteScope("http://172.32.0.1:3210")).toBe("remote");
  expect(classifyRouteScope("http://1.1.1.1:3210")).toBe("remote");

  const sorted = sortServerRoutes(
    [
      makeServerRoute("https://media.example.com", "manual"),
      makeServerRoute("http://192.168.1.50:3210", "detected"),
      makeServerRoute("http://nas.local:3210", "manual"),
      makeServerRoute("http://10.0.0.5:3210", "detected"),
      makeServerRoute("http://127.0.0.1:3210", "detected"),
      makeServerRoute("https://192.168.1.50:3211", "detected"),
      makeServerRoute("http://100.64.0.5:3210", "detected"),
      // The server found this one on a VPN interface, so it is VPN whatever its address says.
      makeServerRoute("http://10.8.0.1:3210", "detected", true),
    ],
    "http://10.0.0.5:3210",
  );
  expect(sorted.map((route) => route.origin)).toEqual([
    "http://127.0.0.1:3210",
    // Within a scope an encrypted route goes first, even ahead of a manual plain HTTP one.
    "https://192.168.1.50:3211",
    "http://nas.local:3210",
    "http://10.0.0.5:3210",
    "http://192.168.1.50:3210",
    "http://100.64.0.5:3210",
    "http://10.8.0.1:3210",
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

  // The server's VPN label sticks to a route through later merges and a manual re-add.
  const withVpn = mergeServerRoutes({
    existing: merged,
    detectedOrigins: ["http://10.8.0.1:3210"],
    vpnOrigins: ["http://10.8.0.1:3210"],
  });
  expect(withVpn.find((route) => route.origin === "http://10.8.0.1:3210")).toEqual({
    origin: "http://10.8.0.1:3210",
    source: "detected",
    scope: "vpn",
  });
  expect(
    mergeServerRoutes({ existing: withVpn, manualOrigins: ["http://10.8.0.1:3210"] }).find(
      (route) => route.origin === "http://10.8.0.1:3210",
    ),
  ).toEqual({ origin: "http://10.8.0.1:3210", source: "manual", scope: "vpn" });
  // A server that stops calling it a VPN route, once it answers with a fresh list, relabels it.
  expect(
    mergeServerRoutes({
      existing: withVpn,
      detectedOrigins: ["http://10.8.0.1:3210"],
      replaceDetected: true,
    }).find((route) => route.origin === "http://10.8.0.1:3210")?.scope,
  ).toBe("lan");

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
  // A manual plain HTTP route waits for a sign-in over it, unless the token was issued there.
  expect(sendsTokenInClear(manualLan, "https://media.example.com")).toBe(true);
  expect(sendsTokenInClear(manualLan, "http://192.168.1.20:3210/")).toBe(false);
  expect(sendsTokenInClear(detectedLocal, "http://127.0.0.1:3210")).toBe(false);
  expect(sendsTokenInClear(manualLan, "http://127.0.0.1:3210")).toBe(true);
  expect(sendsTokenInClear(detectedLan, "http://127.0.0.1:3210")).toBe(true);
  expect(sendsTokenInClear(detectedLan, "http://100.101.102.103:3210")).toBe(true);
  expect(sendsTokenInClear(detectedLan, "http://192.168.1.10:3210")).toBe(false);
  expect(sendsTokenInClear(detectedLocal, "http://192.168.1.10:3210")).toBe(false);
  // A VPN route follows the same transport rule as a LAN one.
  const detectedVpn = makeServerRoute("http://10.8.0.1:3210", "detected", true);
  expect(sendsTokenInClear(detectedVpn, "https://media.example.com")).toBe(true);
  expect(sendsTokenInClear(detectedVpn, "http://192.168.1.10:3210")).toBe(false);
  expect(
    sendsTokenInClear(
      makeServerRoute("https://10.8.0.1:3211", "detected", true),
      "https://media.example.com",
    ),
  ).toBe(false);

  expect(
    usableServerRoutes(
      [detectedLocal, detectedLan, detectedHttpsLan, manualLan, manualHttps],
      "https://media.example.com",
    ),
  ).toEqual([detectedHttpsLan, manualHttps]);

  // Auto-detected plain HTTP routes are dropped; the viewer's own stay for a sign-in or removal.
  expect(
    mergeServerRoutes({
      existing: [detectedLocal, detectedLan, manualLan, manualHttps],
      detectedOrigins: [
        "http://192.168.1.50:3210",
        "http://127.0.0.1:3210",
        "https://lumen.home.arpa",
      ],
      credentialOrigin: "https://media.example.com",
    }),
  ).toEqual([detectedHttpsLan, manualLan, manualHttps]);

  const { advertisedRoutes, detectLanRoutes } = await import(
    "../../apps/server/src/http/LanRoutes"
  );
  const detectedInterfaces: NonNullable<Parameters<typeof detectLanRoutes>[0]["interfaces"]> = {
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
    utun4: [
      {
        address: "100.64.0.5",
        netmask: "255.192.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "100.64.0.5/10",
      },
      {
        address: "fd7a:115c:a1e0::5",
        netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: false,
        scopeid: 0,
        cidr: "fd7a:115c:a1e0::5/128",
      },
      // A tunnel's link-local address needs a zone a URL cannot carry.
      {
        address: "fe80::5",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: false,
        scopeid: 9,
        cidr: "fe80::5/64",
      },
    ],
    // WireGuard addresses look like any LAN; the interface says otherwise.
    wg0: [
      {
        address: "10.8.0.1",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "10.8.0.1/24",
      },
    ],
    // A public address on a tunnel is a VPN provider's exit, which no client can reach.
    tun0: [
      {
        address: "203.0.113.9",
        netmask: "255.255.255.255",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "203.0.113.9/32",
      },
    ],
    // wg-quick names an interface after its file; a tunnel still has no hardware address.
    office: [
      {
        address: "10.9.0.1",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "10.9.0.1/24",
      },
    ],
    "ZeroTier One [8056c2e21c000001]": [
      {
        address: "172.24.0.3",
        netmask: "255.255.0.0",
        family: "IPv4",
        mac: "aa:bb:cc:00:00:03",
        internal: false,
        cidr: "172.24.0.3/16",
      },
    ],
  };
  const detected = detectLanRoutes({
    host: "::",
    port: 3210,
    extraOrigins: ["https://lumen.home.arpa"],
    interfaces: detectedInterfaces,
  });
  expect(detected).toEqual([
    { origin: "https://lumen.home.arpa", scope: "lan" },
    { origin: "http://127.0.0.1:3210", scope: "local" },
    { origin: "http://[::1]:3210", scope: "local" },
    { origin: "http://192.168.1.50:3210", scope: "lan" },
    { origin: "http://172.17.0.1:3210", scope: "lan" },
    { origin: "http://[fd00::50]:3210", scope: "lan" },
    { origin: "http://10.8.0.1:3210", scope: "vpn" },
    { origin: "http://10.9.0.1:3210", scope: "vpn" },
    { origin: "http://100.64.0.5:3210", scope: "vpn" },
    { origin: "http://172.24.0.3:3210", scope: "vpn" },
    { origin: "http://[fd7a:115c:a1e0::5]:3210", scope: "vpn" },
  ]);
  // A server bound to one VPN address advertises it as VPN, by its interface or its range.
  expect(detectLanRoutes({ host: "10.8.0.1", port: 3210, interfaces: detectedInterfaces })).toEqual(
    [{ origin: "http://10.8.0.1:3210", scope: "vpn" }],
  );
  expect(detectLanRoutes({ host: "100.64.0.5", port: 3210, interfaces: {} })).toEqual([
    { origin: "http://100.64.0.5:3210", scope: "vpn" },
  ]);
  // VPN routes travel in their own list, since released desktops reject the scope in the others.
  // Those older servers listed as LAN stay listed that way, so a server upgrade takes no route away.
  expect(
    advertisedRoutes(detected, {
      certificate: "pem",
      routes: [
        { origin: "https://127.0.0.1:3211", scope: "local" },
        { origin: "https://10.8.0.1:3211", scope: "vpn" },
      ],
    }),
  ).toEqual({
    routes: [
      ...detected.filter((route) => route.scope !== "vpn"),
      { origin: "http://10.8.0.1:3210", scope: "lan" },
      { origin: "http://10.9.0.1:3210", scope: "lan" },
      { origin: "http://172.24.0.3:3210", scope: "lan" },
      { origin: "http://[fd7a:115c:a1e0::5]:3210", scope: "lan" },
    ],
    tls: {
      certificate: "pem",
      routes: [
        { origin: "https://127.0.0.1:3211", scope: "local" },
        { origin: "https://10.8.0.1:3211", scope: "lan" },
      ],
    },
    vpnRoutes: [
      { origin: "http://10.8.0.1:3210" },
      { origin: "http://10.9.0.1:3210" },
      { origin: "http://100.64.0.5:3210" },
      { origin: "http://172.24.0.3:3210" },
      { origin: "http://[fd7a:115c:a1e0::5]:3210" },
      { origin: "https://10.8.0.1:3211" },
    ],
  });
  expect(advertisedRoutes([{ origin: "http://127.0.0.1:3210", scope: "local" }], null)).toEqual({
    routes: [{ origin: "http://127.0.0.1:3210", scope: "local" }],
  });
  // A server bound to a link-local address on a tunnel listed it as LAN before, and still does.
  const linkLocalTunnel = detectLanRoutes({
    host: "169.254.1.2",
    port: 3210,
    interfaces: {
      office: [
        {
          address: "169.254.1.2",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "169.254.1.2/16",
        },
      ],
    },
  });
  expect(advertisedRoutes(linkLocalTunnel, null)).toEqual({
    routes: [{ origin: "http://169.254.1.2:3210", scope: "lan" }],
    vpnRoutes: [{ origin: "http://169.254.1.2:3210" }],
  });
  expect(detectLanRoutes({ host: "127.0.0.1", port: 3210 })).toEqual([
    { origin: "http://127.0.0.1:3210", scope: "local" },
  ]);
  expect(
    detectLanRoutes({
      host: "0.0.0.0",
      port: 3211,
      protocol: "https",
      interfaces: { en0: detectedInterfaces.en0 ?? [] },
    }),
  ).toEqual([
    { origin: "https://127.0.0.1:3211", scope: "local" },
    { origin: "https://192.168.1.50:3211", scope: "lan" },
  ]);
});

test("selectBestRoute prioritizes local and LAN over VPN and remote and falls back when unreachable", async () => {
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

  // A VPN answering first is off the server's network, so a LAN route still gets the LAN grace.
  const vpn = makeServerRoute("http://10.8.0.1:3210", "detected", true);
  const lanOverVpn = await selectBestRoute({
    routes: [vpn, lan],
    lanGraceMs: 60_000,
    sameScopeGraceMs: 0,
    probe: async (route) => {
      // The LAN answers only once the VPN's answer has been weighed.
      if (route.origin === lan.origin) await new Promise((resolve) => setImmediate(resolve));
      return { route, origin: route.origin, identity };
    },
  });
  expect(lanOverVpn.origin).toBe(lan.origin);
});

test("server advertises local, LAN, VPN and pinned TLS routes, verifies session challenges without secrets, and answers UDP LAN discovery", async () => {
  const root = test.info().outputPath("routes-server");
  const server = new Server(root);
  const environment = {
    LUMEN_LAN_ORIGINS:
      "http://192.168.1.50:3210,https://lumen.home.arpa,https://box.tail1234.ts.net:3211",
    LUMEN_E2E_DISCOVERY_PORT: "0",
    LUMEN_TLS_PORT: "0",
  };
  await server.start(environment);
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
    const advertised = (await routesRes.json()) as ServerAdvertisedRoutes;
    expect(advertised).toEqual({
      routes: [
        { origin: "http://192.168.1.50:3210", scope: "lan" },
        { origin: "https://lumen.home.arpa", scope: "lan" },
        { origin: new URL(server.origin).origin, scope: "local" },
      ],
      tls: {
        certificate: expect.stringContaining("-----BEGIN CERTIFICATE-----"),
        routes: [
          { origin: expect.stringMatching(/^https:\/\/127\.0\.0\.1:\d+$/u), scope: "local" },
        ],
      },
      vpnRoutes: [{ origin: "https://box.tail1234.ts.net:3211" }],
    });
    const certificate = advertised.tls?.certificate ?? "";

    const tlsUrl = new URL(advertised.tls?.routes[0]?.origin ?? "");
    const tls = connect({
      host: tlsUrl.hostname,
      port: Number(tlsUrl.port),
      ca: certificate,
      // The advertised certificate identifies the listener independently of its host name.
      checkServerIdentity: () => undefined,
    });
    try {
      await once(tls, "secureConnect");
      expect(tls.getPeerCertificate().raw).toEqual(new X509Certificate(certificate).raw);
    } finally {
      tls.destroy();
    }

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

    // The certificate lives in the data directory, so a restart keeps every client's pin valid.
    await server.restart();
    const restarted = await server.api<ServerAdvertisedRoutes>("/server/routes", {
      token: admin.accessToken,
    });
    expect(restarted.tls?.certificate).toBe(certificate);

    // A TLS port that is taken costs only the encrypted routes; the server still starts.
    const blocker = createTcpServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    try {
      await server.stop();
      await server.start({
        ...environment,
        LUMEN_TLS_PORT: String(typeof address === "object" && address !== null ? address.port : 0),
      });
      const withoutTls = await server.api<ServerAdvertisedRoutes>("/server/routes", {
        token: admin.accessToken,
      });
      expect(withoutTls.tls).toBeUndefined();
      expect(withoutTls.routes).toContainEqual({
        origin: new URL(server.origin).origin,
        scope: "local",
      });
    } finally {
      blocker.close();
    }
  } finally {
    await server.stop();
  }
});
