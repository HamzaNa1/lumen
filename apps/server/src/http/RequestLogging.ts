import { newUuid } from "../core/Security";

const literalSegments = new Set([
  "api",
  "v1",
  "auth",
  "setup",
  "register",
  "login",
  "migrate-session",
  "browser",
  "session",
  "me",
  "logout",
  "sessions",
  "users",
  "devices",
  "admin",
  "metadata-settings",
  "libraries",
  "jobs",
  "roots",
  "grants",
  "scans",
  "home",
  "items",
  "episode-order",
  "refresh",
  "metadata",
  "match",
  "children",
  "next-up",
  "tracks",
  "favorite",
  "watch-state",
  "search",
  "playback",
  "heartbeat",
  "progress",
  "events",
  "artwork",
  "sidecars",
  "library-roots",
  "media",
  "managed",
  "managed-media",
  "cancel",
  "retry",
]);
const operationalRoutes = new Set([
  "/health/live",
  "/health/ready",
  "/ready",
  "/metrics",
  "/diagnostics",
]);

export const requestRoute = (pathname: string): string => {
  if (operationalRoutes.has(pathname)) return pathname;
  if (!pathname.startsWith("/api/v1/")) return "unmatched";
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length > 8) return "unmatched";
  return `/${parts.map((part) => (literalSegments.has(part) ? part : ":id")).join("/")}`;
};

export const requestIdFor = (request: Request): string => {
  const supplied = request.headers.get("x-request-id");
  return supplied !== null &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(supplied)
    ? supplied.toLowerCase()
    : newUuid();
};

export const isRoutineProbe = (pathname: string): boolean =>
  operationalRoutes.has(pathname) && pathname !== "/diagnostics";

const httpMethods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

export const requestMethod = (method: string): string =>
  httpMethods.has(method) ? method : "OTHER";

/** Bounded, parsed range diagnostics; malformed values never enter logs verbatim. */
export const requestRange = (
  request: Request,
): { readonly [key: string]: string | number | null } => {
  const range = request.headers.get("range");
  if (range === null) return { kind: "full" };
  if (range.length > 128) return { kind: "invalid" };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (match === null || (match[1] === "" && match[2] === "")) return { kind: "invalid" };
  const start = match[1] === "" ? null : Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  if (
    (start !== null && !Number.isSafeInteger(start)) ||
    (end !== null && !Number.isSafeInteger(end))
  )
    return { kind: "invalid" };
  return { kind: start === null ? "suffix" : end === null ? "open" : "bounded", start, end };
};
