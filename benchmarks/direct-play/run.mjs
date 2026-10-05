import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const [base = "4d4a5c6", candidate = "84f091a", destination = join(here, "results.json")] =
  process.argv.slice(2);
const rounds = Number(process.env.BENCH_ROUNDS ?? 9);
const workspace = await mkdtemp(join(tmpdir(), "lumen-playback-bench-"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();
const results = {
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    os: release(),
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 1073741824,
    bun: Bun.version,
    node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
  },
  methodology: {
    rounds,
    order: "alternating baseline/candidate and candidate/baseline each round",
    warmup: "8 x 64KiB ranges + one64MiB transfer per process",
    sourceBytes: 67108864,
    source:
      "repeated random256KiB block, filesystem cache warm; all bytes consumed, exact lengths checked",
    server:
      "real HttpApp + ServeFile + logging serialization to discard sink; grant authorization uses fixed in-memory metadata (no DB/realpath)",
    bridge: "production class, native Node, candidate diagnostics enabled",
    sampling: "10ms sampled absolute process RSS, CPU user+system deltas",
    throughputPolicy:
      "same relaxed rate limits (100000/min and burst10000) for timing; default admission measured separately",
    limits:
      "loopback synthetic transport workload, not WAN/GPU/packaged Electron performance; RSS excludes client and OS page cache",
  },
  refs: {},
  samples: [],
  policy: [],
  cancellation: [],
};

async function prepare(ref, name) {
  const root = join(workspace, name);
  await mkdir(root);
  const sha = execFileSync("git", ["rev-parse", ref], { cwd: repo, encoding: "utf8" }).trim();
  const archive = execFileSync("git", ["archive", sha], { cwd: repo, maxBuffer: 128 * 1048576 });
  execFileSync("tar", ["-x", "-C", root], { input: archive });
  for (const path of [
    "node_modules",
    "apps/server/node_modules",
    "packages/database/node_modules",
    "packages/contracts/node_modules",
  ])
    await symlink(join(repo, path), join(root, path));
  const bundle = await Bun.build({
    entrypoints: [join(root, "apps/desktop/src/main/player/PlaybackBridge.ts")],
    target: "node",
    format: "esm",
  });
  assert(bundle.success, String(bundle.logs));
  const output = join(workspace, `${name}-bridge.mjs`);
  await writeFile(output, await bundle.outputs[0].text());
  results.refs[name] = sha;
  return { name, root, moduleUrl: pathToFileURL(output).href };
}

async function launch(executable, args) {
  const child = spawn(executable, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.once("exit", () => children.delete(child));
  const ready = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Startup timeout: ${stderr}`)), 10000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Exited${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(output.split("\n")[0]));
        } catch (cause) {
          reject(cause);
        }
      }
    });
  });
  return { child, ...ready };
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return response.json();
}

async function stack(version, policy = "throughput") {
  const server = await launch(process.execPath, [
    join(here, "server.mjs"),
    version.root,
    media,
    policy,
  ]);
  const bridge = await launch("node", [
    join(here, "bridge.mjs"),
    version.moduleUrl,
    diagnosticsUrl,
    server.origin,
  ]);
  return {
    server,
    bridge,
    async close() {
      await Promise.allSettled([
        json(`${bridge.admin}/quit`),
        json(`${server.origin}/benchmark/quit`),
      ]);
      await wait(50);
      for (const child of [bridge.child, server.child])
        if (children.has(child)) child.kill("SIGKILL");
    },
  };
}

async function download(url, range, expected) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: range ? { range } : {},
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, range ? 206 : 200);
  let bytes = 0;
  let firstByteMs;
  for await (const chunk of response.body) {
    firstByteMs ??= performance.now() - started;
    bytes += chunk.byteLength;
  }
  assert.equal(bytes, expected);
  return { firstByteMs, durationMs: performance.now() - started, bytes };
}

async function measure(version, round, mode, current) {
  const url =
    mode === "direct_64KiB_ranges"
      ? `${current.server.origin}/api/v1/media/benchmark?grant=benchmark`
      : current.bridge.url;
  const range = mode.includes("ranges") ? "bytes=0-65535" : null;
  const expected = range ? 65536 : 67108864;
  const concurrency = mode === "bridge_4_readers" ? 4 : 1;
  const count = range ? 256 : 8;
  await json(`${current.bridge.admin}/begin`);
  await json(`${current.server.origin}/benchmark/begin`);
  const started = performance.now();
  const transfers = [];
  for (let offset = 0; offset < count; offset += concurrency)
    transfers.push(
      ...(await Promise.all(
        Array.from({ length: concurrency }, () => download(url, range, expected)),
      )),
    );
  const elapsedMs = performance.now() - started;
  const [bridge, server] = await Promise.all([
    json(`${current.bridge.admin}/stats`),
    json(`${current.server.origin}/benchmark/stats`),
  ]);
  const sample = {
    version: version.name,
    round,
    mode,
    elapsedMs,
    throughputMiBps: (count * expected) / 1048576 / (elapsedMs / 1000),
    bridge,
    server,
    transfers,
  };
  results.samples.push(sample);
  console.log(
    `${version.name} round${round} ${mode}: ${sample.throughputMiBps.toFixed(1)}MiB/s, bridgeCPU${bridge.cpuMs.toFixed(1)}ms`,
  );
}

async function policies(version, scenario) {
  const current = await stack(version, "defaults");
  try {
    if (scenario === "api_budget_exhaustion") {
      for (let i = 0; i < 600; i++) {
        const response = await fetch(`${current.server.origin}/health/live`);
        await response.arrayBuffer();
      }
    }
    const statuses = {};
    const count = scenario === "api_budget_exhaustion" ? 20 : 200;
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      const response = await fetch(current.bridge.url, { headers: { range: "bytes=0-65535" } });
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      await response.arrayBuffer();
    }
    results.policy.push({
      version: version.name,
      scenario,
      statuses,
      requests: count,
      elapsedMs: performance.now() - started,
    });
  } finally {
    await current.close();
  }
}

async function cancel(version, round) {
  const current = await stack(version);
  let request;
  try {
    const response = await new Promise((resolve, reject) => {
      request = httpRequest(current.bridge.url, resolve);
      request.on("error", reject);
      request.end();
    });
    response.on("error", () => {});
    response.pause();
    await wait(100);
    const before = await json(`${current.server.origin}/benchmark/stats`);
    const started = performance.now();
    await json(`${current.bridge.admin}/revoke`);
    let upstream;
    do {
      upstream = await json(`${current.server.origin}/benchmark/stats`);
      if (upstream.aborted > before.aborted) break;
      await wait(5);
    } while (performance.now() - started < 1000);
    const latencyMs = performance.now() - started;
    const aborted = upstream.aborted > before.aborted;
    const stats = await json(`${current.bridge.admin}/stats`);
    results.cancellation.push({
      version: version.name,
      round,
      upstreamAbortedWithin1000ms: aborted,
      abortLatencyMs: aborted ? latencyMs : null,
      activeTransfers: stats.activeTransfers,
    });
    response.destroy();
  } finally {
    request?.destroy();
    await current.close();
  }
}

let media;
let diagnosticsUrl;
try {
  const versions = [await prepare(base, "baseline"), await prepare(candidate, "candidate")];
  const diag = await Bun.build({
    entrypoints: [join(versions[1].root, "packages/client/src/playback/PlaybackDiagnostics.ts")],
    target: "node",
    format: "esm",
  });
  assert(diag.success);
  const diagPath = join(workspace, "diagnostics.mjs");
  await writeFile(diagPath, await diag.outputs[0].text());
  diagnosticsUrl = pathToFileURL(diagPath).href;
  media = join(workspace, "media.bin");
  const file = await open(media, "w");
  const block = randomBytes(262144);
  const hash = createHash("sha256");
  for (let i = 0; i < 256; i++) {
    await file.write(block);
    hash.update(block);
  }
  await file.close();
  results.methodology.sourceSha256 = hash.digest("hex");
  for (let round = 0; round < rounds; round++) {
    for (const version of round % 2 ? [...versions].reverse() : versions) {
      const current = await stack(version);
      try {
        for (let i = 0; i < 8; i++) await download(current.bridge.url, "bytes=0-65535", 65536);
        await download(current.bridge.url, null, 67108864);
        for (const mode of [
          "bridge_1_reader",
          "bridge_4_readers",
          "bridge_64KiB_ranges",
          "direct_64KiB_ranges",
        ])
          await measure(version, round, mode, current);
      } finally {
        await current.close();
      }
    }
  }
  for (const version of versions) {
    for (const scenario of ["api_budget_exhaustion", "immediate_range_burst"])
      await policies(version, scenario);
    for (let round = 0; round < 3; round++) await cancel(version, round);
  }
} finally {
  await mkdir(dirname(resolve(destination)), { recursive: true });
  await writeFile(destination, `${JSON.stringify(results, null, 2)}\n`);
  for (const child of children) child.kill("SIGKILL");
  await rm(workspace, { recursive: true, force: true });
}
