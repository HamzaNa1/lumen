import { createHash } from "node:crypto";
import { badRequest } from "../core/Errors";

const UUID = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/iu;

/** Jellyfin writes GUIDs without dashes; Lumen stores them with. */
export const toJellyfinId = (id: string): string => id.replaceAll("-", "").toLowerCase();

export const fromJellyfinId = (id: string | null | undefined): string | null => {
  const match = UUID.exec(id ?? "");
  return match === null ? null : match.slice(1).join("-").toLowerCase();
};

export const requireId = (id: string | null | undefined, name = "Id"): string => {
  const parsed = fromJellyfinId(id);
  if (parsed === null) throw badRequest(`${name} is not a valid ID`);
  return parsed;
};

const TICKS_PER_SECOND = 10_000_000;
export const ticksFromSeconds = (seconds: number): number => Math.round(seconds * TICKS_PER_SECOND);
export const millisFromTicks = (ticks: number): number => Math.max(0, Math.floor(ticks / 10_000));

/** A name-based UUID (RFC 9562, version 5). */
export const uuidV5 = (namespace: string, name: string): string => {
  const bytes = createHash("sha1")
    .update(Buffer.from(toJellyfinId(namespace), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return fromJellyfinId(bytes.toString("hex")) ?? "";
};
