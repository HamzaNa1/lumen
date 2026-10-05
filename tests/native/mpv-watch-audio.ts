import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { analyzeAudioTransition } from "../helpers/audio-transition";
import { MpvIpc } from "../../apps/desktop/src/main/player/MpvIpc";
import type { MpvProcess } from "../../apps/desktop/src/main/player/MpvProcess";
import {
  mpvPitchArguments,
  sampleMpvPlayback,
} from "../../apps/desktop/src/main/player/MpvSynchronization";

// Standalone real-MPV check: bun tests/native/mpv-watch-audio.ts [evidence-directory].
// Requires mpv and ffmpeg on PATH; captures PCM, without relying on a speaker/device driver.
const evidence = resolve(process.argv[2] ?? join(tmpdir(), `lumen-watch-audio-${process.pid}`));
mkdirSync(evidence, { recursive: true });
const clip = join(evidence, "eac3-5.1.mkv");
const pcm = join(evidence, "output.pcm");
const log = join(evidence, "mpv.log");
const socket =
  process.platform === "win32"
    ? `\\\\.\\pipe\\lumen-audio-test-${process.pid}`
    : join(evidence, "mpv.sock");
const ffmpeg = spawnSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  `aevalsrc=${[440, 440, 440, 80, 440, 440].map((frequency) => `0.15*sin(2*PI*${frequency}*t)`).join("|")}:s=48000:d=30:c=5.1`,
  "-f",
  "lavfi",
  "-i",
  "color=c=black:s=64x64:r=24:d=30",
  "-c:v",
  "mpeg4",
  "-c:a",
  "eac3",
  "-b:a",
  "640k",
  clip,
]);
assert.equal(ffmpeg.status, 0, ffmpeg.stderr.toString());
const child = spawn(
  "mpv",
  [
    "--no-config",
    "--load-scripts=no",
    "--idle=yes",
    "--no-terminal",
    "--vo=null",
    "--vo-null-fps=24",
    "--ao=pcm",
    "--audio-format=float",
    "--audio-channels=5.1",
    "--ao-pcm-waveheader=no",
    `--ao-pcm-file=${pcm}`,
    `--input-ipc-server=${socket}`,
    `--log-file=${log}`,
    "--msg-level=af=debug",
    ...mpvPitchArguments,
    clip,
  ],
  { stdio: "ignore", windowsHide: true },
);
const exited = once(child, "exit");
const ipc = new MpvIpc();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitForPcm = async (minimumBytes: number): Promise<number> => {
  const deadline = performance.now() + 5000;
  while (true) {
    const bytes = statSync(pcm, { throwIfNoEntry: false })?.size ?? 0;
    if (bytes >= minimumBytes) return bytes;
    assert(performance.now() < deadline, `Timed out waiting for ${minimumBytes} PCM bytes`);
    await delay(20);
  }
};
const segments: {
  speed: number;
  start: number;
  commandBefore: number;
  commandAfter: number;
  end: number;
  sampleAgeMs: number;
  measuredSpeed: number;
}[] = [];
let version: unknown;
try {
  await ipc.connect({
    get socketPath() {
      return child.exitCode === null ? socket : null;
    },
  } as MpvProcess);
  const deadline = performance.now() + 5000;
  while ((await ipc.command(["get_property", "audio-out-params"]).catch(() => null)) === null) {
    assert(performance.now() < deadline, "MPV audio failed to initialize");
    await delay(20);
  }
  version = await ipc.command(["get_property", "mpv-version"]);
  const params = (await ipc.command(["get_property", "audio-out-params"])) as Record<
    string,
    unknown
  >;
  assert.equal(params["channel-count"], 6);
  assert.equal(params.samplerate, 48000);
  assert.equal(params.format, "float");
  assert.equal(await ipc.command(["get_property", "audio-pitch-correction"]), true);
  // Prime the output so each capture includes 100 ms of already-written pre-command audio.
  const preRollBytes = 4800 * 6 * 4;
  await waitForPcm(preRollBytes * 2);
  for (const speed of [1, 1.01, 1.006, 1, 0.99, 0.994, 1]) {
    const commandBefore = statSync(pcm).size;
    assert(commandBefore >= preRollBytes, "Missing pre-command PCM");
    const start = commandBefore - preRollBytes;
    await ipc.command(["set_property", "speed", speed]);
    const commandAfter = statSync(pcm).size;
    // Keep the whole transition: MPV/output buffering can delay when changed audio is written.
    const end = await waitForPcm(commandAfter + 2 * 48000 * 6 * 4);
    const sample = await sampleMpvPlayback(ipc, {
      sessionId: "test",
      itemId: "fixture",
      positionSeconds: 0,
      durationSeconds: 30,
      paused: false,
    });
    assert(sample, "A fresh MPV sample was unavailable");
    assert.equal(sample.speed, speed);
    assert.equal(sample.advancing, true);
    const filters = (await ipc.command(["get_property", "af"])) as { name: string }[];
    assert.deepEqual(
      filters.map((filter) => filter.name),
      ["scaletempo2"],
    );
    segments.push({
      speed,
      start,
      commandBefore,
      commandAfter,
      end,
      measuredSpeed: sample.speed,
      sampleAgeMs: performance.now() - sample.sampledAtMs,
    });
  }
  await ipc.command(["set_property", "pause", "yes"]);
  const halted = await sampleMpvPlayback(ipc, {
    sessionId: "test",
    itemId: "fixture",
    positionSeconds: 0,
    durationSeconds: 30,
    paused: false,
  });
  assert.equal(halted?.advancing, false);
  await ipc.command(["quit"]);
  await exited;
} finally {
  ipc.close();
  if (child.exitCode === null) {
    child.kill();
    await exited;
  }
}

const audio = readFileSync(pcm);
const channels = 6;
const measurements = segments.map((segment) => {
  const transition = analyzeAudioTransition(audio, segment.start, segment.end);
  return {
    speed: segment.speed,
    sampleAgeMs: segment.sampleAgeMs,
    measuredSpeed: segment.measuredSpeed,
    commandBeforeOffsetMs:
      ((segment.commandBefore - segment.start) * 1000) / (48000 * channels * 4),
    commandAfterOffsetMs: ((segment.commandAfter - segment.start) * 1000) / (48000 * channels * 4),
    transition,
  };
});
const filterLog = readFileSync(log, "utf8");
const filterInitializations = (filterLog.match(/\[af\] \[scaletempo2\]/g) ?? []).length;
assert.equal(filterInitializations, 1, "MPV reinitialized the persistent tempo filter");
assert(!filterLog.includes("adding scaletempo2"), "MPV stacked an automatic speed filter");
assert(
  !filterLog.includes("removing audio speed filter"),
  "MPV rebuilt its automatic speed filter",
);
const report = {
  mpvVersion: version,
  platform: process.platform,
  codec: "eac3",
  sampleRate: 48000,
  channels,
  pitchCorrection: true,
  filter: "scaletempo2",
  measurements,
  filterInitializations,
  automaticFilterInsertions: 0,
  automaticFilterRemovals: 0,
};
writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
