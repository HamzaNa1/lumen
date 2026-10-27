import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { _electron } from "@playwright/test";
import { expect, repository, test } from "./support/server";

test("real updater retries failed checks and downloads, verifies bytes, reports readiness and launches the silent installer", async ({
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
  let checks = 0;
  let downloads = 0;
  const feed = createServer((req, res) => {
    if (req.url?.split("?")[0]?.endsWith(".yml")) {
      checks++;
      if (phase === "offline") {
        res.writeHead(503).end("offline");
        return;
      }
      res.end(
        `version: 9999.0.0\nfiles:\n  - url: installer.exe\n    sha512: ${createHash("sha512").update(bytes).digest("base64")}\n    size: ${bytes.length}\npath: installer.exe\nsha512: ${createHash("sha512").update(bytes).digest("base64")}\nreleaseDate: 2026-01-01T00:00:00.000Z\n`,
      );
    } else {
      downloads++;
      if (phase === "broken") {
        res.writeHead(503).end("download unavailable");
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
  const app = await _electron.launch({
    timeout: 10000,
    executablePath: require("electron"),
    args: [main, "--no-sandbox"],
    env,
  });
  const child = app.process();
  try {
    const state = () =>
      app.evaluate(() => {
        const harness = (
          globalThis as unknown as {
            updateHarness: {
              updates: { ready: string | null };
              errors: string[];
              notifications: string[];
              updater: { allowPrerelease: boolean };
            };
          }
        ).updateHarness;
        return {
          ready: harness.updates.ready,
          errors: harness.errors,
          notifications: harness.notifications,
          prerelease: harness.updater.allowPrerelease,
        };
      });
    await expect.poll(() => checks).toBeGreaterThanOrEqual(2);
    expect(await state()).toMatchObject({ ready: null, prerelease: false, notifications: [] });
    expect((await state()).errors.join(" ")).toContain("Failed to update");
    await expect(
      app.evaluate(() =>
        (
          globalThis as unknown as { updateHarness: { updates: { install(): void } } }
        ).updateHarness.updates.install(),
      ),
    ).rejects.toThrow("No update is ready");
    phase = "broken";
    await expect.poll(() => downloads).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await state()).errors.join(" ")).toContain("Cannot download");
    phase = "ready";
    await expect.poll(async () => (await state()).ready, { timeout: 30000 }).toBe("9999.0.0");
    expect(new Set((await state()).notifications)).toEqual(new Set(["9999.0.0"]));
    await app.evaluate(() => {
      const harness = (
        globalThis as unknown as { updateHarness: { stop(): void; updates: { install(): void } } }
      ).updateHarness;
      harness.stop();
      harness.updates.install();
    });
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
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      feed.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
