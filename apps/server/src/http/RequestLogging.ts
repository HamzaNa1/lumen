import { newUuid } from "../core/Security";

const literalSegments = new Set([
  "api",
  "v1",
  "auth",
  "setup",
  "register",
  "login",
  "migrate-session",
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
