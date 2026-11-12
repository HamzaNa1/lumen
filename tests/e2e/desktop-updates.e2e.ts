import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { AppUpdateStatus } from "@lumen/contracts";
import { _electron, type ElectronApplication } from "@playwright/test";
import { connectDesktop, test as desktopTest } from "./support/desktop";
import { expect, repository, test } from "./support/server";

test("real updater waits for the viewer, recovers from failed downloads, reports progress and installs a download on the next launch", async ({
  server,
}) => {
  const root = join(server.root, "updater");
  mkdirSync(root);
  const marker = join(root, "installer-arguments.json");
  writeFileSync(
    join(root, "installer.ts"),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
  );
  execFileSync("bun", [
    "build",
    "--compile",
    join(root, "installer.ts"),
    "--outfile",
    join(root, "installer.exe"),
  ]);
  const bytes = readFileSync(join(root, "installer.exe"));
  let phase = "offline";
  let version = "9999.0.0";
  let checks = 0;
  let downloads = 0;
  const held: ServerResponse[] = [];
  const feed = createServer((req, res) => {
    if (req.url?.split("?")[0]?.endsWith(".yml")) {
      checks++;
      if (phase === "offline") {
        res.writeHead(503).end("offline");
        return;
      }
      res.end(
        `version: ${version}\nfiles:\n  - url: installer.exe\n    sha512: ${createHash("sha512").update(bytes).digest("base64")}\n    size: ${bytes.length}\npath: installer.exe\nsha512: ${createHash("sha512").update(bytes).digest("base64")}\nreleaseDate: 2026-01-01T00:00:00.000Z\n`,
      );
    } else {
      downloads++;
      if (phase === "broken") {
        res.writeHead(503).end("download unavailable");
        return;
      }
      if (phase === "held") {
        held.push(res);
        return;
      }
      res.writeHead(200, { "content-length": bytes.length }).end(bytes);
    }
  });
  await new Promise<void>((resolve) => feed.listen(0, "127.0.0.1", resolve));
  const address = feed.address();
  if (!address || typeof address === "string") throw new Error("Missing update feed port");
  const cacheBase =
    process.platform === "darwin"
      ? join(homedir(), "Library/Caches")
      : process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"))
        : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  writeFileSync(
    join(root, "update.yml"),
    `provider: generic\nurl: http://127.0.0.1:${address.port}\nupdaterCacheDirName: ${relative(cacheBase, root).replaceAll("\\", "/")}\n`,
  );
  const main = join(root, "main.cjs");
  execFileSync(
    "bun",
    [
      "build",
      "tests/e2e/support/update-entry.ts",
      "--target=node",
      "--format=cjs",
      "--packages=external",
      "--outfile",
      main,
    ],
    { cwd: repository },
  );
  symlinkSync(
    join(repository, "apps/desktop/node_modules"),
    join(root, "node_modules"),
    "junction",
  );
  const require = createRequire(join(repository, "apps/desktop/package.json"));
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    LUMEN_E2E_PROFILE: root,
    LUMEN_E2E_DESKTOP_MANIFEST: join(repository, "apps/desktop/package.json"),
    LUMEN_E2E_UPDATE_URL: `http://127.0.0.1:${address.port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    _electron.launch({
      timeout: 10000,
      executablePath: require("electron"),
      args: [main, "--no-sandbox"],
      env,
    });
  type Harness = {
    updates: {
      status: AppUpdateStatus;
      download(): Promise<void>;
      install(): void;
      setAutomatic(automatic: boolean): AppUpdateStatus;
    };
    errors: string[];
    available: string[];
    statuses: AppUpdateStatus[];
    stop(): void;
    updater: { allowPrerelease: boolean };
  };
  const harness = (app: ElectronApplication) => ({
    state: () =>
      app.evaluate(() => {
        const { updates, errors, available, statuses, updater } = (
          globalThis as unknown as { updateHarness: Harness }
        ).updateHarness;
        return {
          status: updates.status,
          errors,
          available,
          statuses,
          prerelease: updater.allowPrerelease,
        };
      }),
    run: (action: "download" | "start download" | "install" | "automatic" | "stop") =>
      app.evaluate(async (_electron, action) => {
        const { updates, stop } = (globalThis as unknown as { updateHarness: Harness })
          .updateHarness;
        if (action === "download") await updates.download();
        else if (action === "start download") void updates.download().catch(() => undefined);
        else if (action === "install") updates.install();
        else if (action === "automatic") updates.setAutomatic(true);
        else stop();
      }, action),
  });
  const settings = () => JSON.parse(readFileSync(join(root, "update-settings.json"), "utf8"));
  // The viewer turned automatic updates off: nothing downloads until they ask.
  writeFileSync(
    join(root, "update-settings.json"),
    JSON.stringify({ automatic: false, downloaded: null, attempted: null }),
  );
  const first = await launch();
  try {
    const { state, run } = harness(first);
    await expect.poll(() => checks).toBeGreaterThanOrEqual(2);
    expect(await state()).toMatchObject({
      status: { automatic: false, update: null },
      prerelease: false,
    });
    expect((await state()).errors.join(" ")).toContain("Failed to update");
    await expect(run("install")).rejects.toThrow("No update is ready");
    phase = "broken";
    await expect
      .poll(async () => (await state()).status.update)
      .toEqual({ version: "9999.0.0", phase: "available", progress: 0 });
    expect(downloads).toBe(0);
    await expect(run("download")).rejects.toThrow();
    expect(downloads).toBeGreaterThanOrEqual(1);
    expect((await state()).errors.join(" ")).toContain("Cannot download");
    // A failed download goes back to waiting for the viewer, who can try again.
    expect((await state()).status.update).toEqual({
      version: "9999.0.0",
      phase: "available",
      progress: 0,
    });
    // A release published during a download: the button names what is really downloaded.
    phase = "held";
    await run("start download");
    await expect.poll(() => held.length).toBe(1);
    version = "9999.1.0";
    await expect.poll(async () => (await state()).available).toContain("9999.1.0");
    // No later check may correct the label; only the viewer's retry follows.
    await run("stop");
    for (const response of held.splice(0)) response.writeHead(503).end("download unavailable");
    await expect.poll(async () => (await state()).status.update?.phase).toBe("available");
    phase = "ready";
    await run("automatic");
    await expect
      .poll(async () => (await state()).status, { timeout: 30000 })
      .toEqual({ automatic: true, update: { version: "9999.1.0", phase: "ready", progress: 1 } });
    const { statuses } = await state();
    expect(
      statuses.some(
        (status) => status.update?.phase === "downloading" && status.update.progress === 1,
      ),
    ).toBe(true);
    await expect
      .poll(settings)
      .toEqual({ automatic: true, downloaded: "9999.1.0", attempted: null });
  } finally {
    await first.close();
  }
  // Closed without installing: the next launch installs what was downloaded, without fetching it
  // again, but only once it has recorded that it tried, so a failing installer cannot close every launch.
  const fetched = downloads;
  const unsaveable = join(root, "update-settings.json.tmp");
  mkdirSync(unsaveable);
  const blocked = await launch();
  try {
    const { state } = harness(blocked);
    await expect
      .poll(async () => (await state()).errors.join(" "))
      .toContain("Skipped installing the downloaded update");
    expect((await state()).status.update).toEqual({
      version: "9999.1.0",
      phase: "ready",
      progress: 1,
    });
    expect(existsSync(marker)).toBe(false);
    await harness(blocked).run("stop");
  } finally {
    await blocked.close();
  }
  rmSync(unsaveable, { recursive: true });
  const second = await launch();
  const child = second.process();
  try {
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(marker, "utf8"));
        } catch {
          return null;
        }
      })
      .toEqual(["--updated", "/S", "--force-run"]);
    await expect.poll(() => child.exitCode).toBe(0);
    expect(downloads).toBe(fetched);
    expect(settings()).toEqual({ automatic: true, downloaded: "9999.1.0", attempted: "9999.1.0" });
  } finally {
    await second.close();
  }
  // The installer ran but this is still the old version: it failed, and is not tried again on its own.
  rmSync(marker);
  const third = await launch();
  try {
    const { state, run } = harness(third);
    await expect
      .poll(async () => (await state()).errors.join(" "))
      .toContain("Not installing Lumen 9999.1.0 at launch again");
    await expect
      .poll(async () => (await state()).status.update)
      .toEqual({ version: "9999.1.0", phase: "ready", progress: 1 });
    expect(existsSync(marker)).toBe(false);
    expect(downloads).toBe(fetched);
    await run("stop");
  } finally {
    await third.close();
    await new Promise<void>((resolve, reject) =>
      feed.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const releaseTest = desktopTest.extend<{ releases: { url: string; lookups: () => number } }>({
  // Started beside the server so the desktop the fixture launches can be pointed at it.
  releases: async ({ server: _ }, use) => {
    let lookups = 0;
    const feed = createServer((req, res) => {
      lookups++;
      if (req.url !== "/releases/latest" || req.headers.accept !== "application/json") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ tag_name: "v9999.0.0+desktop" }));
    });
    await new Promise<void>((resolve) => feed.listen(0, "127.0.0.1", resolve));
    const address = feed.address();
    if (!address || typeof address === "string") throw new Error("Missing release feed port");
    await use({ url: `http://127.0.0.1:${address.port}/releases`, lookups: () => lookups });
    await new Promise<void>((resolve, reject) =>
      feed.close((error) => (error ? reject(error) : resolve())),
    );
  },
  desktopEnvironment: async ({ releases }, use) => {
    await use({ LUMEN_E2E_RELEASES_URL: releases.url });
  },
});

releaseTest(
  "an installation that cannot update itself sends the viewer to the latest release page",
  async ({ server, admin: _, desktop: { app, page }, releases }) => {
    await connectDesktop(page, server);
    const button = page.getByRole("button", {
      name: "Download Lumen 9999.0.0 from its release page",
    });
    await expect(button).toHaveAttribute("data-state", "available");
    expect(releases.lookups()).toBe(1);
    expect(await page.evaluate(() => window.lumen.updates.status())).toEqual({
      automatic: null,
      update: { version: "9999.0.0", phase: "available", progress: 0 },
    });
    // A browser that cannot open leaves the button as it was, ready to try again.
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error("No browser");
      };
    });
    await button.click();
    await expect(button).toHaveAttribute("data-state", "available");
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        Object.assign(globalThis, { openedRelease: url });
      };
    });
    await button.click();
    await expect(button).toHaveAttribute("data-state", "active");
    await expect
      .poll(() => app.evaluate(() => (globalThis as { openedRelease?: string }).openedRelease))
      .toBe(`${releases.url}/latest`);
    await page.evaluate(() => {
      window.location.hash = "#/settings";
    });
    await expect(page.getByRole("heading", { name: "Playback" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Updates" })).toHaveCount(0);
    // The button follows what the main process reports, as an installer's download would.
    const report = (status: AppUpdateStatus) =>
      app.evaluate(({ BrowserWindow }, status) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send("updates:changed", status);
      }, status);
    await report({
      automatic: true,
      update: { version: "9999.0.0", phase: "downloading", progress: 0.4 },
    });
    const downloading = page.getByRole("button", { name: "Downloading Lumen 9999.0.0, 40%" });
    await expect(downloading).toHaveAttribute("data-state", "active");
    // The download finishes while the sidebar is not on screen; it must not miss that.
    await page.getByRole("button", { name: "Switch server…" }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    await report({ automatic: true, update: { version: "9999.0.0", phase: "ready", progress: 1 } });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Restart to update to Lumen 9999.0.0" }),
    ).toHaveAttribute("data-state", "ready");
    // Where the app installs updates, a click shows at once, before the feed answers.
    await app.evaluate(({ shell }) => {
      shell.openExternal = () => new Promise(() => undefined);
    });
    await report({
      automatic: false,
      update: { version: "9999.0.0", phase: "available", progress: 0 },
    });
    const download = page.getByRole("button", { name: "Download Lumen 9999.0.0", exact: true });
    await expect(download).toHaveAttribute("data-state", "available");
    await download.click();
    await expect(download).toHaveAttribute("data-state", "active");
    await report({ automatic: null, update: null });
    await expect(page.locator(".update-button")).toHaveCount(0);
  },
);
