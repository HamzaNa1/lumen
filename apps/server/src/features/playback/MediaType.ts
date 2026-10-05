import { extname } from "node:path";

export const mediaMimeType = (path: string): string =>
  ({
    ".mkv": "video/x-matroska",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".wav": "audio/wav",
  })[extname(path).toLowerCase()] ?? "application/octet-stream";
