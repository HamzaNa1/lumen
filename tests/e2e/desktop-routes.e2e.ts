import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerAdvertisedRoutes } from "@lumen/contracts";
import { openSettings } from "./support/browser";
import { closeDesktop, expect, launchDesktop, mainDesktopPage, test } from "./support/desktop";
import { NetworkProxy } from "./support/proxy";
import { password, Server } from "./support/server";

test("desktop auto-detects local and LAN routes, prioritizes them over remote, supports manual routes, and fails over automatically", async () => {
  const testInfo = test.info();
  const root = testInfo.outputPath("multi-route-server");
  const otherRoot = testInfo.outputPath("other-server");
  const profile = join(root, "desktop-profile");
  const server = new Server(root);
  const otherServer = new Server(otherRoot);
  await server.start({ LUMEN_E2E_DISCOVERY_PORT: "0" });
  await otherServer.start();
  const lanProxy = await new NetworkProxy(server.origin).start();
  const remoteProxy = await new NetworkProxy(server.origin).start();
  const serverLocalOrigin = new URL(server.origin).origin;
  const manualLanOrigin = `http://nas.local:${new URL(lanProxy.origin).port}`;
  const remoteOrigin = `http://remote.lumen.test:${new URL(remoteProxy.origin).port}`;

  const serverInfo = await server.api<{ capabilities?: Record<string, boolean> }>("/server");
  const supportsServerRoutes = serverInfo.capabilities?.serverRoutes === true;
  const discoveryPort = server.discoveryPort;
  if (supportsServerRoutes) expect(discoveryPort).not.toBeNull();
  const admin = await server.register("admin");
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);

  const hostRules = "MAP remote.lumen.test 127.0.0.1, MAP nas.local 127.0.0.1";
  const env = {
    LUMEN_E2E_HOST_RESOLVER_RULES: hostRules,
    LUMEN_E2E_DISCOVERY_PORT: discoveryPort === null ? "off" : String(discoveryPort),
    LUMEN_E2E_LOCAL_ORIGINS: serverLocalOrigin,
  };

  let app = await launchDesktop(profile, false, env);
  try {
    let page = await mainDesktopPage(app);
    await expect(page.getByLabel("Server address")).toBeVisible();

    // Connect screen discovers the local server automatically with a Local badge.
    await expect(page.getByText("On your network", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Lumen Server/ })).toBeVisible();
    await expect(page.locator(".lan-discovered .status-pill")).toHaveText("Local");
    await testInfo.attach("connect-local-discovered", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Sign in through the remote route. Servers that advertise routes auto-detect and promote the
    // local route in the background once it answers; older released servers stay on the signed-in
    // route without trusting unverified auto-detected origins.
    await page.getByLabel("Server address").fill(remoteOrigin);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    const activeAccount = async () => {
      const list = await page.evaluate(() => window.lumen.accounts.list());
      const active = list.accounts.find((entry) => entry.connectionId === list.activeConnectionId);
      return {
        origin: active?.origin,
        routes: active?.routes?.map((route) => [route.origin, route.scope, route.source]),
      };
    };
    await expect.poll(activeAccount).toEqual({
      origin: supportsServerRoutes ? serverLocalOrigin : remoteOrigin,
      routes: supportsServerRoutes
        ? [
            [serverLocalOrigin, "local", "detected"],
            [remoteOrigin, "remote", "manual"],
          ]
        : [[remoteOrigin, "remote", "manual"]],
    });

    // Open Settings -> Routes: routes are checked automatically (no manual "Check routes" button).
    const settings = await openSettings(page, "Routes");
    await expect(settings.getByRole("button", { name: "Check routes" })).toHaveCount(0);
    await expect(settings.getByText(remoteOrigin, { exact: true })).toBeVisible();
    await expect(settings.getByText("Active", { exact: true })).toBeVisible();
    if (supportsServerRoutes) {
      await expect(settings.getByText(serverLocalOrigin, { exact: true })).toBeVisible();
      await expect(settings.getByText("Local", { exact: true })).toBeVisible();
    }

    // Adding an address that belongs to a different server is rejected.
    await settings.getByLabel("Route address").fill(new URL(otherServer.origin).origin);
    await settings.getByRole("button", { name: "Add route", exact: true }).click();
    await expect(
      settings.getByText("That address belongs to a different Lumen server."),
    ).toBeVisible();

    // Adding a manual LAN route keeps Local ahead of LAN when detected, or promotes LAN over Remote.
    await settings.getByLabel("Route address").fill(manualLanOrigin);
    await settings.getByRole("button", { name: "Add route", exact: true }).click();
    await expect(settings.getByText(manualLanOrigin, { exact: true })).toBeVisible();
    await expect(settings.getByText("LAN", { exact: true })).toBeVisible();
    await testInfo.attach("settings-routes", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    const withAllRoutes = await page.evaluate(() => window.lumen.accounts.list());
    const activeAfterLan = withAllRoutes.accounts.find(
      (entry) => entry.connectionId === withAllRoutes.activeConnectionId,
    );
    expect(activeAfterLan?.origin).toBe(supportsServerRoutes ? serverLocalOrigin : manualLanOrigin);
    expect(activeAfterLan?.routes?.map((route) => [route.origin, route.scope])).toEqual(
      supportsServerRoutes
        ? [
            [serverLocalOrigin, "local"],
            [manualLanOrigin, "lan"],
            [remoteOrigin, "remote"],
          ]
        : [
            [manualLanOrigin, "lan"],
            [remoteOrigin, "remote"],
          ],
    );

    // Adding an unreachable manual remote backup route is allowed (for away-from-home / non-hairpin setup).
    await settings.getByLabel("Route address").fill("https://backup.lumen.test");
    await settings.getByRole("button", { name: "Add route", exact: true }).click();
    await expect(settings.getByText("https://backup.lumen.test", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Remove route https://backup.lumen.test" }).click();
    await expect(settings.getByText("https://backup.lumen.test", { exact: true })).toHaveCount(0);

    if (supportsServerRoutes) {
      // Dismissing the auto-detected local route switches cleanly to the manual LAN route.
      await settings.getByRole("button", { name: `Remove route ${serverLocalOrigin}` }).click();
      await expect(settings.getByText(serverLocalOrigin, { exact: true })).toHaveCount(0);
      await expect
        .poll(async () => {
          const list = await page.evaluate(() => window.lumen.accounts.list());
          return list.accounts.find((entry) => entry.connectionId === list.activeConnectionId)
            ?.origin;
        })
        .toBe(manualLanOrigin);
    }

    // Take the LAN proxy down -> API calls seamlessly fail over to the remote route.
    await lanProxy.close();
    const librariesAfterFailover = await page.evaluate(() => window.lumen.library.list());
    expect(librariesAfterFailover).toHaveLength(1);
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.lumen.accounts.list());
        return list.accounts.find((entry) => entry.connectionId === list.activeConnectionId)
          ?.origin;
      })
      .toBe(remoteOrigin);

    // Persisted connections.json keeps routes, credentialOrigin, and dismissed origins across restarts.
    const saved = JSON.parse(await readFile(join(profile, "connections.json"), "utf8")) as {
      accounts: Array<{
        origin: string;
        credentialOrigin?: string;
        routes: Array<{ origin: string }>;
        dismissedRoutes: string[];
      }>;
    };
    expect(saved.accounts[0]?.origin).toBe(remoteOrigin);
    expect(saved.accounts[0]?.credentialOrigin).toBe(remoteOrigin);
    expect(saved.accounts[0]?.routes.map((route) => route.origin)).toEqual([
      manualLanOrigin,
      remoteOrigin,
    ]);
    expect(saved.accounts[0]?.dismissedRoutes).toEqual(
      supportsServerRoutes ? [serverLocalOrigin] : [],
    );

    // Restart desktop while LAN is down and local was dismissed: starts cleanly on the remote route.
    await closeDesktop(app);
    app = await launchDesktop(profile, false, {
      LUMEN_E2E_HOST_RESOLVER_RULES: hostRules,
      LUMEN_E2E_DISCOVERY_PORT: "off",
    });
    page = await mainDesktopPage(app);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const restarted = await page.evaluate(() => window.lumen.accounts.list());
    expect(
      restarted.accounts.find((entry) => entry.connectionId === restarted.activeConnectionId)
        ?.origin,
    ).toBe(remoteOrigin);

    // Legacy connections.json (written by older desktop without `routes`, `dismissedRoutes`, or
    // `credentialOrigin`) opens cleanly and auto-detects the server's local route via
    // /api/v1/server/routes without UDP.
    await closeDesktop(app);
    const legacy = JSON.parse(await readFile(join(profile, "connections.json"), "utf8")) as {
      activeConnectionId: string;
      accounts: Array<Record<string, unknown>>;
    };
    for (const account of legacy.accounts) {
      delete account.routes;
      delete account.dismissedRoutes;
      delete account.credentialOrigin;
    }
    await writeFile(join(profile, "connections.json"), JSON.stringify(legacy), "utf8");
    app = await launchDesktop(profile, false, {
      LUMEN_E2E_HOST_RESOLVER_RULES: hostRules,
      LUMEN_E2E_DISCOVERY_PORT: "off",
    });
    page = await mainDesktopPage(app);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.lumen.accounts.list());
        return list.accounts.find((entry) => entry.connectionId === list.activeConnectionId)
          ?.origin;
      })
      .toBe(supportsServerRoutes ? serverLocalOrigin : remoteOrigin);
    const migrated = await page.evaluate(() => window.lumen.accounts.list());
    expect(migrated.accounts[0]?.routes).toEqual(
      supportsServerRoutes
        ? [
            { origin: serverLocalOrigin, source: "detected", scope: "local" },
            { origin: remoteOrigin, source: "manual", scope: "remote" },
          ]
        : [{ origin: remoteOrigin, source: "manual", scope: "remote" }],
    );

    // An HTTPS connection whose connections.json carries a stale auto-detected plain HTTP route
    // (saved before the bearer-token transport rule) drops that plain HTTP route on load and does
    // not connect over plain HTTP even though the local server is reachable.
    await closeDesktop(app);
    const staleHttps = JSON.parse(await readFile(join(profile, "connections.json"), "utf8")) as {
      activeConnectionId: string;
      accounts: Array<Record<string, unknown>>;
    };
    const httpsRemoteOrigin = "https://remote.lumen.test";
    for (const account of staleHttps.accounts) {
      account.origin = serverLocalOrigin;
      delete account.credentialOrigin;
      account.routes = [
        { origin: serverLocalOrigin, source: "detected", scope: "local" },
        { origin: httpsRemoteOrigin, source: "manual", scope: "remote" },
      ];
      account.dismissedRoutes = [];
    }
    await writeFile(join(profile, "connections.json"), JSON.stringify(staleHttps), "utf8");
    app = await launchDesktop(profile, false, {
      LUMEN_E2E_HOST_RESOLVER_RULES: hostRules,
      LUMEN_E2E_DISCOVERY_PORT: "off",
      LUMEN_E2E_LOCAL_ORIGINS: serverLocalOrigin,
    });
    page = await mainDesktopPage(app);
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.lumen.accounts.list());
        const entry = list.accounts.find((item) => item.connectionId === list.activeConnectionId);
        return entry === undefined
          ? null
          : { origin: entry.origin, routes: entry.routes?.map((route) => route.origin) };
      })
      .toEqual({
        origin: httpsRemoteOrigin,
        routes: [httpsRemoteOrigin],
      });
  } finally {
    await closeDesktop(app).catch(() => undefined);
    await lanProxy.close().catch(() => undefined);
    await remoteProxy.close().catch(() => undefined);
    await otherServer.stop().catch(() => undefined);
    await server.stop().catch(() => undefined);
  }
});

test("desktop moves to the server's pinned LAN certificate and keeps an HTTPS sign-in off plain HTTP routes", async () => {
  const testInfo = test.info();
  const root = testInfo.outputPath("tls-route-server");
  const profile = join(root, "desktop-profile");
  const server = new Server(root);
  await server.start({ LUMEN_TLS_PORT: "0" });
  const remoteProxy = await new NetworkProxy(server.origin).start();
  const remoteOrigin = `http://remote.lumen.test:${new URL(remoteProxy.origin).port}`;
  const admin = await server.register("admin");
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const advertised = await server.api<ServerAdvertisedRoutes>("/server/routes", {
    token: admin.accessToken,
  });
  // Released servers advertise no TLS listener; the desktop then keeps to the routes it had.
  const tlsOrigin = advertised.tls?.routes[0]?.origin ?? null;
  const env = {
    LUMEN_E2E_HOST_RESOLVER_RULES: "MAP remote.lumen.test 127.0.0.1",
    LUMEN_E2E_LOCAL_ORIGINS: "off",
  };
  const activeOrigin = async (page: Awaited<ReturnType<typeof mainDesktopPage>>) => {
    const list = await page.evaluate(() => window.lumen.accounts.list());
    return list.accounts.find((entry) => entry.connectionId === list.activeConnectionId)?.origin;
  };

  let app = await launchDesktop(profile, false, env);
  try {
    // A token issued over plain HTTP may use the plain local route, but the encrypted one ranks
    // first, and every transport the desktop has (API, media, watch socket) trusts its certificate.
    let page = await mainDesktopPage(app);
    await page.getByLabel("Server address").fill(remoteOrigin);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect.poll(() => activeOrigin(page)).toBe(tlsOrigin ?? new URL(server.origin).origin);
    expect(await page.evaluate(() => window.lumen.library.list())).toHaveLength(1);
    await expect
      .poll(() => page.evaluate(async () => (await window.lumen.watch.state()).connection))
      .toBe("connected");
    await page.getByRole("link", { name: "movies", exact: true }).click();
    await page
      .getByRole("button", { name: "Play Film", exact: true })
      .first()
      .click({ force: true });
    await expect
      .poll(() => page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({ paused: false });
    await page.evaluate(() => window.lumen.player.stop());
    await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();

    // The same connection as if its token had been issued over HTTPS, with a manual plain HTTP
    // route beside the encrypted one: the plain route is kept for the viewer but never contacted.
    await closeDesktop(app);
    const saved = JSON.parse(await readFile(join(profile, "connections.json"), "utf8")) as {
      accounts: Array<Record<string, unknown>>;
    };
    for (const account of saved.accounts) {
      account.credentialOrigin = "https://remote.lumen.test";
      account.origin = remoteOrigin;
      account.routes = [
        { origin: remoteOrigin, source: "manual", scope: "remote" },
        ...(tlsOrigin === null ? [] : [{ origin: tlsOrigin, source: "detected", scope: "local" }]),
      ];
    }
    await writeFile(join(profile, "connections.json"), JSON.stringify(saved), "utf8");
    remoteProxy.requests.length = 0;
    app = await launchDesktop(profile, false, env);
    page = await mainDesktopPage(app);
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.lumen.accounts.list());
        return list.accounts[0]?.routesNeedingSignIn?.map((route) => route.origin);
      })
      .toEqual([remoteOrigin]);
    if (tlsOrigin !== null) {
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await expect.poll(() => activeOrigin(page)).toBe(tlsOrigin);
      const settings = await openSettings(page, "Routes");
      await expect(settings.getByText(remoteOrigin, { exact: true })).toBeVisible();
      await expect(settings.getByText("Sign-in required", { exact: true })).toBeVisible();
      await testInfo.attach("settings-route-needs-sign-in", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      // The encrypted route is the only one this connection can use, so only the plain one can go.
      await expect(settings.getByRole("button", { name: `Remove route ${tlsOrigin}` })).toHaveCount(
        0,
      );
      await settings.getByRole("button", { name: `Remove route ${remoteOrigin}` }).click();
      await expect(settings.getByText(remoteOrigin, { exact: true })).toHaveCount(0);
    }
    expect(remoteProxy.requests).toEqual([]);
  } finally {
    await closeDesktop(app).catch(() => undefined);
    await remoteProxy.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
  }
});

test("a sign-in the desktop cannot save leaves no account behind", async () => {
  const root = test.info().outputPath("unsaved-sign-in");
  const profile = join(root, "desktop-profile");
  const server = new Server(root);
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await server.start();
    await server.register("admin");
    // The token is saved, but the connection list cannot be replaced.
    await mkdir(join(profile, "connections.json"), { recursive: true });
    app = await launchDesktop(profile, false, { LUMEN_E2E_LOCAL_ORIGINS: "off" });
    const page = await mainDesktopPage(app);
    await page.getByLabel("Server address").fill(server.origin);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(/could not save the connection/)).toBeVisible();
    expect(await page.evaluate(() => window.lumen.accounts.list())).toMatchObject({
      activeConnectionId: null,
      accounts: [],
    });
  } finally {
    if (app !== undefined) await closeDesktop(app).catch(() => undefined);
    await server.stop().catch(() => undefined);
  }
});

test("switching back to an account moves past a route that answers with something else", async () => {
  const root = test.info().outputPath("failing-cached-route");
  const profile = join(root, "desktop-profile");
  const server = new Server(root);
  let remoteProxy: NetworkProxy | undefined;
  let lanProxy: NetworkProxy | undefined;
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await server.start();
    const admin = await server.register("admin");
    await server.api("/users", {
      token: admin.accessToken,
      body: {
        username: "viewer",
        displayName: "Viewer",
        password,
        libraryAccess: { scope: "all" },
      },
    });
    remoteProxy = await new NetworkProxy(server.origin).start();
    lanProxy = await new NetworkProxy(server.origin).start();
    const remoteOrigin = `http://remote.lumen.test:${new URL(remoteProxy.origin).port}`;
    const lanOrigin = `http://nas.local:${new URL(lanProxy.origin).port}`;
    // Keep the account on the remote route: no advertised routes, and the LAN route starts down.
    let remote: "routes-hidden" | "failing" = "routes-hidden";
    remoteProxy.intercept = async (request, response) => {
      if (remote === "failing") {
        // An access gateway in front of the tunnel answers with its own login page.
        response.writeHead(200, { "content-type": "text/html" }).end("<form>Sign in</form>");
        return true;
      }
      if (!request.url?.startsWith("/api/v1/server/routes")) return false;
      response.writeHead(200, { "content-type": "application/json" }).end('{"routes":[]}');
      return true;
    };
    let lanUp = false;
    lanProxy.intercept = async (_request, response) => {
      if (lanUp) return false;
      response.destroy();
      return true;
    };
    app = await launchDesktop(profile, false, {
      LUMEN_E2E_HOST_RESOLVER_RULES: "MAP remote.lumen.test 127.0.0.1, MAP nas.local 127.0.0.1",
      LUMEN_E2E_LOCAL_ORIGINS: "off",
    });
    const page = await mainDesktopPage(app);
    await page.getByLabel("Server address").fill(remoteOrigin);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const first =
      (await page.evaluate(() => window.lumen.accounts.list())).activeConnectionId ?? "";
    await page.evaluate(({ id, origin }) => window.lumen.routes.add(id, origin), {
      id: first,
      origin: lanOrigin,
    });
    await page.evaluate((origin) => window.lumen.accounts.discoverServer(origin), remoteOrigin);
    await page.evaluate(
      ({ origin, password }) =>
        window.lumen.accounts.connect({ origin, username: "viewer", password }),
      { origin: remoteOrigin, password },
    );

    // Back home with the tunnel broken: the remote route errors while the saved LAN route answers.
    remote = "failing";
    lanUp = true;
    const list = await page.evaluate((id) => window.lumen.accounts.activate(id), first);
    expect(list.activeConnectionId).toBe(first);
    expect(list.accounts.find((entry) => entry.connectionId === first)?.origin).toBe(lanOrigin);
  } finally {
    if (app !== undefined) await closeDesktop(app).catch(() => undefined);
    await remoteProxy?.close().catch(() => undefined);
    await lanProxy?.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
  }
});
