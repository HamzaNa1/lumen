import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
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
const segments: {
  speed: number;
  start: number;
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
  for (const speed of [1, 1.01, 1.006, 1, 0.99, 0.994, 1]) {
    await ipc.command(["set_property", "speed", speed]);
    await delay(450);
    const start = statSync(pcm).size;
    await delay(1600);
    const end = statSync(pcm).size;
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
const bytesPerFrame = channels * 4;
const measurements = segments.map((segment) => {
  const start = Math.ceil(segment.start / bytesPerFrame);
  const end = Math.floor(segment.end / bytesPerFrame);
  assert(end - start > 4800, `Speed ${segment.speed}: too little PCM (${start} to ${end})`);
  const frequencies = [0, 1, 2, 4, 5].map((channel) => {
    let previousCrossing: number | null = null;
    let firstCrossing = 0;
    let crossings = 0;
    for (let frame = start + 1; frame < end; frame++) {
      const previous = audio.readFloatLE((frame - 1) * bytesPerFrame + channel * 4);
      const value = audio.readFloatLE(frame * bytesPerFrame + channel * 4);
      assert(Number.isFinite(value), "Non-finite PCM sample");
      if (previous <= 0 && value > 0) {
        const crossing = frame - 1 - previous / (value - previous);
        if (previousCrossing === null) firstCrossing = crossing;
        previousCrossing = crossing;
        crossings++;
      }
    }
    assert(previousCrossing !== null && crossings > 10, "Missing channel output");
    return ((crossings - 1) * 48000) / (previousCrossing - firstCrossing);
  });
  for (const frequency of frequencies)
    assert(Math.abs(frequency - 440) < 1.5, `Pitch changed at ${segment.speed}x: ${frequency} Hz`);
  // A 20 ms window of a continuous test tone must never turn silent, including near transitions.
  for (let frame = start; frame + 960 < end; frame += 960) {
    let energy = 0;
    for (let i = frame; i < frame + 960; i++)
      energy += audio.readFloatLE(i * bytesPerFrame + 8) ** 2;
    assert(energy / 960 > 0.001, "Center-channel dropout");
  }
  return {
    speed: segment.speed,
    sampleAgeMs: segment.sampleAgeMs,
    measuredSpeed: segment.measuredSpeed,
    frequenciesHz: frequencies,
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
