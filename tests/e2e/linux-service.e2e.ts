import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  buildJournalctlArgs,
  computeStatsRow,
  formatBinaryBytes,
  formatDecimalBytes,
  formatStatsJson,
  formatStatsTable,
  parseInactiveFileBytes,
  parseLogsArgs,
  parseStatsArgs,
  parseUint64,
  parseUnitStatsSample,
  UsageError,
} from "../../apps/server/linux/lumenctl-lib";
import { password, repository } from "./support/server";

// The package CI built for this runner. The scenario installs a real system service as root, so it
// runs only where that variable is set: a disposable Linux CI runner.
const builtPackage = process.env.LUMEN_LINUX_SERVER_PACKAGE;
const server = "http://127.0.0.1:3210";

// Asynchronous, because the fixture release server answers from this same process. Output is also
// echoed, so a step that hangs (apt fetching FFmpeg, a service start) shows where in the job log.
const shell = (script: string) =>
  new Promise<{ status: number | null; output: string }>((resolve) => {
    const child = spawn("sh", ["-c", script]);
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk;
      process.stdout.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
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

test("builds journalctl arguments for lumenctl logs", () => {
  const cases: ReadonlyArray<{ argv: readonly string[]; expected: readonly string[] }> = [
    {
      argv: [],
      expected: ["-u", "lumen.service", "--no-pager", "--output=cat", "--lines=100"],
    },
    {
      argv: ["-f"],
      expected: ["-u", "lumen.service", "--no-pager", "--output=cat", "--lines=100", "--follow"],
    },
    {
      argv: ["-n", "25", "--follow"],
      expected: ["-u", "lumen.service", "--no-pager", "--output=cat", "--lines=25", "--follow"],
    },
    {
      argv: ["--tail=50"],
      expected: ["-u", "lumen.service", "--no-pager", "--output=cat", "--lines=50"],
    },
    {
      argv: ["--lines", "all"],
      expected: ["-u", "lumen.service", "--no-pager", "--output=cat", "--lines=all"],
    },
    {
      argv: ["-n20"],
      expected: ["-u", "lumen.service", "--no-pager", "--output=cat", "--lines=20"],
    },
    {
      argv: ["--since", "10m", "--until", "30s"],
      expected: [
        "-u",
        "lumen.service",
        "--no-pager",
        "--output=cat",
        "--since=10 minutes ago",
        "--until=30 seconds ago",
      ],
    },
    {
      argv: ["--since=2h", "-f"],
      expected: [
        "-u",
        "lumen.service",
        "--no-pager",
        "--output=cat",
        "--lines=all",
        "--since=2 hours ago",
        "--follow",
      ],
    },
    {
      argv: ["--since", "2026-11-26 12:00:00", "--update", "--", "-o", "short-iso"],
      expected: [
        "-u",
        "lumen-update.service",
        "--no-pager",
        "--output=cat",
        "--since=2026-11-26 12:00:00",
        "-o",
        "short-iso",
      ],
    },
  ];

  for (const { argv, expected } of cases) {
    const parsed = parseLogsArgs(argv);
    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") throw new Error("expected run");
    expect(buildJournalctlArgs(parsed.options)).toEqual([...expected]);
  }

  expect(parseLogsArgs(["--help"])).toEqual({ kind: "help" });
  expect(() => parseLogsArgs(["--unknown"])).toThrow(UsageError);
  expect(() => parseLogsArgs(["-n", "abc"])).toThrow(UsageError);
  expect(() => parseLogsArgs(["--since"])).toThrow(UsageError);
});

test("computes and formats docker-style stats from systemd properties", () => {
  expect(parseStatsArgs([])).toEqual({ kind: "run", options: { noStream: false, json: false } });
  expect(parseStatsArgs(["--no-stream", "--json"])).toEqual({
    kind: "run",
    options: { noStream: true, json: true },
  });
  expect(parseStatsArgs(["-h"])).toEqual({ kind: "help" });
  expect(() => parseStatsArgs(["--bogus"])).toThrow(UsageError);

  expect(parseUint64("18446744073709551615")).toBeUndefined();
  expect(parseUint64("[not set]")).toBeUndefined();
  expect(parseUint64("infinity")).toBeUndefined();
  expect(parseUint64("0")).toBe(0n);
  expect(parseInactiveFileBytes("anon 4096\ninactive_file 104857600\n")).toBe(104_857_600n);

  expect(formatBinaryBytes(0n)).toBe("0B");
  expect(formatBinaryBytes(1024n)).toBe("1.00KiB");
  expect(formatBinaryBytes(1024n * 1024n - 1n)).toBe("1.00MiB");
  expect(formatDecimalBytes(999n)).toBe("999B");
  expect(formatDecimalBytes(1_000n)).toBe("1.00kB");
  expect(formatDecimalBytes(999_999n)).toBe("1.00MB");

  const hostRam = 8n * 1024n * 1024n * 1024n;
  const baseProps = {
    ActiveState: "active",
    SubState: "running",
    InvocationID: "inv-1",
    // Exceeds Number.MAX_SAFE_INTEGER to exercise bigint CPU delta math.
    CPUUsageNSec: "20000000000000000",
    MemoryCurrent: String(256n * 1024n * 1024n),
    MemoryMax: "infinity",
    TasksCurrent: "14",
    IPIngressBytes: "14200000",
    IPEgressBytes: "1840000000",
    IOReadBytes: "512000000",
    IOWriteBytes: "12400000",
  };
  const first = parseUnitStatsSample(baseProps, 1_000_000_000n, hostRam, 128n * 1024n * 1024n);
  const second = parseUnitStatsSample(
    {
      ...baseProps,
      CPUUsageNSec: "20000001500000000",
    },
    2_000_000_000n,
    hostRam,
    128n * 1024n * 1024n,
  );
  const row = computeStatsRow(second, first);
  expect(row.state).toBe("running");
  expect(row.cpuPercent).toBe(150);
  expect(row.memoryUsageBytes).toBe(128n * 1024n * 1024n);
  expect(row.memoryLimitBytes).toBe(hostRam);
  expect(row.memoryPercent).toBe(1.56);

  const table = formatStatsTable(row);
  const [header = "", values = ""] = table.split("\n");
  expect(header).toContain("NAME");
  expect(header).toContain("CPU %");
  expect(header).toContain("MEM USAGE / LIMIT");
  expect(header).toContain("NET I/O");
  expect(header).toContain("BLOCK I/O");
  expect(header).toContain("PIDS");
  expect(values).toContain("lumen");
  expect(values).toContain("running");
  expect(values).toContain("150.00%");
  expect(values).toContain("128MiB / 8.00GiB");
  expect(values).toContain("1.56%");
  expect(values).toContain("14.2MB / 1.84GB");
  expect(values).toContain("512MB / 12.4MB");
  expect(values).toContain("14");

  expect(JSON.parse(formatStatsJson(row))).toEqual({
    name: "lumen",
    state: "running",
    cpuPercent: 150,
    memoryUsageBytes: 134_217_728,
    memoryLimitBytes: Number(hostRam),
    memoryPercent: 1.56,
    netIngressBytes: 14_200_000,
    netEgressBytes: 1_840_000_000,
    blockReadBytes: 512_000_000,
    blockWriteBytes: 12_400_000,
    pids: 14,
  });

  // Service restart between samples resets InvocationID and must not compute a bogus CPU delta.
  const restarted = parseUnitStatsSample(
    {
      ...baseProps,
      InvocationID: "inv-2",
      CPUUsageNSec: "50000000",
      MemoryMax: String(512n * 1024n * 1024n),
    },
    3_000_000_000n,
    hostRam,
  );
  const restartedRow = computeStatsRow(restarted, second);
  expect(restartedRow.cpuPercent).toBeUndefined();
  expect(restartedRow.memoryLimitBytes).toBe(512n * 1024n * 1024n);
  expect(restartedRow.memoryPercent).toBe(50);

  // Stopped service with unset accounting properties degrades cleanly to placeholders.
  const stopped = parseUnitStatsSample(
    {
      ActiveState: "inactive",
      SubState: "dead",
      InvocationID: "",
      CPUUsageNSec: "[not set]",
      MemoryCurrent: "18446744073709551615",
      MemoryMax: "infinity",
      TasksCurrent: "[not set]",
      IPIngressBytes: "[not set]",
      IPEgressBytes: "[not set]",
      IOReadBytes: "18446744073709551615",
      IOWriteBytes: "18446744073709551615",
    },
    4_000_000_000n,
    hostRam,
  );
  const stoppedRow = computeStatsRow(stopped, second);
  expect(stoppedRow.state).toBe("stopped");
  expect(formatStatsTable(stoppedRow)).toContain("-- / --");
  expect(JSON.parse(formatStatsJson(stoppedRow)).cpuPercent).toBeNull();
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

      const logs = await lumenctl("logs -n 50");
      expect(logs.status, logs.output).toBe(0);
      expect(logs.output).toContain("Listening on");

      const recentLogs = await lumenctl("logs --since 10m");
      expect(recentLogs.status, recentLogs.output).toBe(0);
      expect(recentLogs.output).toContain("Listening on");

      const stats = await lumenctl("stats --no-stream");
      expect(stats.status, stats.output).toBe(0);
      expect(stats.output).toContain("MEM USAGE / LIMIT");
      expect(stats.output).toContain("NET I/O");
      expect(stats.output).toContain("BLOCK I/O");
      expect(stats.output).toMatch(/^lumen\s+running\s+\d+\.\d{2}%/mu);

      const statsJson = await lumenctl("stats --no-stream --json");
      expect(statsJson.status, statsJson.output).toBe(0);
      const parsedStats = JSON.parse(statsJson.output.trim()) as {
        name: string;
        state: string;
        cpuPercent: number | null;
        memoryUsageBytes: number | null;
        memoryLimitBytes: number | null;
        pids: number | null;
      };
      expect(parsedStats.name).toBe("lumen");
      expect(parsedStats.state).toBe("running");
      expect(parsedStats.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(parsedStats.memoryUsageBytes).toBeGreaterThan(0);
      expect(parsedStats.memoryLimitBytes).toBeGreaterThan(0);
      expect(parsedStats.pids).toBeGreaterThan(0);

      // Streaming mode works without sudo, emits live samples, and exits cleanly on SIGINT.
      const streamOutcome = await new Promise<{ status: number | null; line: string }>(
        (resolve) => {
          const child = spawn("lumenctl", ["stats", "--json"]);
          let buffer = "";
          let signaled = false;
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (!signaled && buffer.includes("\n")) {
              signaled = true;
              child.kill("SIGINT");
            }
          });
          child.on("close", (status) => resolve({ status, line: buffer.split("\n")[0] ?? "" }));
        },
      );
      expect(JSON.parse(streamOutcome.line).name).toBe("lumen");
      expect(streamOutcome.status).toBe(0);
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
      const updateLogs = await lumenctl("logs --update -n 50");
      expect(updateLogs.status, updateLogs.output).toBe(0);
      expect(updateLogs.output).toContain(`Updating Lumen ${version} to ${next}`);
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
