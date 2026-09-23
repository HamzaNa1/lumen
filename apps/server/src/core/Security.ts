import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Effect } from "effect";
import { internal } from "./Errors";

export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const newOpaqueToken = (): string => randomBytes(32).toString("base64url");
export const newUuid = (): string => {
  const hex = randomBytes(16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  });

export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  Bun.password.verify(password, hash);

export const equalDigest = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const secureToken = (bytes: number): string => randomBytes(bytes).toString("base64url");

export const protect = <A>(effect: Effect.Effect<A, Error>): Effect.Effect<A, Error> =>
  Effect.catchCause(effect, (cause) => Effect.fail(internal("Security operation failed", cause)));
