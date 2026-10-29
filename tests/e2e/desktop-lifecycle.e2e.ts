import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "./support/database";
import { connectDesktop, expect, test } from "./support/desktop";
import { latch, NetworkProxy } from "./support/proxy";
import { password } from "./support/server";

test("native windows remain aligned through fullscreen, hiding, focus, Back and immediate replay; quitting saves progress", async ({
  server,
  admin,
  desktop,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const item = (await server.items(admin.accessToken, library.id))[0];
  const { page, app } = desktop;
  await connectDesktop(page, server);
  await page.getByRole("link", { name: "movies", exact: true }).click();
  const main = await app.browserWindow(page);
  for (let cycle = 0; cycle < 2; cycle++) {
    await page
      .getByRole("button", { name: "Play Film", exact: true })
      .first()
      .click({ force: true });
    await expect
      .poll(() => page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({ paused: false });
    for (const full of [true, true, false]) {
      await main.evaluate((window) => window.focus());
      await main.evaluate((window) => {
        const observed = window as typeof window & {
          e2eFullscreen?: boolean;
          e2eObserving?: boolean;
        };
        if (observed.e2eObserving) return;
        observed.e2eObserving = true;
        observed.e2eFullscreen = window.isFullScreen();
        window.on("enter-full-screen", () => {
          observed.e2eFullscreen = true;
        });
        window.on("leave-full-screen", () => {
          observed.e2eFullscreen = false;
        });
      });
      await test.step(`cycle ${cycle}: fullscreen ${full}`, () =>
        page.evaluate((enabled) => window.lumen.player.fullscreen(enabled), full));
      await expect
        .poll(() =>
          main.evaluate(
            (window) => (window as typeof window & { e2eFullscreen?: boolean }).e2eFullscreen,
          ),
        )
        .toBe(full);
      await expect
        .poll(() => page.evaluate(() => window.lumen.player.fullscreenState()))
        .toBe(full);
      await expect.poll(() => main.evaluate((window) => window.isFullScreen())).toBe(full);
      const parentId = await main.evaluate((window) => window.id);
      await expect
        .poll(() =>
          app.evaluate(({ BaseWindow, BrowserWindow }, parentId) => {
            const parent = BrowserWindow.fromId(parentId);
            if (!parent) return false;
            if (process.platform === "win32") return BaseWindow.getAllWindows().length === 1;
            const expected = parent.getContentBounds();
            const children = BaseWindow.getAllWindows().filter(
              (window) => window.getParentWindow()?.id === parentId,
            );
            return (
              children.length > 0 &&
              children.every((child) => {
                const bounds = child.getBounds();
                return (
                  Math.abs(bounds.x - expected.x) <= 1 &&
                  Math.abs(bounds.y - expected.y) <= 1 &&
                  Math.abs(bounds.width - expected.width) <= 1 &&
                  Math.abs(bounds.height - expected.height) <= 1
                );
              })
            );
          }, parentId),
        )
        .toBe(true);
    }
    await main.evaluate((window) => window.hide());
    await expect
      .poll(() =>
        app.evaluate(
          ({ BaseWindow }) =>
            BaseWindow.getAllWindows().filter((window) => window.isVisible()).length,
        ),
      )
      .toBe(0);
    await main.evaluate((window) => {
      window.show();
      window.focus();
    });
    await expect.poll(() => main.evaluate((window) => window.isVisible())).toBe(true);
    await page.evaluate(async () => {
      const state = await window.lumen.player.state();
      if (!state) throw new Error("No playback");
      await window.lumen.player.pause(state.sessionId, true);
      await window.lumen.player.seek(state.sessionId, 6);
    });
    await page.evaluate(() => window.lumen.player.stop());
    await expect.poll(() => page.evaluate(() => window.lumen.player.state())).toBeNull();
    await page.evaluate(() => history.back());
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Play Film", exact: true }).first().click({ force: true });
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ itemId: item?.id });
  await app.close();
  const db = openDatabase(server.databasePath);
  try {
    expect(
      db.prepare("SELECT count(*) AS count FROM playback_sessions WHERE closed_at_ms IS NULL").get()
        ?.count,
    ).toBe(0);
    expect(
      db
        .prepare("SELECT position_seconds AS position FROM item_watch_states WHERE item_id = ?")
        .get(item?.id ?? "")?.position,
    ).toBeGreaterThanOrEqual(5);
  } finally {
    db.close();
  }
});

test("switching accounts stops playback, isolates catalog and credentials, and removing an account survives restart", async ({
  server,
  admin,
  desktop,
}) => {
  await server.library(admin.accessToken, "movies", ["Private.mp4"]);
  await server.api("/users", {
    token: admin.accessToken,
    body: { username: "viewer", displayName: "Viewer", password },
  });
  const { page, profile } = desktop;
  await connectDesktop(page, server);
  const first = (await page.evaluate(() => window.lumen.accounts.list())).activeConnectionId ?? "";
  await page.getByRole("link", { name: "movies", exact: true }).click();
  await page
    .getByRole("button", { name: "Play Private", exact: true })
    .first()
    .click({ force: true });
  await expect.poll(() => page.evaluate(() => window.lumen.player.state())).not.toBeNull();
  await page.evaluate(
    (origin) => window.lumen.accounts.discoverServer(origin),
    new URL(server.origin).origin,
  );
  const next = await page.evaluate(
    ({ origin, password }) =>
      window.lumen.accounts.connect({ origin, username: "viewer", password }),
    { origin: new URL(server.origin).origin, password },
  );
  expect(next.accounts).toHaveLength(2);
  expect(await page.evaluate(() => window.lumen.player.state())).toBeNull();
  expect(await page.evaluate(() => window.lumen.library.list())).toEqual([]);
  await page.evaluate((id) => window.lumen.accounts.activate(id), first);
  expect(await page.evaluate(() => window.lumen.library.list())).toHaveLength(1);
  await page.evaluate((id) => window.lumen.accounts.remove(id), first);
  const accounts = await page.evaluate(() => window.lumen.accounts.list());
  expect(accounts.accounts).toHaveLength(1);
  expect(accounts.accounts[0]?.username).toBe("viewer");
  await expect(page.evaluate((id) => window.lumen.accounts.activate(id), first)).rejects.toThrow();
  const saved = await readFile(join(profile, "connections.json"), "utf8");
  expect(saved).not.toContain("accessToken");
  expect(saved).not.toContain(password);
  if (process.platform !== "win32")
    expect((await stat(join(profile, "connections.json"))).mode & 0o077).toBe(0);
  expect(await page.evaluate(() => window.lumen.updates.ready())).toBeNull();
  await expect(
    page.evaluate(() =>
      window.lumen.library.artwork({ id: "http://127.0.0.1/arbitrary", revision: "bad" }),
    ),
  ).rejects.toThrow();
});

test("a stalled progress response cannot block native pause, local samples or final teardown", async ({
  server,
  admin,
  desktop,
}) => {
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const proxy = await new NetworkProxy(server.origin).start();
  const held = latch();
  let pending = 0;
  try {
    await connectDesktop(desktop.page, proxy);
    await desktop.page.getByRole("link", { name: "movies", exact: true }).click();
    await desktop.page
      .getByRole("button", { name: "Play Film", exact: true })
      .first()
      .click({ force: true });
    await expect
      .poll(() =>
        desktop.page.evaluate(
          async () => (await window.lumen.player.state())?.positionSeconds ?? 0,
        ),
      )
      .toBeGreaterThan(0.2);
    proxy.intercept = async (request, response) => {
      if (request.url?.endsWith("/progress") && pending === 0) {
        pending++;
        await held.promise;
        response.writeHead(503).end();
        return true;
      }
      return false;
    };
    await desktop.page.evaluate(async () => {
      const state = await window.lumen.player.state();
      if (!state) throw new Error("No playback");
      await window.lumen.player.pause(state.sessionId, true);
    });
    await expect.poll(() => pending).toBe(1);
    await expect
      .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({ paused: true });
    await desktop.page.evaluate(async () => {
      const state = await window.lumen.player.state();
      if (!state) throw new Error("No playback");
      await window.lumen.player.seek(state.sessionId, 8);
    });
    await expect
      .poll(() => desktop.page.evaluate(() => window.lumen.player.state()))
      .toMatchObject({ positionSeconds: 8 });
    held.release();
    await desktop.page.evaluate(() => window.lumen.player.stop());
    expect(await desktop.page.evaluate(() => window.lumen.player.state())).toBeNull();
  } finally {
    held.release();
    await proxy.close();
  }
});

test("Windows main-window capture contains video and inline controls, and a killed helper can be retried", async ({
  server,
  admin,
  desktop,
}) => {
  test.skip(process.platform !== "win32", "Windows shared D3D11 compositor");
  test.setTimeout(120000);
  await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  const { page, app } = desktop;
  await connectDesktop(page, server);
  await page.getByRole("link", { name: "movies", exact: true }).click();
  await page.getByRole("button", { name: "Play Film", exact: true }).first().click();
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: false });
  await expect(page.locator(".watch-page.has-inline-controls canvas")).toBeVisible();
  await page.mouse.move(300, 300);
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toBeVisible();
  const main = await app.browserWindow(page);
  expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)).toBe(1);
  const capture = async () =>
    main.evaluate(async (window) => {
      const image = await window.webContents.capturePage();
      const { width, height } = image.getSize();
      const pixels = image.toBitmap();
      let red = 0;
      // Inspect the central video region, excluding controls and window chrome.
      for (let y = Math.floor(height * 0.25); y < height * 0.65; y += 4)
        for (let x = Math.floor(width * 0.25); x < width * 0.75; x += 4) {
          const offset = (y * width + x) * 4;
          const b = pixels[offset] ?? 0,
            g = pixels[offset + 1] ?? 0,
            r = pixels[offset + 2] ?? 0;
          if (r > 200 && g < 40 && b < 40) red++;
        }
      return red;
    });
  await expect.poll(capture).toBeGreaterThan(100);
  await main.evaluate((window) => window.setContentSize(960, 640));
  await expect.poll(capture).toBeGreaterThan(100);
  await page.evaluate(async () => {
    const state = await window.lumen.player.state();
    if (!state) throw new Error("Playback missing");
    await window.lumen.player.pause(state.sessionId, true);
    await window.lumen.player.seek(state.sessionId, 5);
  });
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: true });
  await expect.poll(capture).toBeGreaterThan(100);
  await page.evaluate(() => window.lumen.player.fullscreen(true));
  await expect.poll(capture).toBeGreaterThan(100);
  await test.info().attach("Windows single compositor playback", {
    body: Buffer.from(
      await main.evaluate(async (window) =>
        (await window.webContents.capturePage()).toPNG().toString("base64"),
      ),
      "base64",
    ),
    contentType: "image/png",
  });
  const { execFileSync, spawnSync } = await import("node:child_process");
  const nativeProof = test.info().outputPath("windows-presentation");
  await page.evaluate(() => window.lumen.player.fullscreen(false));
  await page.mouse.move(300, 300);
  const handle = await main.evaluate((window) =>
    window.getNativeWindowHandle().readBigUInt64LE().toString(),
  );
  try {
    const presentation = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        join(import.meta.dirname, "support/windows-presentation.ps1"),
        "-WindowHandle",
        handle,
        "-OutputDirectory",
        nativeProof,
      ],
      { timeout: 35000, encoding: "utf8" },
    );
    // Keep recovery evidence even if a native presentation assertion fails.
    expect.soft(presentation.status, `${presentation.error ?? ""}\n${presentation.stderr}`).toBe(0);
  } finally {
    for (const name of ["window", "restored", "thumbnail", "alt-tab", "after-alt-tab"]) {
      const path = join(nativeProof, `native-${name}.png`);
      if (await stat(path).catch(() => null))
        await test.info().attach(`Windows ${name}`, { path, contentType: "image/png" });
    }
  }
  // Kill at the OS boundary: the real helper, decoder and Electron import path remain in use.
  const electronPid = await app.evaluate(() => process.pid);
  const helpers = (): number[] => {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Lumen Video Helper.exe' -and $_.ParentProcessId -eq ${electronPid} } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: "utf8" },
    );
    return output.trim().split(/\s+/).filter(Boolean).map(Number);
  };
  const before = helpers();
  expect(before).toHaveLength(1);
  process.kill(before[0] as number, "SIGKILL");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect.poll(helpers).toHaveLength(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.lumen.player.state()))
    .toMatchObject({ paused: false });
  await expect.poll(capture).toBeGreaterThan(100);
  expect(helpers()).toHaveLength(1);
  await page.evaluate(() => {
    const canvas = document.querySelector(".watch-surface canvas") as HTMLCanvasElement | null;
    const context = canvas?.getContext("webgl2");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("Cannot exercise GPU context loss");
    extension.loseContext();
  });
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect.poll(helpers).toHaveLength(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(capture).toBeGreaterThan(100);
  expect(helpers()).toHaveLength(1);
  await page.evaluate(() => window.lumen.player.stop());
  await expect.poll(helpers).toHaveLength(0);
});
