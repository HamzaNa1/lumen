import { Schema } from "effect";
import { Uuid } from "./schemas/common.ts";

export const LAN_DISCOVERY_PORT = 32_101;
export const LAN_DISCOVERY_MULTICAST = "239.255.77.77";

export const ServerRouteScope = Schema.Literals(["local", "lan", "remote"]);
export type ServerRouteScope = Schema.Schema.Type<typeof ServerRouteScope>;

export const ServerRouteSource = Schema.Literals(["manual", "detected"]);
export type ServerRouteSource = Schema.Schema.Type<typeof ServerRouteSource>;

export const ServerRoute = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1)),
  source: ServerRouteSource,
  scope: ServerRouteScope,
});
export type ServerRoute = Schema.Schema.Type<typeof ServerRoute>;

export const ServerAdvertisedRoute = Schema.Struct({
  origin: Schema.String.check(Schema.isMinLength(1)),
  scope: ServerRouteScope,
});
export type ServerAdvertisedRoute = Schema.Schema.Type<typeof ServerAdvertisedRoute>;

export const ServerAdvertisedRoutes = Schema.Struct({
  routes: Schema.Array(ServerAdvertisedRoute),
});
export type ServerAdvertisedRoutes = Schema.Schema.Type<typeof ServerAdvertisedRoutes>;

export const ServerVerifyRequest = Schema.Struct({
  sessionId: Uuid,
  challenge: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128)),
});
export type ServerVerifyRequest = Schema.Schema.Type<typeof ServerVerifyRequest>;

export const ServerVerifyResponse = Schema.Struct({
  proof: Schema.String.check(Schema.isMinLength(1)),
});
export type ServerVerifyResponse = Schema.Schema.Type<typeof ServerVerifyResponse>;

export const LanDiscoveryRequest = Schema.Struct({
  type: Schema.Literal("lumen.discover"),
  version: Schema.Literal(1),
});
export type LanDiscoveryRequest = Schema.Schema.Type<typeof LanDiscoveryRequest>;

export const LanDiscoveryResponse = Schema.Struct({
  type: Schema.Literal("lumen.server"),
  version: Schema.Literal(1),
  serverId: Schema.String.check(Schema.isMinLength(1)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
});
export type LanDiscoveryResponse = Schema.Schema.Type<typeof LanDiscoveryResponse>;

export const LanServerCandidate = Schema.Struct({
  serverId: Schema.String.check(Schema.isMinLength(1)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  origin: Schema.String.check(Schema.isMinLength(1)),
});
export type LanServerCandidate = Schema.Schema.Type<typeof LanServerCandidate>;

export const normalizeOrigin = (value: string): string => {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported server URL");
  if (url.username !== "" || url.password !== "")
    throw new Error("URL credentials are not allowed");
  if (url.pathname !== "/" && url.pathname !== "")
    throw new Error("Server origin cannot contain a path");
  if (url.search !== "" || url.hash !== "")
    throw new Error("Server origin cannot contain a query or fragment");
  return url.origin;
};

const classifyIpv4Octets = (a: number, b: number): ServerRouteScope => {
  if (a === 127) return "local";
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
    return "lan";
  return "remote";
};

const parseIpv4 = (host: string): readonly [number, number, number, number] | null => {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  return a === undefined || b === undefined || c === undefined || d === undefined
    ? null
    : [a, b, c, d];
};

const classifyIpv6 = (host: string): ServerRouteScope => {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return "local";
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(normalized);
  if (mappedDotted?.[1] !== undefined) {
    const octets = parseIpv4(mappedDotted[1]);
    return octets === null ? "remote" : classifyIpv4Octets(octets[0], octets[1]);
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
  if (mappedHex?.[1] !== undefined && mappedHex[2] !== undefined) {
    const high = Number.parseInt(mappedHex[1], 16);
    return classifyIpv4Octets((high >> 8) & 0xff, high & 0xff);
  }
  const firstGroup = /^([0-9a-f]{1,4}):/u.exec(normalized)?.[1];
  if (firstGroup === undefined) return "remote";
  const value = Number.parseInt(firstGroup, 16);
  // Unique local (fc00::/7) and link-local (fe80::/10).
  return (value & 0xfe00) === 0xfc00 || (value & 0xffc0) === 0xfe80 ? "lan" : "remote";
};

const LAN_SUFFIXES = [".local", ".home.arpa", ".lan", ".home", ".localdomain", ".internal"];

export const classifyRouteScope = (origin: string): ServerRouteScope => {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return "remote";
  }
  if (host.startsWith("[") && host.endsWith("]")) return classifyIpv6(host.slice(1, -1));
  if (host.includes(":")) return classifyIpv6(host);
  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return classifyIpv4Octets(ipv4[0], ipv4[1]);
  const trimmed = host.endsWith(".") ? host.slice(0, -1) : host;
  if (trimmed === "localhost" || trimmed.endsWith(".localhost")) return "local";
  if (!trimmed.includes(".")) return "lan";
  return LAN_SUFFIXES.some((suffix) => trimmed.endsWith(suffix)) ? "lan" : "remote";
};

export const makeServerRoute = (origin: string, source: ServerRouteSource): ServerRoute => {
  const normalized = normalizeOrigin(origin);
  return { origin: normalized, source, scope: classifyRouteScope(normalized) };
};

const scopeRank = (scope: ServerRouteScope): number =>
  scope === "local" ? 0 : scope === "lan" ? 1 : 2;

const routeTier = (route: ServerRoute): number =>
  scopeRank(route.scope) * 2 + (route.source === "manual" ? 0 : 1);

/** Orders routes by priority: local before LAN before remote, manual before auto-detected, active first within a tier. */
export const sortServerRoutes = (
  routes: ReadonlyArray<ServerRoute>,
  activeOrigin?: string | null,
): ServerRoute[] => {
  const indexed = routes.map((route, index) => ({ route, index }));
  indexed.sort((a, b) => {
    const tierDiff = routeTier(a.route) - routeTier(b.route);
    if (tierDiff !== 0) return tierDiff;
    if (activeOrigin != null) {
      const aActive = a.route.origin === activeOrigin ? 0 : 1;
      const bActive = b.route.origin === activeOrigin ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
    }
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.route);
};

export const mergeServerRoutes = (options: {
  readonly existing?: ReadonlyArray<ServerRoute>;
  readonly manualOrigins?: ReadonlyArray<string>;
  readonly detectedOrigins?: ReadonlyArray<string>;
  readonly dismissedOrigins?: ReadonlyArray<string>;
  /** When true, existing auto-detected routes not in `detectedOrigins` are pruned. */
  readonly replaceDetected?: boolean;
}): ServerRoute[] => {
  const dismissed = new Set<string>();
  for (const origin of options.dismissedOrigins ?? []) {
    try {
      dismissed.add(normalizeOrigin(origin));
    } catch {}
  }
  const byOrigin = new Map<string, ServerRoute>();
  for (const route of options.existing ?? []) {
    try {
      const normalized = normalizeOrigin(route.origin);
      if (route.source === "detected" && (options.replaceDetected || dismissed.has(normalized)))
        continue;
      const current = byOrigin.get(normalized);
      if (current === undefined || (current.source === "detected" && route.source === "manual"))
        byOrigin.set(normalized, makeServerRoute(normalized, route.source));
    } catch {}
  }
  for (const origin of options.manualOrigins ?? []) {
    try {
      const normalized = normalizeOrigin(origin);
      byOrigin.set(normalized, makeServerRoute(normalized, "manual"));
    } catch {}
  }
  for (const origin of options.detectedOrigins ?? []) {
    try {
      const normalized = normalizeOrigin(origin);
      if (dismissed.has(normalized) || byOrigin.has(normalized)) continue;
      byOrigin.set(normalized, makeServerRoute(normalized, "detected"));
    } catch {}
  }
  return sortServerRoutes([...byOrigin.values()]);
};
