import { createSocket, type Socket } from "node:dgram";
import {
  LAN_DISCOVERY_MULTICAST,
  LAN_DISCOVERY_PORT,
  LanDiscoveryRequest,
  type LanDiscoveryResponse,
} from "@lumen/contracts";
import { Schema } from "effect";
import type { Logger } from "../core/Logger";
import { isLoopbackHost } from "./LanRoutes";

const MAX_PACKET_BYTES = 512;
const PEER_WINDOW_MS = 1_000;
const PEER_MAX_REPLIES = 5;
const MAX_TRACKED_PEERS = 256;

export interface LanDiscoveryOptions {
  readonly serverId: string;
  readonly displayName: () => Promise<string>;
  readonly httpPort: number;
  readonly host: string;
  readonly enabled: boolean;
  /** Overrides the UDP port (0 picks an ephemeral port for isolated tests). */
  readonly port?: number | undefined;
  readonly logger: Logger;
}

export interface RunningLanDiscovery {
  readonly port: number | null;
  readonly stop: () => Promise<void>;
}

const noopDiscovery: RunningLanDiscovery = { port: null, stop: async () => undefined };

const isDiscoveryRequest = (buffer: Buffer): boolean => {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_PACKET_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    Schema.decodeUnknownSync(LanDiscoveryRequest)(parsed);
    return true;
  } catch {
    return false;
  }
};

/**
 * Answers local-network UDP discovery probes so desktop clients on the same LAN find this server
 * without manual address entry. Failures never prevent the HTTP server from running.
 */
export const startLanDiscovery = async (
  options: LanDiscoveryOptions,
): Promise<RunningLanDiscovery> => {
  const loopback = isLoopbackHost(options.host);
  // Loopback-only servers cannot be reached from the LAN, so they stay quiet unless a test binds a port.
  if (!options.enabled || (loopback && options.port === undefined)) return noopDiscovery;

  const bindPort = options.port ?? LAN_DISCOVERY_PORT;
  const bindAddress = loopback ? "127.0.0.1" : undefined;
  let socket: Socket | null = null;
  try {
    socket = createSocket({ type: "udp4", reuseAddr: true });
  } catch (cause) {
    options.logger.warn("lan_discovery_unavailable", { reason: "socket_create_failed" }, cause);
    return noopDiscovery;
  }

  const peers = new Map<string, { count: number; resetAtMs: number }>();
  const allowPeer = (address: string, nowMs: number): boolean => {
    const entry = peers.get(address);
    if (entry === undefined || nowMs >= entry.resetAtMs) {
      if (peers.size >= MAX_TRACKED_PEERS) peers.clear();
      peers.set(address, { count: 1, resetAtMs: nowMs + PEER_WINDOW_MS });
      return true;
    }
    if (entry.count >= PEER_MAX_REPLIES) return false;
    entry.count += 1;
    return true;
  };

  socket.on("message", (buffer, rinfo) => {
    if (!isDiscoveryRequest(buffer)) return;
    if (!allowPeer(rinfo.address, Date.now())) return;
    void options
      .displayName()
      .then((displayName) => {
        if (socket === null) return;
        const reply: LanDiscoveryResponse = {
          type: "lumen.server",
          version: 1,
          serverId: options.serverId,
          displayName,
          port: options.httpPort,
        };
        const payload = Buffer.from(JSON.stringify(reply), "utf8");
        socket.send(payload, rinfo.port, rinfo.address, () => undefined);
      })
      .catch(() => undefined);
  });

  const activeSocket = socket;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error) => {
        activeSocket.off("listening", onListening);
        reject(cause);
      };
      const onListening = () => {
        activeSocket.off("error", onError);
        resolve();
      };
      activeSocket.once("error", onError);
      activeSocket.once("listening", onListening);
      if (bindAddress === undefined) activeSocket.bind(bindPort);
      else activeSocket.bind(bindPort, bindAddress);
    });
  } catch (cause) {
    options.logger.warn("lan_discovery_unavailable", { port: bindPort }, cause);
    try {
      activeSocket.close();
    } catch {}
    return noopDiscovery;
  }

  activeSocket.on("error", (cause) => {
    options.logger.warn("lan_discovery_error", {}, cause);
  });

  if (!loopback) {
    try {
      activeSocket.addMembership(LAN_DISCOVERY_MULTICAST);
    } catch {
      // Broadcast replies still work when multicast membership is unavailable.
    }
  }

  const boundPort = activeSocket.address().port;
  let closed = false;
  return {
    port: boundPort,
    stop: async () => {
      if (closed) return;
      closed = true;
      socket = null;
      await new Promise<void>((resolve) => {
        try {
          activeSocket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
};
