import { Schema } from "effect";

export const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export const UtcMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const DurationMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const NonEmptyText = Schema.String.check(Schema.isMinLength(1));
export const Sha256Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const MIN_PASSWORD_LENGTH = 6;
/** A password someone is choosing, as opposed to one being checked at sign-in. */
export const NewPassword = Schema.String.check(
  Schema.isMinLength(MIN_PASSWORD_LENGTH),
  Schema.isMaxLength(1024),
);
export const UserRole = Schema.Literals(["admin", "user"]);
export const GrantCapability = Schema.Literals([
  "library:read",
  "playback:control",
  "favorites:write",
]);
/**
 * Which libraries a user who is not an administrator can use: every library, including ones added
 * later, or only the listed ones. Administrators always have every library.
 */
export const LibraryAccess = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("all") }),
  Schema.Struct({ scope: Schema.Literal("selected"), libraryIds: Schema.Array(Uuid) }),
]);
export type LibraryAccess = Schema.Schema.Type<typeof LibraryAccess>;
export type UserRole = Schema.Schema.Type<typeof UserRole>;
export type GrantCapability = Schema.Schema.Type<typeof GrantCapability>;
