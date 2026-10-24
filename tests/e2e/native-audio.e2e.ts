import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpvIpc } from "../../apps/desktop/src/main/player/MpvIpc";
import type { MpvProcess } from "../../apps/desktop/src/main/player/MpvProcess";
import {
  mpvPitchArguments,
  sampleMpvPlayback,
} from "../../apps/desktop/src/main/player/MpvSynchronization";
import { analyzeAudioTransition } from "./support/audio-transition";
import { expect, repository, test } from "./support/server";

for (const codec of ["eac3", "ac3", "dca"])
  test(`MPV decodes 5.1 ${codec} and preserves every channel and pitch through watch synchronization speed corrections`, async ({
    playwright: _playwright,
  }, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "lumen-pcm-"));
    const clip = join(root, "tone.mkv");
    const pcm = join(root, "audio.pcm");
    const log = join(root, "mpv.log");
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\lumen-audio-${process.pid}`
        : join(root, "mpv.sock");
    const encoded = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=${[440, 440, 440, 80, 440, 440].map((f) => `0.15*sin(2*PI*${f}*t)`).join("|")}:s=48000:d=30:c=5.1`,
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=24:d=30",
        "-c:v",
        "mpeg4",
        "-c:a",
        codec,
        "-strict",
        "-2",
        "-b:a",
        codec === "dca" ? "768k" : "640k",
        clip,
      ],
      { timeout: 15000 },
    );
    expect(encoded.status, encoded.stderr.toString()).toBe(0);
    const child = spawn(
      process.platform === "win32"
        ? join(repository, "apps/desktop/resources/native/mpv.exe")
        : "mpv",
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
    const captures: { speed: number; start: number; end: number }[] = [];
    const bytes = async () => (await stat(pcm).catch(() => null))?.size ?? 0;
    try {
      await ipc.connect({
        get socketPath() {
          return child.exitCode === null ? socket : null;
        },
      } as MpvProcess);
      await expect
        .poll(() => ipc.command(["get_property", "audio-out-params"]).catch(() => null))
        .toMatchObject({ "channel-count": 6, samplerate: 48000, format: "float" });
      expect(await ipc.command(["get_property", "audio-pitch-correction"])).toBe(true);
      await expect.poll(bytes).toBeGreaterThan(4800 * 6 * 4);
      for (const speed of [1, 1.01, 1.006, 1, 0.99, 0.994, 1]) {
        const start = (await bytes()) - 4800 * 6 * 4;
        await ipc.command(["set_property", "speed", speed]);
        const after = await bytes();
        await expect.poll(bytes).toBeGreaterThan(after + 2 * 48000 * 6 * 4);
        captures.push({ speed, start, end: await bytes() });
        const sample = await sampleMpvPlayback(ipc, {
          sessionId: "e2e",
          itemId: "tone",
          positionSeconds: 0,
          durationSeconds: 30,
          paused: false,
        });
        expect(sample).toMatchObject({ speed, advancing: true });
        expect(performance.now() - (sample?.sampledAtMs ?? 0)).toBeLessThan(100);
        expect(await ipc.command(["get_property", "af"])).toEqual([
          expect.objectContaining({ name: "scaletempo2" }),
        ]);
      }
      await ipc.command(["set_property", "pause", "yes"]);
      expect(
        await sampleMpvPlayback(ipc, {
          sessionId: "e2e",
          itemId: "tone",
          positionSeconds: 0,
          durationSeconds: 30,
          paused: false,
        }),
      ).toMatchObject({ advancing: false });
      await ipc.command(["quit"]);
      await exited;
      const audio = await readFile(pcm);
      const measurements = captures.map((capture) => ({
        speed: capture.speed,
        ...analyzeAudioTransition(audio, capture.start, capture.end),
      }));
      const filters = await readFile(log, "utf8");
      expect(filters.match(/\[af\] \[scaletempo2\]/g)).toHaveLength(1);
      expect(filters).not.toMatch(/adding scaletempo2|removing audio speed filter/);
      const corrupt = Buffer.from(audio);
      const first = captures[0];
      if (!first) throw new Error("Missing PCM capture");
      corrupt.fill(0, first.start + 4800 * 6 * 4, first.start + 7200 * 6 * 4);
      expect(() => analyzeAudioTransition(corrupt, first.start, first.end)).toThrow(/dropout/);
      await testInfo.attach("audio measurements", {
        body: JSON.stringify(measurements),
        contentType: "application/json",
      });
      await testInfo.attach("MPV log", { path: log });
    } catch (cause) {
      if (await stat(pcm).catch(() => null))
        await testInfo.attach("failed PCM capture", { path: pcm });
      if (await stat(log).catch(() => null)) await testInfo.attach("failed MPV log", { path: log });
      await testInfo.attach("capture windows", {
        body: JSON.stringify(captures),
        contentType: "application/json",
      });
      throw cause;
    } finally {
      ipc.close();
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
