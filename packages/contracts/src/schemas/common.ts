import { Schema } from "effect";

export const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export const UtcMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const DurationMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
export const Sha256Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const UserRole = Schema.Literals(["admin", "user", "guest"]);
export const GrantCapability = Schema.Literals([
  "library:read",
  "playback:control",
  "favorites:write",
]);
export type UserRole = Schema.Schema.Type<typeof UserRole>;
export type GrantCapability = Schema.Schema.Type<typeof GrantCapability>;
