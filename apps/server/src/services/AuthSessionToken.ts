import { createHash } from "node:crypto";

export const sessionExpiresInMs = 10 * 24 * 60 * 60 * 1000;
export const sessionVerificationIntervalMs = 60 * 60 * 1000;

// Adapted from Lucia's auth_session.ts. The existing database uses UUID session IDs.
export const createSessionToken = (): { id: string; token: string; secretHash: string } => {
  const id = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return { id, token: `${id}.${Buffer.from(secret).toString("base64url")}`, secretHash: hashSecret(secret) };
};

const hashSecret = (secret: Uint8Array): string =>
  createHash("sha256").update(secret).digest("hex");

export const verifySessionToken = (token: string, id: string, storedHash: string): boolean => {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] !== id || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1])) return false;
  const secret = Buffer.from(parts[1], "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== parts[1]) return false;
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index];
  return difference === 0;
};

export const sessionIdFromToken = (token: string): string | null => {
  if (token.length !== 80) return null;
  const parts = token.split(".");
  return parts.length === 2 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(parts[0]) ? parts[0] : null;
};
