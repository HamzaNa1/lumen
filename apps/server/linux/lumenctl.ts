// Manages a Lumen server installed as a systemd service by install.sh.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semver } from "bun";
import { H264_ENCODERS } from "../src/media/VideoEncoders";

const release = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const installRoot = "/opt/lumen";
const versionsDir = join(installRoot, "versions");
const current = join(installRoot, "current");
const configDir = "/etc/lumen";
const settingsFile = join(configDir, "lumen.env");
const updatesFile = join(configDir, "updates.env");
const dataDir = "/var/lib/lumen";
const unitsDir = "/etc/systemd/system";
const units = ["lumen.service", "lumen-update.service", "lumen-update.timer"];
const shim = "/usr/local/bin/lumenctl";
const requiredEncoders = [H264_ENCODERS.cpu.name, "libvpx", "aac", "libopus"];
const settingsTemplate = `# Settings for the Lumen server. Restart it after a change: sudo systemctl restart lumen
LUMEN_HOST=0.0.0.0
LUMEN_PORT=3210
# LUMEN_LOG_LEVEL=info
# When the browser session cookie is Secure: auto (follow the request), always, or never.
# LUMEN_COOKIE_SECURE=auto
# Extra origins allowed to use browser sessions, for proxies that rewrite the Host header.
# LUMEN_ALLOWED_ORIGINS=https://media.example
`;

const fail = (message: string): never => {
  console.error(`lumen: ${message}`);
  process.exit(1);
};

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
};

const capture = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const has = (command: string) => capture("sh", ["-c", `command -v ${command}`]) !== undefined;

const requireRoot = () => {
  if (process.getuid?.() !== 0) fail("run lumenctl as root, for example with sudo");
};

const readEnvFile = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};
  const entries: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] !== undefined)
      entries[match[1]] = (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/u, "$2");
  }
  return entries;
};

const versionOf = (root: string): string =>
  (JSON.parse(readFileSync(join(root, "apps/server/package.json"), "utf8")) as { version: string })
    .version;

const installedVersion = () => (existsSync(current) ? versionOf(current) : undefined);

const unitProperties = (unit: string, names: readonly string[]) => {
  const values: Record<string, string> = {};
  for (const line of (
    capture("systemctl", ["show", unit, ...names.map((name) => `-p${name}`)]) ?? ""
  ).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
};

const autoUpdateEnabled = () =>
  capture("systemctl", ["is-enabled", "lumen-update.timer"]) === "enabled";

const listen = () => {
  const settings = readEnvFile(settingsFile);
  return { host: settings.LUMEN_HOST ?? "127.0.0.1", port: settings.LUMEN_PORT ?? "3210" };
};

const origin = (host: string, port: string) =>
  `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

const localOrigin = () => {
  const { host, port } = listen();
  return origin(host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host, port);
};

const publicOrigin = () => {
  const { host, port } = listen();
  if (host !== "0.0.0.0" && host !== "::") return origin(host, port);
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  return origin(address ?? "127.0.0.1", port);
};

const missingEncoders = () => {
  const encoders = capture("ffmpeg", ["-hide_banner", "-encoders"])?.split(/\s+/u) ?? [];
  return requiredEncoders.filter((encoder) => !encoders.includes(encoder));
};

const ensureFfmpeg = () => {
  if (!has("ffmpeg") || !has("ffprobe")) {
    const managers: [string, string[][]][] = [
      ["apt-get", [["update"], ["install", "-y", "ffmpeg"]]],
      ["dnf", [["install", "-y", "ffmpeg"]]],
      ["pacman", [["-S", "--needed", "--noconfirm", "ffmpeg"]]],
      ["zypper", [["--non-interactive", "install", "ffmpeg"]]],
    ];
    const manager = managers.find(([name]) => has(name));
    if (manager !== undefined) {
      console.log("Installing FFmpeg");
      for (const args of manager[1])
        spawnSync(manager[0], args, {
          stdio: "inherit",
          env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
        });
    }
    if (!has("ffmpeg") || !has("ffprobe"))
      fail(
        "install FFmpeg (ffmpeg and ffprobe) with your package manager, then run the installer again",
      );
  }
  const missing = missingEncoders();
  if (missing.length > 0)
    console.warn(
      `FFmpeg on this system lacks ${missing.join(", ")}; Lumen cannot convert media that needs them.`,
    );
};

const ensureUser = () => {
  if (capture("id", ["-u", "lumen"]) === undefined) {
    const nologin =
      ["/usr/sbin/nologin", "/sbin/nologin", "/usr/bin/nologin"].find((path) => existsSync(path)) ??
      "/bin/false";
    run("useradd", [
      "--system",
      "--user-group",
      "--home-dir",
      dataDir,
      "--no-create-home",
      "--shell",
      nologin,
      "lumen",
    ]);
  }
  // Hardware video encoding opens the GPU's device nodes, which these groups own.
  for (const group of ["video", "render"])
    if (capture("getent", ["group", group]) !== undefined) run("usermod", ["-aG", group, "lumen"]);
};

const pointCurrentAt = (target: string) => {
  const next = join(installRoot, ".current");
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, current);
};

// Ready, or the process exited: a long migration is neither, so there is no short timeout.
const startAndWait = async (version: string) => {
  run("systemctl", ["restart", "lumen.service"]);
  const { InvocationID: started } = unitProperties("lumen.service", ["InvocationID"]);
  const ready = `${localOrigin()}/health/ready`;
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    const state = unitProperties("lumen.service", ["ActiveState", "SubState", "InvocationID"]);
    if (
      state.ActiveState !== "active" ||
      state.SubState !== "running" ||
      state.InvocationID !== started
    )
      fail(`Lumen ${version} stopped while starting. See: journalctl -u lumen -n 100`);
    const response = await fetch(ready, { signal: AbortSignal.timeout(5_000) }).catch(
      () => undefined,
    );
    if (response?.ok === true) return;
    if (Date.now() > deadline)
      fail(`Lumen ${version} is still not ready after an hour. See: journalctl -u lumen -n 100`);
    await Bun.sleep(500);
  }
};

const install = async (autoUpdate: boolean) => {
  requireRoot();
  if (dirname(release) !== versionsDir)
    fail(`run lumenctl install from a release in ${versionsDir}`);
  const version = versionOf(release);
  const installed = installedVersion();
  if (installed !== undefined && semver.order(version, installed) < 0)
    fail(`Lumen ${installed} is installed; ${version} is older and may not open its database`);
  const releases = process.env.LUMEN_RELEASE_URL ?? fail("run lumenctl install through install.sh");
  ensureFfmpeg();
  ensureUser();
  mkdirSync(configDir, { recursive: true });
  if (!existsSync(settingsFile)) writeFileSync(settingsFile, settingsTemplate, { mode: 0o644 });
  writeFileSync(updatesFile, `LUMEN_RELEASE_URL=${releases}\n`, { mode: 0o644 });
  for (const unit of units)
    copyFileSync(join(release, "apps/server/linux/systemd", unit), join(unitsDir, unit));
  writeFileSync(shim, `#!/bin/sh\nexec ${current}/bin/lumenctl "$@"\n`);
  chmodSync(shim, 0o755);
  pointCurrentAt(release);
  run("systemctl", ["daemon-reload"]);
  run("systemctl", ["enable", "--quiet", "lumen.service"]);
  if (autoUpdate) run("systemctl", ["enable", "--now", "--quiet", "lumen-update.timer"]);
  await startAndWait(version);
  for (const entry of readdirSync(versionsDir))
    if (join(versionsDir, entry) !== release)
      rmSync(join(versionsDir, entry), { recursive: true, force: true });
  console.log(`Lumen ${version} is running at ${publicOrigin()}/web`);
  if (!autoUpdateEnabled())
    console.log("Turn on automatic updates with: sudo lumenctl auto-update on");
};

const latestVersion = async (releases: string) => {
  const response = await fetch(`${releases}/download/server-latest/latest-version`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`the release server answered ${response.status}`);
  const version = (await response.text()).trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`not a release version: ${version}`);
  return version;
};

const releasesUrl = () =>
  readEnvFile(updatesFile).LUMEN_RELEASE_URL ??
  fail(`${updatesFile} is missing; run the installer again`);

const update = async () => {
  requireRoot();
  const installed = installedVersion() ?? fail("Lumen is not installed");
  const releases = releasesUrl();
  const latest = await latestVersion(releases).catch((cause: Error) =>
    fail(`could not check for updates: ${cause.message}`),
  );
  if (semver.order(latest, installed) <= 0) {
    console.log(`Lumen ${installed} is up to date`);
    return;
  }
  console.log(`Updating Lumen ${installed} to ${latest}`);
  const result = spawnSync(
    "sh",
    [join(current, "apps/server/linux/install.sh"), `--version=${latest}`],
    {
      stdio: "inherit",
      env: { ...process.env, LUMEN_RELEASE_URL: releases },
    },
  );
  process.exit(result.status ?? 1);
};

const status = async () => {
  const installed = installedVersion() ?? fail("Lumen is not installed");
  const latest = await latestVersion(releasesUrl()).then(
    (version) => (semver.order(version, installed) > 0 ? `${version} available` : "up to date"),
    (cause: Error) => `could not check for updates: ${cause.message}`,
  );
  const service = unitProperties("lumen.service", ["ActiveState", "SubState"]);
  const lastUpdate = unitProperties("lumen-update.service", ["Result", "ExecMainExitTimestamp"]);
  const missing = missingEncoders();
  console.log(`Version:      ${installed} (${latest})`);
  console.log(`Service:      ${service.ActiveState} (${service.SubState})`);
  console.log(`Address:      ${publicOrigin()}/web`);
  console.log(`Auto-update:  ${autoUpdateEnabled() ? "on" : "off"}`);
  if (lastUpdate.ExecMainExitTimestamp)
    console.log(
      `Last check:   ${lastUpdate.Result === "success" ? "succeeded" : "failed, see: journalctl -u lumen-update"} (${lastUpdate.ExecMainExitTimestamp})`,
    );
  console.log(
    `FFmpeg:       ${has("ffmpeg") ? (missing.length > 0 ? `lacks ${missing.join(", ")}` : "ok") : "missing"}`,
  );
};

const setAutoUpdate = (state: string | undefined) => {
  requireRoot();
  if (state !== "on" && state !== "off") fail("usage: lumenctl auto-update on|off");
  if (installedVersion() === undefined) fail("Lumen is not installed");
  run("systemctl", [
    state === "on" ? "enable" : "disable",
    "--now",
    "--quiet",
    "lumen-update.timer",
  ]);
  console.log(`Automatic updates are ${state}`);
};

const uninstall = (purge: boolean) => {
  requireRoot();
  spawnSync("systemctl", ["disable", "--now", "--quiet", "lumen-update.timer", "lumen.service"], {
    stdio: "inherit",
  });
  for (const unit of units) rmSync(join(unitsDir, unit), { force: true });
  run("systemctl", ["daemon-reload"]);
  rmSync(shim, { force: true });
  rmSync(installRoot, { recursive: true, force: true });
  if (!purge) {
    console.log(
      `Removed Lumen. Settings in ${configDir} and data in ${dataDir} are kept for a reinstall.`,
    );
    console.log(`To delete them too: sudo rm -rf ${configDir} ${dataDir} && sudo userdel lumen`);
    return;
  }
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  if (capture("id", ["-u", "lumen"]) !== undefined) run("userdel", ["lumen"]);
  console.log("Removed Lumen, its settings and its data.");
};

const [command, ...args] = process.argv.slice(2);
if (command === "install") await install(args.includes("--auto-update"));
else if (command === "update") await update();
else if (command === "status") await status();
else if (command === "auto-update") setAutoUpdate(args[0]);
else if (command === "uninstall") uninstall(args.includes("--purge"));
else {
  console.error("usage: lumenctl status | update | auto-update on|off | uninstall [--purge]");
  process.exit(2);
}
