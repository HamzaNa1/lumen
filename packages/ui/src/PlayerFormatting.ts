import type { IpcPlayableStream } from "@lumen/contracts";

const languageNames = new Intl.DisplayNames(undefined, { type: "language" });

const audioCodecs: Readonly<Record<string, string>> = {
  aac: "AAC",
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  flac: "FLAC",
  mp3: "MP3",
  opus: "Opus",
  vorbis: "Vorbis",
};

const languageName = (code: string | null): string | null => {
  if (code === null || code === "" || code === "und") return null;
  try {
    const name = languageNames.of(code);
    return name === undefined || name === code ? code.toUpperCase() : name;
  } catch {
    return code.toUpperCase();
  }
};

const audioCodec = (codec: string | null): string | null => {
  if (codec === null || codec === "") return null;
  if (codec.startsWith("pcm_")) return "PCM";
  return audioCodecs[codec] ?? codec.toUpperCase();
};

const baseLabel = (stream: IpcPlayableStream, index: number): string => {
  const parts: string[] = [];
  for (const part of [
    languageName(stream.language),
    stream.title,
    stream.kind === "audio" ? audioCodec(stream.codec) : null,
  ]) {
    if (part === null || part === "") continue;
    if (!parts.some((existing) => existing.toLowerCase() === part.toLowerCase())) parts.push(part);
  }
  return parts.length === 0 ? `Track ${index + 1}` : parts.join(" · ");
};

/** Viewer-facing names for a list of audio or subtitle streams, e.g. "English · Commentary · AAC". */
export const streamLabels = (streams: ReadonlyArray<IpcPlayableStream>): string[] => {
  const labels = streams.map(baseLabel);
  return labels.map((label, index) =>
    labels.indexOf(label) === labels.lastIndexOf(label) || label.startsWith("Track ")
      ? label
      : `${label} · Track ${index + 1}`,
  );
};

export const formatPlayerTime = (seconds: number): string => {
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  const secondsPart = String(value % 60).padStart(2, "0");
  return value >= 3_600
    ? `${Math.floor(value / 3_600)}:${String(minutes % 60).padStart(2, "0")}:${secondsPart}`
    : `${minutes}:${secondsPart}`;
};
