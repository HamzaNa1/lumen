import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { runMediaProcess } from "../../media/MediaProcess";
import {
  MAX_PACKAGE_SEGMENTS,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENT_SECONDS,
  ManagedPreparationError,
  managedAvcConfiguration,
  managedBufferPolicy,
  managedMimeType,
  type ManagedSegment,
} from "./ManagedProfile";

export const PackageIndex = Schema.Struct({
  packageId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  fingerprint: Schema.String,
  sourceId: Schema.String,
  videoStreamId: Schema.String,
  audioStreamId: Schema.NullOr(Schema.String),
  mimeType: Schema.String,
  size: Schema.Number,
  lastUsedAtMs: Schema.Number,
  forwardBufferSeconds: Schema.Number,
  backBufferSeconds: Schema.Number,
  encodedWindowBytes: Schema.Number,
  segments: Schema.Array(
    Schema.Struct({ name: Schema.String, duration: Schema.Number, size: Schema.Number }),
  ),
});
export type PackageIndex = Schema.Schema.Type<typeof PackageIndex>;

export const parseManagedPlaylist = (
  playlist: string,
): ReadonlyArray<{ readonly name: string; readonly duration: number }> => {
  if (
    playlist.length > 2 * 1024 ** 2 ||
    !playlist.startsWith("#EXTM3U\n") ||
    !playlist.includes("#EXT-X-PLAYLIST-TYPE:VOD\n") ||
    !playlist.endsWith("#EXT-X-ENDLIST\n")
  )
    throw new ManagedPreparationError("The completed playlist is invalid");
  const segments: { name: string; duration: number }[] = [];
  let duration: number | null = null;
  let maps = 0;
  for (const line of playlist.trim().split("\n")) {
    if (line === '#EXT-X-MAP:URI="init.mp4"') maps += 1;
    else if (line.startsWith("#EXTINF:")) {
      if (duration !== null || !/^#EXTINF:\d+(\.\d+)?,.*$/u.test(line))
        throw new ManagedPreparationError("Invalid segment duration");
      duration = Number(line.slice(8).split(",")[0]);
      if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SEGMENT_SECONDS)
        throw new ManagedPreparationError(
          "The source keyframes exceed the managed segment duration limit",
        );
    } else if (!line.startsWith("#")) {
      if (duration === null || line !== `segment-${segments.length}.m4s`)
        throw new ManagedPreparationError("Invalid segment reference");
      segments.push({ name: line, duration });
      duration = null;
    } else if (
      !/^#EXT(M3U|INF:|-X-(VERSION:\d+|TARGETDURATION:\d+|MEDIA-SEQUENCE:0|PLAYLIST-TYPE:VOD|ENDLIST))$/u.test(
        line,
      )
    ) {
      throw new ManagedPreparationError("Unexpected playlist directive");
    }
  }
  if (
    maps !== 1 ||
    duration !== null ||
    segments.length === 0 ||
    segments.length > MAX_PACKAGE_SEGMENTS
  )
    throw new ManagedPreparationError("Invalid completed playlist");
  return segments;
};

export const packageFiles = async (
  directory: string,
  maxBytes: number,
): Promise<readonly ManagedSegment[]> => {
  const playlist = await readFile(join(directory, "index.m3u8"), "utf8");
  const referenced = parseManagedPlaylist(playlist);
  const files = ["index.m3u8", "init.mp4", ...referenced.map((segment) => segment.name)];
  let total = 0;
  const sizes = new Map<string, number>();
  for (const name of files) {
    const file = await lstat(join(directory, name));
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size <= 0 ||
      file.size > (name === "index.m3u8" ? 2 * 1024 ** 2 : MAX_SEGMENT_BYTES)
    )
      throw new ManagedPreparationError(
        "A managed package file is missing or exceeds its size limit",
      );
    total += file.size;
    if (total > maxBytes)
      throw new ManagedPreparationError("The managed package exceeds its size limit");
    sizes.set(name, file.size);
  }
  return referenced.map((segment) => ({ ...segment, size: sizes.get(segment.name) ?? 0 }));
};

/** An I-frame marked as a key packet can still belong to an open GOP. Require an IDR slice. */
export const verifyIdrPacket = async (
  path: string,
  position: number,
  size: number,
  lengthSize: number,
): Promise<void> => {
  if (
    ![1, 2, 4].includes(lengthSize) ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_SEGMENT_BYTES
  )
    throw new ManagedPreparationError("Invalid AVC packet boundary");
  const file = await open(path, "r");
  const header = Buffer.alloc(lengthSize + 1);
  try {
    let offset = 0;
    for (let count = 0; count < 1024 && offset + header.length <= size; count += 1) {
      const read = await file.read(header, 0, header.length, position + offset);
      if (read.bytesRead !== header.length) break;
      const nalSize = header.readUIntBE(0, lengthSize);
      if (nalSize < 1 || offset + lengthSize + nalSize > size) break;
      const type = (header[lengthSize] ?? 0) & 31;
      if (type === 5) return;
      if (type === 1) break;
      offset += lengthSize + nalSize;
    }
    throw new ManagedPreparationError(
      "The segment does not begin with an independently decodable IDR picture",
    );
  } finally {
    await file.close();
  }
};

/** Every published segment must begin at a muxer-identified random-access video packet. */
export const validateManagedPackage = async (
  directory: string,
  ffprobe: string,
  maxBytes: number,
  expectedDurationSeconds: number,
  audio: boolean,
  signal: AbortSignal,
) => {
  const segments = await packageFiles(directory, maxBytes);
  const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  if (Math.abs(totalDuration - expectedDurationSeconds) > 0.5)
    throw new ManagedPreparationError("The packaged duration does not match the source timeline");
  const init = await readFile(join(directory, "init.mp4"));
  const mimeType = managedMimeType(init, audio);
  const { nalLengthSize } = managedAvcConfiguration(init);
  const validationPath = join(directory, "validation.mp4");
  let previousStart = -1;
  let expectedStart: number | null = null;
  try {
    for (const segment of segments) {
      signal.throwIfAborted();
      await Bun.write(
        validationPath,
        Buffer.concat([init, await readFile(join(directory, segment.name))]),
      );
      const output = await runMediaProcess(
        [
          ffprobe,
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "v:0",
          "-read_intervals",
          "%+#1",
          "-show_packets",
          "-show_entries",
          "packet=flags,pts_time,dts_time,pos,size",
          "-of",
          "json",
          validationPath,
        ],
        { timeoutMs: 15_000, maxOutputBytes: 64 * 1024, signal },
      );
      const value = Schema.decodeUnknownSync(
        Schema.Struct({
          packets: Schema.Array(
            Schema.Struct({
              flags: Schema.String,
              pts_time: Schema.String,
              dts_time: Schema.String,
              pos: Schema.String,
              size: Schema.String,
            }),
          ),
        }),
      )(JSON.parse(output));
      const first = value.packets[0];
      const start = Number(first?.pts_time);
      if (
        first === undefined ||
        !first.flags.includes("K") ||
        !Number.isFinite(start) ||
        !Number.isFinite(Number(first.dts_time)) ||
        start <= previousStart ||
        (expectedStart === null && Math.abs(start) > 0.25) ||
        (expectedStart !== null && Math.abs(start - expectedStart) > 0.25)
      )
        throw new ManagedPreparationError(
          "A segment has an unverified random-access boundary or timeline",
        );
      await verifyIdrPacket(validationPath, Number(first.pos), Number(first.size), nalLengthSize);
      previousStart = start;
      expectedStart = start + segment.duration;
    }
  } finally {
    await rm(validationPath, { force: true });
  }
  return { segments, mimeType, ...managedBufferPolicy(segments) };
};
