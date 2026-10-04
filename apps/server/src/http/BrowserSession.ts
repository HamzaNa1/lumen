import { BROWSER_CSRF_HEADER, BROWSER_SESSION_COOKIE } from "@lumen/contracts";
import type { ServerConfig } from "../config/Config";
import { forbidden } from "../core/Errors";

type OriginPolicy = Pick<ServerConfig, "allowedOrigins">;
type CookiePolicy = Pick<ServerConfig, "cookieSecure">;

const firstValue = (header: string | null): string | null =>
  header?.split(",")[0]?.trim() || null;

/**
 * The origin the client used to reach this server. Behind a TLS-terminating proxy the request
 * arrives as plain HTTP for an internal host, so the proxy's forwarded scheme and host win.
 */
export const requestOrigin = (request: Request): string => {
  const url = new URL(request.url);
  const forwardedProtocol = firstValue(request.headers.get("x-forwarded-proto"));
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? `${forwardedProtocol}:`
      : url.protocol;
  const host = firstValue(request.headers.get("x-forwarded-host")) ?? url.host;
  return `${protocol}//${host}`;
};

/** Whether a page from `origin` may act with this server's browser session. */
export const isTrustedOrigin = (request: Request, origin: string, policy: OriginPolicy): boolean =>
  origin === requestOrigin(request) || policy.allowedOrigins.includes(origin);

/**
 * Guards a state-changing request that relies on the session cookie. A page on another site can
 * make a browser send the cookie, but it cannot forge the Origin header, and it cannot add a
 * custom header without a preflight this server never approves.
 */
export const assertBrowserMutation = (request: Request, policy: OriginPolicy): void => {
  const origin = request.headers.get("origin");
  if (origin === null || !isTrustedOrigin(request, origin, policy))
    throw forbidden("Request did not come from this server's web app");
  if (request.headers.get(BROWSER_CSRF_HEADER) === null)
    throw forbidden("Request is missing its CSRF header");
};

export const sessionCookieToken = (request: Request): string | null => {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === BROWSER_SESSION_COOKIE)
      return pair.slice(separator + 1).trim() || null;
  }
  return null;
};

const cookieSecure = (request: Request, policy: CookiePolicy): boolean =>
  policy.cookieSecure === "auto"
    ? requestOrigin(request).startsWith("https:")
    : policy.cookieSecure === "always";

// Host-only (no Domain), unreadable by scripts, never sent with cross-site requests, and scoped
// to the API so it does not accompany requests for the app's own files.
const cookie = (
  request: Request,
  policy: CookiePolicy,
  value: string,
  maxAgeSeconds: number,
): string =>
  [
    `${BROWSER_SESSION_COOKIE}=${value}`,
    "Path=/api",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(cookieSecure(request, policy) ? ["Secure"] : []),
  ].join("; ");

/** The cookie lives exactly as long as the session it carries. */
export const sessionCookie = (
  request: Request,
  policy: CookiePolicy,
  token: string,
  expiresAtMs: number,
  nowMs: number,
): string =>
  cookie(request, policy, token, Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000)));

export const clearedSessionCookie = (request: Request, policy: CookiePolicy): string =>
  cookie(request, policy, "", 0);
