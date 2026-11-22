import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openSettings } from "./support/browser";
import { closeDesktop, expect, launchDesktop, mainDesktopPage, test } from "./support/desktop";
import { NetworkProxy } from "./support/proxy";
import { password, Server } from "./support/server";

test("desktop auto-discovers LAN servers, prioritizes LAN routes over remote, supports manual routes, and fails over cleanly", async () => {
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
  const serverLanOrigin = new URL(server.origin).origin;
  const manualLanOrigin = new URL(lanProxy.origin).origin;
  const remoteOrigin = `http://remote.lumen.test:${new URL(remoteProxy.origin).port}`;

  const discoveryPort = server.discoveryPort;
  expect(discoveryPort).not.toBeNull();
  const admin = await server.register("admin");
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);

  const env = {
    LUMEN_E2E_HOST_RESOLVER_RULES: "MAP remote.lumen.test 127.0.0.1",
    LUMEN_E2E_DISCOVERY_PORT: String(discoveryPort),
  };

  let app = await launchDesktop(profile, false, env);
  try {
    let page = await mainDesktopPage(app);
    await expect(page.getByLabel("Server address")).toBeVisible();

    // Connect screen discovers the LAN server automatically via UDP.
    await expect(page.getByText("On your network", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Lumen Server/ })).toBeVisible();
    await testInfo.attach("connect-lan-discovered", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Sign in through the remote route; desktop auto-detects the LAN route and prioritizes it immediately.
    await page.getByLabel("Server address").fill(remoteOrigin);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    const afterSignIn = await page.evaluate(() => window.lumen.accounts.list());
    const active = afterSignIn.accounts.find(
      (account) => account.connectionId === afterSignIn.activeConnectionId,
    );
    expect(active).toBeDefined();
    expect(active?.origin).toBe(serverLanOrigin);
    expect(active?.routes?.map((route) => [route.origin, route.scope, route.source])).toEqual([
      [serverLanOrigin, "lan", "detected"],
      [remoteOrigin, "remote", "manual"],
    ]);

    // Open Settings -> General to view, add, validate, and remove routes.
    const settings = await openSettings(page, "General");
    await expect(settings.getByText(serverLanOrigin, { exact: true })).toBeVisible();
    await expect(settings.getByText(remoteOrigin, { exact: true })).toBeVisible();
    await expect(settings.getByText("Active", { exact: true })).toBeVisible();
    await testInfo.attach("settings-routes", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Adding an address that belongs to a different server is rejected.
    await settings.getByLabel("Route address").fill(new URL(otherServer.origin).origin);
    await settings.getByRole("button", { name: "Add route", exact: true }).click();
    await expect(
      settings.getByText("That address belongs to a different Lumen server."),
    ).toBeVisible();

    // Adding a reachable manual LAN route promotes it ahead of the auto-detected LAN route.
    await settings.getByLabel("Route address").fill(manualLanOrigin);
    await settings.getByRole("button", { name: "Add route", exact: true }).click();
    await expect(settings.getByText(manualLanOrigin, { exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.lumen.accounts.list());
        return list.accounts.find((entry) => entry.connectionId === list.activeConnectionId)
          ?.origin;
      })
      .toBe(manualLanOrigin);

    // Adding an unreachable manual remote backup route is allowed (for away-from-home / non-hairpin setup).
    await settings.getByLabel("Route address").fill("https://backup.lumen.test");
    await settings.getByRole("button", { name: "Add route", exact: true }).click();
    await expect(settings.getByText("https://backup.lumen.test", { exact: true })).toBeVisible();

    // Remove the backup route and dismiss the auto-detected LAN route so only manualLanOrigin and remoteOrigin remain.
    await settings.getByRole("button", { name: "Remove route https://backup.lumen.test" }).click();
    await expect(settings.getByText("https://backup.lumen.test", { exact: true })).toHaveCount(0);
    await settings.getByRole("button", { name: `Remove route ${serverLanOrigin}` }).click();
    await expect(settings.getByText(serverLanOrigin, { exact: true })).toHaveCount(0);

    // Clicking "Check routes" respects dismissed auto-detected routes and keeps the manual LAN route active.
    await settings.getByRole("button", { name: "Check routes", exact: true }).click();
    await expect(settings.getByRole("button", { name: "Check routes", exact: true })).toBeEnabled();
    await expect(settings.getByText(serverLanOrigin, { exact: true })).toHaveCount(0);

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

    // Persisted connections.json keeps all routes across restarts.
    const saved = JSON.parse(await readFile(join(profile, "connections.json"), "utf8")) as {
      accounts: Array<{
        origin: string;
        routes: Array<{ origin: string }>;
        dismissedRoutes: string[];
      }>;
    };
    expect(saved.accounts[0]?.origin).toBe(remoteOrigin);
    expect(saved.accounts[0]?.routes.map((route) => route.origin)).toEqual([
      manualLanOrigin,
      remoteOrigin,
    ]);
    expect(saved.accounts[0]?.dismissedRoutes).toEqual([serverLanOrigin]);

    // Restart desktop while LAN is still down: starts cleanly on the remote route without error.
    await closeDesktop(app);
    app = await launchDesktop(profile, false, {
      LUMEN_E2E_HOST_RESOLVER_RULES: "MAP remote.lumen.test 127.0.0.1",
      LUMEN_E2E_DISCOVERY_PORT: "off",
    });
    page = await mainDesktopPage(app);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const restarted = await page.evaluate(() => window.lumen.accounts.list());
    expect(
      restarted.accounts.find((entry) => entry.connectionId === restarted.activeConnectionId)
        ?.origin,
    ).toBe(remoteOrigin);

    // Legacy connections.json (written by older desktop without `routes` or `dismissedRoutes`) opens cleanly.
    await closeDesktop(app);
    const legacy = JSON.parse(await readFile(join(profile, "connections.json"), "utf8")) as {
      activeConnectionId: string;
      accounts: Array<Record<string, unknown>>;
    };
    for (const account of legacy.accounts) {
      delete account.routes;
      delete account.dismissedRoutes;
    }
    await writeFile(join(profile, "connections.json"), JSON.stringify(legacy), "utf8");
    app = await launchDesktop(profile, false, {
      LUMEN_E2E_HOST_RESOLVER_RULES: "MAP remote.lumen.test 127.0.0.1",
      LUMEN_E2E_DISCOVERY_PORT: "off",
    });
    page = await mainDesktopPage(app);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    const migrated = await page.evaluate(() => window.lumen.accounts.list());
    expect(migrated.accounts[0]?.routes).toEqual([
      { origin: remoteOrigin, source: "manual", scope: "remote" },
    ]);
  } finally {
    await closeDesktop(app).catch(() => undefined);
    await lanProxy.close().catch(() => undefined);
    await remoteProxy.close().catch(() => undefined);
    await otherServer.stop().catch(() => undefined);
    await server.stop().catch(() => undefined);
  }
});
