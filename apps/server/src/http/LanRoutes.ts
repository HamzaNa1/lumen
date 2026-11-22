import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { classifyRouteScope, normalizeOrigin, type ServerAdvertisedRoute } from "@lumen/contracts";

const WILDCARD_IPV4_HOSTS = new Set(["0.0.0.0"]);
const WILDCARD_ANY_HOSTS = new Set(["", "::", "[::]"]);

export const isLoopbackHost = (host: string): boolean => {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(normalized)
  );
};

const privateIpv4Rank = (address: string): number | null => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return null;
  const [a, b] = parts;
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  // Docker default bridges often live in 172.16.0.0/12, so rank typical home LAN ranges first.
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 2;
  return null;
};

const isUlaIpv6 = (address: string): boolean => {
  const first = /^([0-9a-f]{1,4}):/iu.exec(address)?.[1];
  if (first === undefined) return false;
  return (Number.parseInt(first, 16) & 0xfe00) === 0xfc00;
};

const formatOrigin = (host: string, port: number, protocol: "http" | "https"): string => {
  const stripped = host.replace(/^\[|\]$/gu, "").split("%")[0] ?? host;
  const authority = stripped.includes(":") ? `[${stripped}]` : stripped;
  return normalizeOrigin(`${protocol}://${authority}:${port}`);
};

export interface DetectLanRoutesOptions {
  readonly host: string;
  readonly port: number;
  readonly interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly extraOrigins?: ReadonlyArray<string>;
  readonly protocol?: "http" | "https";
}

/** Local (loopback) and LAN origins by which clients can reach this server directly. */
export const detectLanRoutes = (
  options: DetectLanRoutesOptions,
): ReadonlyArray<ServerAdvertisedRoute> => {
  const seen = new Set<string>();
  const routes: ServerAdvertisedRoute[] = [];
  const protocol = options.protocol ?? "http";
  const push = (origin: string): void => {
    try {
      const normalized = normalizeOrigin(origin);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      routes.push({ origin: normalized, scope: classifyRouteScope(normalized) });
    } catch {}
  };

  for (const extra of options.extraOrigins ?? []) push(extra);

  const host = options.host.trim();
  const isWildcardIpv4 = WILDCARD_IPV4_HOSTS.has(host);
  const isWildcardAny = WILDCARD_ANY_HOSTS.has(host);

  if (isWildcardIpv4 || isWildcardAny) {
    // Clients on the same machine can always reach a wildcard-bound server over loopback.
    push(formatOrigin("127.0.0.1", options.port, protocol));
    if (isWildcardAny) push(formatOrigin("::1", options.port, protocol));

    const candidates: Array<{ readonly origin: string; readonly rank: number }> = [];
    const table = options.interfaces ?? networkInterfaces();
    for (const entries of Object.values(table)) {
      for (const info of entries ?? []) {
        if (info.internal) continue;
        if (info.family === "IPv4") {
          const rank = privateIpv4Rank(info.address);
          if (rank !== null)
            candidates.push({ origin: formatOrigin(info.address, options.port, protocol), rank });
        } else if (isWildcardAny && info.family === "IPv6" && isUlaIpv6(info.address)) {
          candidates.push({ origin: formatOrigin(info.address, options.port, protocol), rank: 3 });
        }
      }
    }
    candidates.sort((a, b) => a.rank - b.rank || a.origin.localeCompare(b.origin));
    for (const candidate of candidates) push(candidate.origin);
  } else if (isLoopbackHost(host)) {
    const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
    push(
      formatOrigin(normalized === "localhost" ? "127.0.0.1" : normalized, options.port, protocol),
    );
  } else {
    const origin = formatOrigin(host, options.port, protocol);
    if (classifyRouteScope(origin) !== "remote") push(origin);
  }

  return routes;
};
