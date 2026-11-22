import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import {
  LAN_DISCOVERY_MULTICAST,
  LAN_DISCOVERY_PORT,
  type LanDiscoveryRequest,
  LanDiscoveryResponse,
  type LanServerCandidate,
  normalizeOrigin,
} from "@lumen/contracts";
import { Schema } from "effect";

const REQUEST_PAYLOAD = Buffer.from(
  JSON.stringify({ type: "lumen.discover", version: 1 } satisfies LanDiscoveryRequest),
  "utf8",
);

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".").map(Number);
  const [a, b, c, d] = parts;
  if (
    parts.length !== 4 ||
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return null;
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
};

const intToIpv4 = (value: number): string =>
  `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;

const broadcastTargets = (): string[] => {
  const targets = new Set<string>([LAN_DISCOVERY_MULTICAST, "255.255.255.255"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const info of entries ?? []) {
      if (info.internal || info.family !== "IPv4") continue;
      const address = ipv4ToInt(info.address);
      const mask = ipv4ToInt(info.netmask);
      if (address === null || mask === null) continue;
      targets.add(intToIpv4((address | (~mask >>> 0)) >>> 0));
    }
  }
  return [...targets];
};

const originFromReply = (address: string, port: number): string | null => {
  try {
    const clean = address.replace(/^::ffff:/iu, "");
    const authority = clean.includes(":") ? `[${clean}]` : clean;
    return normalizeOrigin(`http://${authority}:${port}`);
  } catch {
    return null;
  }
};

export interface DiscoverLanOptions {
  readonly port?: number | null;
  readonly targets?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Resolves the UDP discovery port from the environment, allowing tests to isolate discovery onto
 * loopback (`LUMEN_E2E_DISCOVERY_PORT=<port>`) or disable it (`off`) so tests never probe the host LAN.
 */
export const configuredDiscoveryConfig = (): {
  readonly enabled: boolean;
  readonly port: number;
  readonly targets?: ReadonlyArray<string>;
} => {
  const raw = process.env.LUMEN_E2E_DISCOVERY_PORT?.trim();
  if (raw === undefined || raw === "") return { enabled: true, port: LAN_DISCOVERY_PORT };
  if (raw.toLowerCase() === "off" || raw === "0") return { enabled: false, port: 0 };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535)
    return { enabled: false, port: 0 };
  return { enabled: true, port: parsed, targets: ["127.0.0.1"] };
};

/** Probes the local network over UDP and returns raw server replies before HTTP verification. */
export const discoverLanServers = async (
  options: DiscoverLanOptions = {},
): Promise<ReadonlyArray<LanServerCandidate>> => {
  const defaults = configuredDiscoveryConfig();
  if (options.port === null || (options.port === undefined && !defaults.enabled)) return [];
  const port = options.port ?? defaults.port;
  const targets = options.targets ?? defaults.targets ?? broadcastTargets();
  const timeoutMs = options.timeoutMs ?? 450;

  let socket: ReturnType<typeof createSocket>;
  try {
    socket = createSocket({ type: "udp4", reuseAddr: true });
  } catch {
    return [];
  }

  const found = new Map<string, LanServerCandidate>();

  return new Promise<ReadonlyArray<LanServerCandidate>>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", finish);
      try {
        socket.close();
      } catch {}
      resolve([...found.values()]);
    };

    if (options.signal?.aborted) {
      finish();
      return;
    }
    options.signal?.addEventListener("abort", finish, { once: true });
    socket.on("error", finish);

    socket.on("message", (buffer, rinfo) => {
      if (buffer.byteLength === 0 || buffer.byteLength > 512) return;
      try {
        const reply = Schema.decodeUnknownSync(LanDiscoveryResponse)(
          JSON.parse(buffer.toString("utf8")),
        );
        const origin = originFromReply(rinfo.address, reply.port);
        if (origin === null) return;
        found.set(origin, {
          serverId: reply.serverId,
          displayName: reply.displayName,
          origin,
        });
      } catch {}
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {}
      for (const target of targets) {
        socket.send(REQUEST_PAYLOAD, port, target, () => undefined);
      }
      timer = setTimeout(finish, timeoutMs);
    });
  });
};
