import { isIP } from "node:net";

export interface RequestContext {
  readonly peerAddress: string | null;
  /** Supplied by the HTTP transport; called only for an admitted media GET response. */
  readonly disableIdleTimeout?: () => void;
}

export const normalizeAddress = (address: string): string | null => {
  const value = address.trim().toLowerCase();
  if (value.startsWith("::ffff:") && isIP(value.slice(7)) === 4) return value.slice(7);
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) {
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
};

/** Forwarded addresses are consumed from the socket's trusted side, never from the client side. */
export const clientKey = (
  request: Request,
  context: RequestContext = { peerAddress: null },
  trustedProxies: ReadonlyArray<string> = [],
): string => {
  const peer = context.peerAddress === null ? null : normalizeAddress(context.peerAddress);
  if (peer === null) return "peer:unknown";
  const trusted = new Set(trustedProxies.map(normalizeAddress).filter((value) => value !== null));
  if (!trusted.has(peer)) return `peer:${peer}`;
  const header = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  if (header === null || header.length > 4096) return `peer:${peer}`;
  const chain = header.split(",");
  if (chain.length > 32) return `peer:${peer}`;
  let address = peer;
  for (let index = chain.length - 1; index >= 0 && trusted.has(address); index -= 1) {
    const next = normalizeAddress(chain[index] ?? "");
    if (next === null) return `peer:${peer}`;
    address = next;
  }
  return `peer:${address}`;
};
