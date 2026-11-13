import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { password, repository } from "./support/server";

// The package CI built for this runner. The scenario installs a real system service as root, so it
// runs only where that variable is set: a disposable Linux CI runner.
const builtPackage = process.env.LUMEN_LINUX_SERVER_PACKAGE;
const server = "http://127.0.0.1:3210";

// Asynchronous, because the fixture release server answers from this same process.
const shell = (script: string) =>
  new Promise<{ status: number | null; output: string }>((resolve) => {
    const child = spawn("sh", ["-c", script]);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (status) => resolve({ status, output }));
  });

const serverVersion = async () =>
  ((await (await fetch(`${server}/api/v1/server`)).json()) as { serverVersion: string })
    .serverVersion;

const signIn = (path: "register" | "login") =>
  fetch(`${server}/api/v1/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      ...(path === "register" ? { displayName: "admin" } : {}),
      password,
      deviceId: crypto.randomUUID(),
      deviceName: "E2E",
      platform: "desktop",
      platformDeviceId: null,
    }),
  });

test("installs, updates and removes the server as a systemd service", async () => {
  test.skip(
    builtPackage === undefined,
    "Installs a system service; runs on a disposable Linux CI runner",
  );
  if (builtPackage === undefined) return;
  test.setTimeout(10 * 60_000);
  const [, version, arch] =
    /^lumen-server-(\d+\.\d+\.\d+)-linux-(\w+)\.tar\.gz$/u.exec(basename(builtPackage)) ?? [];
  if (version === undefined || arch === undefined)
    throw new Error(`Unexpected package name: ${builtPackage}`);
  const [major, minor, patch] = version.split(".").map(Number);
  const next = `${major}.${minor}.${(patch ?? 0) + 1}`;
  const broken = `${major}.${minor}.${(patch ?? 0) + 2}`;

  const workspace = mkdtempSync(join(tmpdir(), "lumen-linux-service-"));
  const files = new Map<string, Buffer>();
  const releases = createServer((request, response) => {
    const body = files.get(request.url ?? "");
    response.writeHead(body === undefined ? 404 : 200).end(body);
  });
  await new Promise<void>((resolve) => releases.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(releases.address() as AddressInfo).port}`;
  const publish = (
    release: string,
    archive: Buffer,
    checksum = createHash("sha256").update(archive).digest("hex"),
  ) => {
    const name = `lumen-server-${release}-linux-${arch}.tar.gz`;
    files.set(`/download/v${release}%2Bserver/${name}`, archive);
    files.set(`/download/v${release}%2Bserver/SHA256SUMS`, Buffer.from(`${checksum}  ${name}\n`));
  };
  const point = (release: string) =>
    files.set("/download/server-latest/latest-version", Buffer.from(`${release}\n`));
  // A newer release is the built one reporting a higher version.
  const repackaged = (release: string) => {
    const tree = join(workspace, release);
    mkdirSync(tree, { recursive: true });
    execFileSync("tar", ["-xzf", builtPackage, "-C", tree]);
    const manifest = join(tree, "apps/server/package.json");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(`"version": "${version}"`, `"version": "${release}"`),
    );
    const archive = join(workspace, `${release}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", tree, "."]);
    return readFileSync(archive);
  };
  const install = (options = "") =>
    shell(
      `curl -fsSL ${base}/download/server-latest/install.sh | sudo LUMEN_RELEASE_URL=${base} sh -s -- ${options}`,
    );
  const lumenctl = (args: string) => shell(`sudo lumenctl ${args}`);

  files.set(
    "/download/server-latest/install.sh",
    readFileSync(join(repository, "apps/server/linux/install.sh")),
  );
  publish(version, readFileSync(builtPackage));
  publish(next, repackaged(next));
  publish(broken, repackaged(broken), "0".repeat(64));
  point(version);
  try {
    await test.step("installs the latest release and serves the web app", async () => {
      const installed = await install();
      expect(installed.status, installed.output).toBe(0);
      expect(installed.output).toContain(`Lumen ${version} is running at`);
      expect(await serverVersion()).toBe(version);
      expect((await fetch(`${server}/web/`)).status).toBe(200);
      expect((await signIn("register")).status).toBe(201);
      const status = await lumenctl("status");
      expect(status.output).toContain(`Version:      ${version} (up to date)`);
      expect(status.output).toContain("Auto-update:  off");
    });

    await test.step("updates automatically once turned on, keeping the database", async () => {
      expect((await lumenctl("auto-update on")).status).toBe(0);
      expect((await shell("systemctl is-enabled lumen-update.timer")).output.trim()).toBe(
        "enabled",
      );
      point(next);
      const updated = await shell("sudo systemctl start lumen-update.service");
      expect(updated.status, (await shell("journalctl -u lumen-update --no-pager")).output).toBe(0);
      expect(await serverVersion()).toBe(next);
      expect((await signIn("login")).status).toBe(200);
      expect((await shell("ls /opt/lumen/versions")).output.trim()).toBe(next);
      expect((await lumenctl("status")).output).toContain("Last check:   succeeded");
      expect((await lumenctl("update")).output).toContain(`Lumen ${next} is up to date`);
    });

    await test.step("keeps serving when an update or a downgrade is refused", async () => {
      point(broken);
      const corrupt = await lumenctl("update");
      expect(corrupt.status).not.toBe(0);
      expect(corrupt.output).toContain("does not match its published checksum");
      const downgrade = await install(`--version=${version}`);
      expect(downgrade.status).not.toBe(0);
      expect(downgrade.output).toContain(`Lumen ${next} is installed; ${version} is older`);
      expect(await serverVersion()).toBe(next);
      expect((await lumenctl("auto-update off")).status).toBe(0);
      expect((await shell("systemctl is-enabled lumen-update.timer")).output.trim()).toBe(
        "disabled",
      );
    });

    await test.step("uninstalls without losing data, and a reinstall picks it up", async () => {
      const removed = await lumenctl("uninstall");
      expect(removed.status, removed.output).toBe(0);
      expect((await shell("systemctl cat lumen.service")).status).not.toBe(0);
      expect(
        (await shell("test -e /opt/lumen || test -e /usr/local/bin/lumenctl")).status,
      ).not.toBe(0);
      expect((await shell("sudo test -f /var/lib/lumen/lumen.sqlite")).status).toBe(0);
      point(next);
      const reinstalled = await install();
      expect(reinstalled.status, reinstalled.output).toBe(0);
      expect((await signIn("login")).status).toBe(200);
      const purged = await lumenctl("uninstall --purge");
      expect(purged.status, purged.output).toBe(0);
      expect(
        (await shell("test -e /var/lib/lumen || test -e /etc/lumen || id lumen")).status,
      ).not.toBe(0);
    });
  } finally {
    await shell("test -x /usr/local/bin/lumenctl && sudo lumenctl uninstall --purge");
    releases.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
