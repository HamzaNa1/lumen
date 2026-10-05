import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  statfs,
  truncate,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeConfig } from "../../apps/server/src/config/Config";
import { createLogger } from "../../apps/server/src/core/Logger";
import {
  ManagedStreaming,
  sourceFingerprint,
} from "../../apps/server/src/features/playback/ManagedStreaming";
import {
  parseManagedPlaylist,
  verifyIdrPacket,
} from "../../apps/server/src/features/playback/ManagedPackage";
import {
  managedBufferPolicy,
  type ManagedSource,
} from "../../apps/server/src/features/playback/ManagedProfile";
import { parseProbeOutput } from "../../apps/server/src/media/Ffprobe";
import { runMediaProcess } from "../../apps/server/src/media/MediaProcess";

const temporary: string[] = [];
const managers: ManagedStreaming[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const setup = async (filename = "playback.mp4", overrides = {}) => {
  const root = await mkdtemp(join(tmpdir(), "lumen-managed-test-"));
  temporary.push(root);
  const media = join(root, "media");
  await mkdir(media);
  const path = join(media, filename);
  await copyFile(resolve("tests/fixtures", filename), path);
  const config = {
    ...decodeConfig({}),
    dataDir: join(root, "data"),
    managedStreaming: true,
    streamFreeReserveBytes: 0,
    ...overrides,
  };
  const manager = await ManagedStreaming.create(config, createLogger({ level: "error" }));
  managers.push(manager);
  // Core packager tests must fail if CI has not installed FFmpeg; they never silently skip.
  expect(manager.available).toBe(true);
  const source: ManagedSource = {
    sessionId: "viewer-1",
    trackId: "track",
    sourceId: "source",
    absolutePath: path,
    rootPath: media,
    video: { id: "video", ordinal: 0 },
    audio: { id: "audio", ordinal: 1 },
  };
  return { root, config, manager, source };
};

const finished = async (manager: ManagedStreaming, source: ManagedSource) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await manager.status(source);
    if (status.state !== "queued" && status.state !== "preparing") return status;
    await Bun.sleep(25);
  }
  throw new Error("Preparation did not finish within the test deadline");
};

test("fractional ffprobe durations remain available to catalog ingestion", () => {
  expect(parseProbeOutput({ format: { duration: "20.041667" }, streams: [] }).durationMs).toBe(
    20_042,
  );
  expect(parseProbeOutput({ format: { duration: "NaN" }, streams: [] }).durationMs).toBeNull();
  expect(parseProbeOutput({ format: { duration: "-2.3" }, streams: [] }).durationMs).toBeNull();
});

describe("completed stream-copy packaging", () => {
  test("shares one package, preserves codecs and timing, validates decode continuity, and cancels only its own waiter", async () => {
    const { manager, source } = await setup();
    const other = { ...source, sessionId: "viewer-2" };
    const [first, second] = await Promise.all([manager.prepare(source), manager.prepare(other)]);
    expect(first.packageId).toBe(second.packageId);
    manager.release(source.sessionId);
    expect((await manager.status(source)).state).toBe("cancelled");
    const ready = await finished(manager, other);
    expect(ready.state).toBe("ready");
    expect(ready.mimeType).toBe('video/mp4; codecs="avc1.64001e,mp4a.40.2"');
    const directory = join(manager.cachePath, ready.packageId ?? "");
    const playlist = await readFile(join(directory, "index.m3u8"), "utf8");
    expect(playlist).not.toContain("grant");
    expect(playlist).not.toContain(source.absolutePath);
    const segments = parseManagedPlaylist(playlist);
    expect(segments.map((segment) => segment.duration)).toEqual([10.416667, 9.583333]);
    const joined = join(directory, "decode-test.mp4");
    await Bun.write(
      joined,
      Buffer.concat(
        await Promise.all(
          ["init.mp4", ...segments.map((segment) => segment.name)].map((name) =>
            readFile(join(directory, name)),
          ),
        ),
      ),
    );
    await runMediaProcess(
      ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", joined, "-f", "null", "-"],
      { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
    );
    await rm(joined);
    expect(
      (await readdir(manager.cachePath)).filter((name) => /^[a-f0-9]{64}$/u.test(name)),
    ).toHaveLength(1);
  });

  for (const variant of [
    "matroska",
    "video-only",
    "variable-frame-rate",
    "irregular-gop",
  ] as const) {
    test(`packages and decodes the supported ${variant} fixture`, async () => {
      const { manager, source } = await setup();
      const output = join(source.rootPath, variant === "matroska" ? "variant.mkv" : "variant.mp4");
      const generated = variant === "variable-frame-rate" || variant === "irregular-gop";
      await runMediaProcess(
        [
          "ffmpeg",
          "-nostdin",
          "-v",
          "error",
          "-i",
          source.absolutePath,
          ...(variant === "video-only" ? ["-an"] : []),
          ...(generated
            ? [
                "-vf",
                variant === "variable-frame-rate"
                  ? "select='if(lt(t,10),not(mod(n,2)),not(mod(n,3)))',setpts=PTS"
                  : "null",
                "-fps_mode",
                "vfr",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "120",
                ...(variant === "irregular-gop" ? ["-force_key_frames", "0,3,11,17"] : []),
                "-c:a",
                "copy",
              ]
            : ["-c", "copy"]),
          output,
        ],
        { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
      );
      const selected = {
        ...source,
        absolutePath: output,
        audio: variant === "video-only" ? null : source.audio,
      };
      await manager.prepare(selected);
      expect((await finished(manager, selected)).state).toBe("ready");
    });
  }

  for (const filename of ["playback-dts.mkv", "playback-ac3.mkv", "playback-eac3.mkv"]) {
    test(`refuses the intended unsupported audio in ${filename}`, async () => {
      const { manager, source } = await setup(filename);
      await manager.prepare(source);
      const failed = await finished(manager, source);
      expect(failed.state).toBe("failed");
      expect(failed.unavailableReason).toContain("AAC-LC");
      expect(
        (await readdir(manager.cachePath)).filter(
          (name) => name.startsWith("temporary-") || /^[a-f0-9]{64}$/u.test(name),
        ),
      ).toEqual([]);
    });
  }

  test("never substitutes a supported alternate audio track for an unsupported default", async () => {
    const { manager, source } = await setup();
    const output = join(source.rootPath, "multiple.mkv");
    await runMediaProcess(
      [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-i",
        source.absolutePath,
        "-map",
        "0:v",
        "-map",
        "0:a",
        "-map",
        "0:a",
        "-c",
        "copy",
        "-c:a:0",
        "ac3",
        "-disposition:a:0",
        "default",
        "-disposition:a:1",
        "0",
        output,
      ],
      { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
    );
    const selected = { ...source, absolutePath: output };
    await manager.prepare(selected);
    expect((await finished(manager, selected)).unavailableReason).toContain("AAC-LC");
  });

  test("rejects long GOPs and nonzero starts instead of claiming arbitrary seekability", async () => {
    const { manager, source } = await setup();
    const long = join(source.rootPath, "long.mp4");
    await runMediaProcess(
      [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=s=64x64:r=24:d=32",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-g",
        "768",
        "-keyint_min",
        "768",
        "-sc_threshold",
        "0",
        long,
      ],
      { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
    );
    const selected = { ...source, absolutePath: long, audio: null };
    await manager.prepare(selected);
    expect((await finished(manager, selected)).unavailableReason).toContain("duration limit");
    const offset = join(source.rootPath, "offset.mp4");
    await runMediaProcess(
      [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-i",
        source.absolutePath,
        "-c",
        "copy",
        "-output_ts_offset",
        "5",
        offset,
      ],
      { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
    );
    const shifted = { ...source, sessionId: "offset", absolutePath: offset };
    await manager.prepare(shifted);
    expect((await finished(manager, shifted)).unavailableReason).toContain("timeline");
  });

  test("a malformed source never leaves a published partial package", async () => {
    const { manager, source } = await setup();
    await Bun.write(source.absolutePath, (await readFile(source.absolutePath)).subarray(0, 128));
    await manager.prepare(source);
    expect((await finished(manager, source)).state).toBe("failed");
    expect(
      (await readdir(manager.cachePath)).filter((name) => /^[a-f0-9]{64}$/u.test(name)),
    ).toEqual([]);
  });

  test("rechecks same-size same-mtime replacements, removed sources, and missing ready files", async () => {
    const { manager, source } = await setup();
    const identity = await sourceFingerprint(source);
    await manager.prepare(source);
    const ready = await finished(manager, source);
    expect(ready.state).toBe("ready");
    await rm(join(manager.cachePath, ready.packageId ?? "", "segment-0.m4s"));
    await expect(manager.artifact(source, ready.packageId ?? "", "segment-0.m4s")).rejects.toThrow(
      "unavailable",
    );
    expect((await manager.status(source)).state).toBe("failed");
    const bytes = await readFile(source.absolutePath);
    await Bun.write(source.absolutePath, bytes);
    const metadata = JSON.parse(identity.fingerprint) as (string | number | null)[];
    await utimes(source.absolutePath, Date.now() / 1000, Number(metadata[3]) / 1000);
    expect((await sourceFingerprint(source)).id).not.toBe(identity.id);
    await rm(source.absolutePath);
    expect((await manager.status(source)).state).toBe("failed");
  });

  test("cache locking, crash cleanup, restart reuse, and leased eviction remain bounded", async () => {
    const { manager, source, config } = await setup("playback.mp4", {
      streamCacheBytes: 36 * 1024 ** 2,
    });
    const competing = await ManagedStreaming.create(config, createLogger({ level: "error" }));
    managers.push(competing);
    expect(competing.available).toBe(false);
    await manager.prepare(source);
    const ready = await finished(manager, source);
    expect(ready.state).toBe("ready");
    const other = { ...source, sessionId: "different", sourceId: "different" };
    await manager.prepare(other);
    expect((await finished(manager, other)).unavailableReason).toContain("budget");
    manager.release(source.sessionId);
    await manager.close();
    await mkdir(join(manager.cachePath, "temporary-crashed"));
    await Bun.write(join(manager.cachePath, "temporary-crashed", "index.m3u8"), "#EXTM3U");
    const restarted = await ManagedStreaming.create(config, createLogger({ level: "error" }));
    managers.push(restarted);
    expect(restarted.available).toBe(true);
    expect(
      (await readdir(manager.cachePath)).filter((name) => name.startsWith("temporary-")),
    ).toEqual([]);
    expect((await restarted.prepare(source)).state).toBe("ready");
    expect((await restarted.status(source)).packageId).toBe(ready.packageId);
  });
});

test("playlist validation rejects traversal, missing ENDLIST, and excessive duration", () => {
  const valid =
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10.5,\nsegment-0.m4s\n#EXT-X-ENDLIST\n';
  expect(parseManagedPlaylist(valid)[0]?.duration).toBe(10.5);
  for (const invalid of [
    valid.replace("segment-0.m4s", "../private"),
    valid.replace("#EXT-X-ENDLIST\n", ""),
    valid.replace("10.5,", "16,"),
  ])
    expect(() => parseManagedPlaylist(invalid)).toThrow();
});

test("encoded buffer planning reduces targets and refuses an impossible readiness window", () => {
  const segments = [{ name: "segment-0.m4s", duration: 5, size: 10 * 1024 ** 2 }];
  const policy = managedBufferPolicy(segments);
  expect(policy.forwardBufferSeconds).toBeLessThan(30);
  expect(policy.forwardBufferSeconds).toBeGreaterThanOrEqual(5);
  expect(policy.encodedWindowBytes).toBeLessThanOrEqual(64 * 1024 ** 2);
  expect(() => managedBufferPolicy([{ name: "x", duration: 1, size: 16 * 1024 ** 2 }])).toThrow(
    "readiness",
  );
});

test("media subprocesses drain stderr and terminate/reap hung or cancelled children", async () => {
  const args = [
    process.execPath,
    "-e",
    'process.stderr.write("x".repeat(200000)); process.stdout.write("ok")',
  ];
  expect(await runMediaProcess(args, { timeoutMs: 2_000, maxOutputBytes: 300_000 })).toBe("ok");
  await expect(
    runMediaProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 25,
      maxOutputBytes: 1024,
    }),
  ).rejects.toThrow("timed out");
  const abort = new AbortController();
  const pending = runMediaProcess(
    [process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { timeoutMs: 5_000, maxOutputBytes: 1024, signal: abort.signal },
  );
  setTimeout(() => abort.abort(), 100);
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
});

test("queue admission deduplicates active work, bounds unique packages, and reaps cancelled work", async () => {
  const executableDir = await mkdtemp(join(tmpdir(), "lumen-test-packager-"));
  temporary.push(executableDir);
  const executable = join(executableDir, "ffmpeg");
  const callsFile = join(executableDir, "calls.jsonl");
  await Bun.write(
    executable,
    `#!${process.execPath}
if (process.argv.includes("-version")) process.exit(0);
await Bun.write(${JSON.stringify(callsFile)}, JSON.stringify(process.argv));
setInterval(() => process.stdout.write("progress=continue\\n"), 100);
`,
  );
  await chmod(executable, 0o700);
  const { manager, source } = await setup("playback.mp4", { ffmpegPath: executable });
  const first = await manager.prepare(source);
  const second = { ...source, sessionId: "second-viewer" };
  expect((await manager.prepare(second)).packageId).toBe(first.packageId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await Bun.file(callsFile).exists()) break;
    await Bun.sleep(10);
  }
  const command = JSON.parse(await readFile(callsFile, "utf8")) as string[];
  expect(command).toContain("copy");
  expect(command).not.toContain("libx264");
  for (let index = 0; index < 8; index += 1)
    expect(
      (
        await manager.prepare({
          ...source,
          sessionId: `queued-${index}`,
          sourceId: `source-${index}`,
        })
      ).state,
    ).toBe("queued");
  expect(
    (await manager.prepare({ ...source, sessionId: "overflow", sourceId: "overflow" }))
      .unavailableReason,
  ).toContain("queue is full");
  manager.release(source.sessionId);
  expect((await manager.status(second)).state).toBe("preparing");
  manager.release(second.sessionId);
  await manager.close();
  expect(
    (await readdir(manager.cachePath)).filter((name) => name.startsWith("temporary-")),
  ).toEqual([]);
});

test("disk reserve, oversized-source admission, and missing FFmpeg fail without publishing output", async () => {
  const { source, manager, config } = await setup("playback.mp4", {
    streamPackageBytes: 40 * 1024 ** 2,
  });
  await truncate(source.absolutePath, 40 * 1024 ** 2);
  expect((await manager.prepare(source)).unavailableReason).toContain("size limit");
  await copyFile(resolve("tests/fixtures/playback.mp4"), source.absolutePath);
  await manager.close();
  const disk = await statfs(config.dataDir);
  const full = await ManagedStreaming.create(
    { ...config, streamFreeReserveBytes: disk.bavail * disk.bsize + 1024 ** 3 },
    createLogger({ level: "error" }),
  );
  managers.push(full);
  await full.prepare(source);
  expect((await finished(full, source)).unavailableReason).toContain("free space");
  await full.close();
  const absent = await ManagedStreaming.create(
    { ...config, ffmpegPath: join(config.dataDir, "missing-ffmpeg") },
    createLogger({ level: "error" }),
  );
  managers.push(absent);
  expect(absent.available).toBe(false);
  expect((await absent.prepare(source)).state).toBe("failed");
});

test("random-access validation rejects non-IDR open-GOP pictures despite keyframe flags", async () => {
  const { manager, source } = await setup();
  const openGop = join(source.rootPath, "open-gop.mp4");
  await runMediaProcess(
    [
      "ffmpeg",
      "-nostdin",
      "-v",
      "error",
      "-i",
      source.absolutePath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "120",
      "-keyint_min",
      "120",
      "-sc_threshold",
      "0",
      "-x264-params",
      "open-gop=1",
      "-c:a",
      "copy",
      openGop,
    ],
    { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
  );
  const selected = { ...source, absolutePath: openGop };
  await manager.prepare(selected);
  const failed = await finished(manager, selected);
  expect(failed.state).toBe("failed");
  expect(failed.unavailableReason).toContain("IDR");
  const packet = join(source.rootPath, "packet.bin");
  await Bun.write(packet, new Uint8Array([0, 0, 0, 1, 0x41]));
  await expect(verifyIdrPacket(packet, 0, 5, 4)).rejects.toThrow("IDR");
  await Bun.write(packet, new Uint8Array([0, 0, 0, 1, 0x65]));
  await verifyIdrPacket(packet, 0, 5, 4);
});

test("a high-bitrate segment exceeds admission instead of bypassing the browser buffer budget", async () => {
  const { manager, source } = await setup();
  const burst = join(source.rootPath, "burst.mp4");
  await runMediaProcess(
    [
      "ffmpeg",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=640x360:r=30:d=8,noise=alls=100:allf=t+u",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "18",
      "-g",
      "240",
      "-keyint_min",
      "240",
      "-sc_threshold",
      "0",
      burst,
    ],
    { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 },
  );
  const selected = { ...source, absolutePath: burst, audio: null };
  await manager.prepare(selected);
  const failed = await finished(manager, selected);
  expect(failed.state).toBe("failed");
  expect(failed.unavailableReason).toContain("size limit");
});
