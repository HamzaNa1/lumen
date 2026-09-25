import type { IpcLibrary, JobLogEntry } from "@lumen/contracts";

export const titleCase = (value: string): string =>
  value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Electron wraps errors thrown by the main process: "Error invoking remote method 'x': Error: …".
const ipcPrefix = /^Error invoking remote method '[^']*': (?:\w*Error: )?/;
const filesystemErrors: ReadonlyArray<readonly [RegExp, (path: string) => string]> = [
  [/^ENOENT\b.*'(.+)'/, (path) => `“${path}” doesn’t exist on the server.`],
  [/^ENOTDIR\b.*'(.+)'/, (path) => `“${path}” isn’t a folder.`],
  [/^EACCES\b.*'(.+)'/, (path) => `The server doesn’t have permission to read “${path}”.`],
];

// Node's fetch reports an unreachable host as "fetch failed" (or a raw socket error code).
const networkError = /^fetch failed$|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)\b/;

export const errorMessage = (cause: unknown, fallback: string): string => {
  if (!(cause instanceof Error)) return fallback;
  const message = cause.message.replace(ipcPrefix, "").trim();
  if (networkError.test(message))
    return "Couldn’t reach the server. Check that it’s running and reachable from this device.";
  for (const [pattern, describe] of filesystemErrors) {
    const match = pattern.exec(message);
    if (match?.[1] !== undefined) return describe(match[1]);
  }
  return message === "" ? fallback : message;
};

const itemKindLabels: Record<string, string> = {
  movie: "Movie",
  show: "TV series",
  season: "Season",
  episode: "Episode",
  album: "Album",
  artist: "Artist",
  track: "Track",
};
export const kindLabel = (kind: string): string => itemKindLabels[kind] ?? titleCase(kind);

export const libraryKindLabels: Record<IpcLibrary["kind"], string> = {
  movies: "Movies",
  shows: "TV shows",
  music: "Music",
};

export const libraryCount = (kind: IpcLibrary["kind"], count: number, more = false): string => {
  const noun =
    kind === "movies"
      ? ["movie", "movies"]
      : kind === "shows"
        ? ["show", "shows"]
        : ["title", "titles"];
  return `${count}${more ? "+" : ""} ${count === 1 && !more ? noun[0] : noun[1]}`;
};

export const roleLabels = { admin: "Administrator", user: "User", guest: "Guest" } as const;

export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** 83 seconds → "1:23", 5000 seconds → "1:23:20". */
export const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secondsPart = String(total % 60).padStart(2, "0");
  return total >= 3_600
    ? `${Math.floor(total / 3_600)}:${String(minutes % 60).padStart(2, "0")}:${secondsPart}`
    : `${minutes}:${secondsPart}`;
};

/** 5640 seconds → "1h 34m". */
export const formatRuntime = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const remainder = minutes % 60;
  return remainder === 0
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 60)}h ${remainder}m`;
};

const releaseDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
export const formatReleaseDate = (value: string): string => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : releaseDateFormatter.format(date);
};

export const metadataList = (value: string | undefined): string[] => {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};

const jobDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
export const formatJobDate = (milliseconds: number): string =>
  jobDateFormatter.format(milliseconds);

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export const formatRelative = (milliseconds: number, nowMs = Date.now()): string => {
  const seconds = Math.round((milliseconds - nowMs) / 1_000);
  if (Math.abs(seconds) < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormatter.format(hours, "hour");
  return formatJobDate(milliseconds);
};

export const shortId = (id: string): string => id.slice(0, 8);

export const formatElapsed = (startedAtMs: number | null, finishedAtMs: number | null): string => {
  if (startedAtMs === null) return "—";
  const elapsed = Math.max(0, (finishedAtMs ?? Date.now()) - startedAtMs);
  if (elapsed < 1_000) return "<1s";
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const jobStatusLabels: Record<JobLogEntry["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const jobErrorDescriptions: Record<string, string> = {
  LEASE_EXPIRED: "Timed out. The job stopped responding before it finished.",
};

/** The reason a job failed (or is being retried); null once it has succeeded. */
export const jobErrorText = (job: JobLogEntry): string | null => {
  if (job.status === "succeeded") return null;
  if (job.errorMessage !== null) return job.errorMessage;
  if (job.errorCode === null) return null;
  return jobErrorDescriptions[job.errorCode] ?? job.errorCode;
};
