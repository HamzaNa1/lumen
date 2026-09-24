import type { IpcPlayableStream } from "@lumen/contracts";

export const streamLabel = (
  stream: IpcPlayableStream,
  index: number,
  count: number,
): string => {
  const name =
    stream.title ??
    stream.language?.toUpperCase() ??
    (stream.kind === "audio" ? "Audio" : "Subtitles");
  const language =
    stream.title !== null && stream.language !== null
      ? ` · ${stream.language.toUpperCase()}`
      : "";
  const codec = stream.codec === null ? "" : ` · ${stream.codec.toUpperCase()}`;
  const position = count > 1 ? ` · ${index + 1}` : "";
  return `${name}${language}${codec}${position}`;
};

export const formatPlayerTime = (seconds: number): string => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};
