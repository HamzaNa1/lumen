import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [
  base = "4d4a5c6",
  candidate = "84f091a",
  output = "benchmarks/direct-play/cache-results.json",
] = process.argv.slice(2);
const workspace = await mkdtemp(join(tmpdir(), "lumen-cache-bench-"));
const video = join(workspace, "constant-rate.mkv");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const generated = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360:rate=30",
  "-t",
  "120",
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-b:v",
  "24M",
  "-minrate",
  "24M",
  "-maxrate",
  "24M",
  "-bufsize",
  "48M",
  "-x264-params",
  "nal-hrd=cbr:force-cfr=1",
  "-g",
  "60",
  "-an",
  "-y",
  video,
];
const result = {
  base: execFileSync("git", ["rev-parse", base], { cwd: repo, encoding: "utf8" }).trim(),
  candidate: execFileSync("git", ["rev-parse", candidate], { cwd: repo, encoding: "utf8" }).trim(),
  generatedAt: new Date().toISOString(),
  mpvVersion: execFileSync("mpv", ["--version"], { encoding: "utf8" }).split("\n")[0],
  ffmpegVersion: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0],
  fixture: "120s H.264 video,640x360@30fps,24Mbit/s constant-rate filler, no audio",
  generatorArguments: generated.slice(0, -1),
  methodology:
    "3 alternating paired runs, native mpv paused, null video/audio output, same Bun HTTP file server; cache plateau after5 consecutive250ms samples with equal fw-bytes (15s deadline); process RSS sampled via ps; isolates cache profile, excludes app bridge/UI/diagnostics",
  samples: [],
};
let server;
let active;
try {
  const encoder = spawn("ffmpeg", generated, { stdio: ["ignore", "ignore", "inherit"] });
  assert.equal(await new Promise((resolve) => encoder.once("exit", resolve)), 0);
  result.fixtureBytes = Bun.file(video).size;
  const source = execFileSync(
    "git",
    ["show", `${candidate}:apps/desktop/src/main/player/MpvCache.ts`],
    { cwd: repo, encoding: "utf8" },
  );
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const { mpvCacheArguments } = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  const profiles = [
    { version: "baseline", args: ["--cache=yes"] },
    { version: "candidate", args: mpvCacheArguments },
  ];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2]
        ? Math.min(Number(range[2]) + 1, result.fixtureBytes)
        : result.fixtureBytes;
      return new Response(Bun.file(video).slice(start, end), {
        status: range ? 206 : 200,
        headers: {
          "content-type": "video/x-matroska",
          "content-length": String(end - start),
          "accept-ranges": "bytes",
          ...(range ? { "content-range": `bytes ${start}-${end - 1}/${result.fixtureBytes}` } : {}),
        },
      });
    },
  });
  // Warm the entire source, including the region either profile may prefetch.
  for await (const _chunk of Bun.file(video).stream()) {
  }
  for (let round = 0; round < 3; round++) {
    for (const profile of round % 2 ? [...profiles].reverse() : profiles) {
      const socketPath = join(workspace, "mpv.sock");
      await rm(socketPath, { force: true });
      const started = performance.now();
      active = spawn(
        "mpv",
        [
          "--no-config",
          "--load-scripts=no",
          "--idle=yes",
          "--no-terminal",
          "--vo=null",
          "--ao=null",
          "--pause",
          `--input-ipc-server=${socketPath}`,
          ...profile.args,
          `${server.url.origin}/video.mkv`,
        ],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      let socket;
      for (let attempt = 0; attempt < 100 && !socket; attempt++) {
        socket = await new Promise((resolve) => {
          const candidateSocket = createConnection(socketPath);
          candidateSocket.once("connect", () => resolve(candidateSocket));
          candidateSocket.once("error", () => {
            candidateSocket.destroy();
            resolve(null);
          });
        });
        if (!socket) await wait(20);
      }
      assert(socket, "MPV IPC startup failed");
      let id = 0;
      let buffer = "";
      const pending = new Map();
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          pending.get(message.request_id)?.(message.data);
          pending.delete(message.request_id);
          newline = buffer.indexOf("\n");
        }
      });
      const command = (args) =>
        new Promise((resolve, reject) => {
          const requestId = ++id;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("MPV IPC timeout"));
          }, 2000);
          pending.set(requestId, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          socket.write(`${JSON.stringify({ command: args, request_id: requestId })}\n`);
        });
      let previousBytes = -1;
      let steadySamples = 0;
      let fiveSecondsReadyMs = null;
      let peakRssMiB = 0;
      const samples = [];
      while (performance.now() - started < 15000 && steadySamples < 5) {
        const cache = await command(["get_property", "demuxer-cache-state"]);
        const elapsedMs = performance.now() - started;
        if (cache?.["cache-duration"] >= 5) fiveSecondsReadyMs ??= elapsedMs;
        const rss =
          Number(
            execFileSync("ps", ["-o", "rss=", "-p", String(active.pid)], {
              encoding: "utf8",
            }).trim(),
          ) / 1024;
        peakRssMiB = Math.max(peakRssMiB, rss);
        if (cache?.["fw-bytes"] > 0) {
          steadySamples = cache["fw-bytes"] === previousBytes ? steadySamples + 1 : 0;
          previousBytes = cache["fw-bytes"];
          samples.push({ elapsedMs, rssMiB: rss, cache });
        }
        await wait(250);
      }
      const final = samples.at(-1);
      assert(final && steadySamples === 5, "MPV cache did not reach a plateau within15s");
      const sample = {
        version: profile.version,
        round,
        args: profile.args,
        fiveSecondsReadyMs,
        peakRssMiB,
        aheadSeconds: final.cache["cache-duration"],
        forwardMiB: final.cache["fw-bytes"] / 1048576,
        samples,
      };
      result.samples.push(sample);
      console.log(
        `${profile.version} round${round}: ${sample.aheadSeconds.toFixed(2)}s ahead, RSS${peakRssMiB.toFixed(1)}MiB`,
      );
      socket.destroy();
      active.kill("SIGTERM");
      await new Promise((resolve) => active.once("exit", resolve));
      active = null;
    }
  }
} finally {
  active?.kill("SIGKILL");
  server?.stop(true);
  await writeFile(resolve(repo, output), `${JSON.stringify(result, null, 2)}\n`);
  await rm(workspace, { recursive: true, force: true });
}
