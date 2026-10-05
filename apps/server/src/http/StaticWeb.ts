import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Effect } from "effect";
import type { ServerConfig } from "../config/Config";
import { LimitExceeded, RequestLimiter } from "../core/Limits";
import type { Logger } from "../core/Logger";
import { isPathWithin } from "../core/Paths";
import { requestOrigin } from "./BrowserSession";
import { clientKey, type RequestContext } from "./ClientIdentity";
import { serveFile } from "./ServeFile";

/** The browser app lives under this path; everything else belongs to the API. */
export const WEB_BASE = "/web";

export const isWebPath = (pathname: string): boolean =>
  pathname === WEB_BASE || pathname.startsWith(`${WEB_BASE}/`);

const ENTRY = "index.html";
// Vite fingerprints everything it writes here, so a given URL never changes its content.
const HASHED_ASSETS = "assets/";

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const text = (status: number, message: string, headers: Record<string, string> = {}): Response =>
  new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

/**
 * The policy for the app's own page. Scripts, styles and images come only from this server, and
 * the page talks only to this server's API and watch-group socket. Referrers are withheld
 * entirely so that a media URL carrying a playback grant is never disclosed to another site.
 */
const pageHeaders = (request: Request): Record<string, string> => {
  const socketOrigin = requestOrigin(request).replace(/^http/u, "ws");
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' blob:",
      "worker-src 'self'",
      `connect-src 'self' ${socketOrigin}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
};

/** The decoded path beneath /web, or null when it names nothing this handler would ever serve. */
const relativePath = (pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(WEB_BASE.length + 1));
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return decoded;
};

// Client-side routes have no file extension; anything that names a file must exist as one.
const namesFile = (path: string): boolean => path.startsWith(HASHED_ASSETS) || extname(path) !== "";

/** Fails when the browser app has not been built where the server expects it. */
export const assertWebBuild = async (root: string): Promise<void> => {
  const entry = await stat(join(root, ENTRY)).catch(() => null);
  if (entry?.isFile() !== true)
    throw new Error(
      `The web app is missing: ${join(root, ENTRY)} does not exist. Build it with "bun run build:web", or point LUMEN_WEB_ROOT at a built copy.`,
    );
  // A page without its scripts and styles would load and then show nothing.
  const assets = await readdir(join(root, HASHED_ASSETS)).catch(() => []);
  if (assets.length === 0)
    throw new Error(
      `The web app is incomplete: ${join(root, HASHED_ASSETS)} has no built files. Build it again with "bun run build:web".`,
    );
};

/**
 * Serves the built browser app. It only ever reads beneath its build directory, and a request
 * for a file that is not there is answered 404, never with the page.
 */
export const makeStaticWebHandler = (
  config: Pick<ServerConfig, "webRoot" | "maxRequestsPerMinute" | "maxConcurrentRequests"> &
    Partial<Pick<ServerConfig, "trustedProxies">>,
  logger: Logger,
): ((request: Request, context?: RequestContext) => Promise<Response>) => {
  // A page load fetches a handful of files at once. Counting those here, apart from the API's
  // limiter, keeps them from spending the allowance that sign-in and API requests rely on.
  const limiter = new RequestLimiter({
    maxRequests: config.maxRequestsPerMinute * 4,
    loginRequests: config.maxRequestsPerMinute * 4,
    maxActive: config.maxConcurrentRequests,
  });
  let sweptAtMs = Date.now();
  const log = logger.child({ component: "web" });
  const root = resolve(config.webRoot);

  /** The real location of a file inside the build, or null when it is absent or escapes it. */
  const locate = async (path: string) => {
    try {
      const [base, target] = await Promise.all([realpath(root), realpath(resolve(root, path))]);
      if (!isPathWithin(base, target)) return null;
      const details = await stat(target);
      return details.isFile()
        ? { path: target, size: details.size, modifiedAtMs: details.mtimeMs }
        : null;
    } catch {
      return null;
    }
  };

  const respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD")
      return text(405, "Method not allowed", { allow: "GET, HEAD" });
    if (url.pathname === WEB_BASE)
      return new Response(null, {
        status: 308,
        headers: { location: `${WEB_BASE}/${url.search}`, "cache-control": "no-store" },
      });
    const path = relativePath(url.pathname);
    if (path === null) return text(404, "Not found");
    if (namesFile(path)) {
      const file = await locate(path);
      if (file === null) return text(404, "Not found");
      return serveFile({
        request,
        ...file,
        mimeType: contentTypes[extname(path).toLowerCase()] ?? "application/octet-stream",
        cacheControl: path.startsWith(HASHED_ASSETS)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        // Any HTML document gets the page's policy, however it was asked for.
        headers:
          extname(path).toLowerCase() === ".html"
            ? pageHeaders(request)
            : { "referrer-policy": "no-referrer" },
      });
    }
    const page = await locate(ENTRY);
    if (page === null)
      return text(503, 'The web app has not been built. Run "bun run build:web" and reload.');
    // The page is revalidated on every visit so that an upgraded server is picked up at once.
    return serveFile({
      request,
      ...page,
      mimeType: contentTypes[".html"] ?? "text/html",
      cacheControl: "no-cache",
      headers: pageHeaders(request),
    });
  };

  return async (request, context) => {
    const key = clientKey(request, context, config.trustedProxies);
    const nowMs = Date.now();
    if (nowMs - sweptAtMs >= 60_000) {
      sweptAtMs = nowMs;
      limiter.sweep(nowMs);
    }
    try {
      return await Effect.runPromise(
        limiter
          .check(key, nowMs)
          .pipe(
            Effect.flatMap(() =>
              limiter.run(
                key,
                Effect.tryPromise({ try: () => respond(request), catch: (cause) => cause }),
              ),
            ),
          ),
      );
    } catch (cause) {
      if (cause instanceof LimitExceeded)
        return text(429, "Too many requests", { "retry-after": String(cause.retryAfterSeconds) });
      log.error("web_request_failed", { path: new URL(request.url).pathname }, cause);
      return text(500, "Internal server error");
    }
  };
};
