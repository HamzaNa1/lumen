import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAudioTransition } from "../tests/e2e/support/audio-transition";

const destination = join(import.meta.dirname, "../tests/fixtures");
const temporary = await mkdtemp(join(tmpdir(), "lumen-audio-fixtures-"));
const hashes: Record<string, string> = {};
try {
  for (const codec of ["eac3", "ac3", "dca"]) {
    const file = `surround-${codec}.mkv`;
    const path = join(temporary, file);
    execFileSync(
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
        path,
      ],
      { timeout: 15000 },
    );
    const probe: {
      streams: {
        codec_type: string;
        codec_name: string;
        sample_rate?: string;
        channels?: number;
      }[];
      format: { duration: string };
    } = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        {
          encoding: "utf8",
          timeout: 15000,
        },
      ),
    );
    const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
    assert.equal(audio.length, 1);
    assert.equal(audio[0]?.codec_name, codec === "dca" ? "dts" : codec);
    assert.equal(audio[0]?.sample_rate, "48000");
    assert.equal(audio[0]?.channels, 6);
    assert(Number(probe.format.duration) >= 30 && Number(probe.format.duration) < 30.1);
    const pcm = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", path, "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"],
      { timeout: 15000, maxBuffer: 64 * 1024 * 1024 },
    );
    // Encoder priming is outside the playback windows measured by the native tests.
    analyzeAudioTransition(pcm, 4800 * 6 * 4, pcm.length - 4800 * 6 * 4);
    hashes[codec] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    console.log(`${file}: validated ${audio[0]?.codec_name}, 48 kHz, 5.1 and decoded tones`);
  }
  for (const codec of Object.keys(hashes)) {
    const file = `surround-${codec}.mkv`;
    await copyFile(join(temporary, file), join(destination, file));
  }
  await writeFile(join(destination, "surround-audio.json"), `${JSON.stringify(hashes, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
