import { Schema } from "effect";
import { NonEmptyText, Sha256Digest, UserRole, UtcMillis, Uuid } from "./common.ts";

export const DevicePlatform = Schema.Literals(["web", "desktop", "ios", "android", "other"]);

export const User = Schema.Struct({
  id: Uuid,
  username: NonEmptyText,
  displayName: NonEmptyText,
  role: UserRole,
  isActive: Schema.Boolean,
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type User = Schema.Schema.Type<typeof User>;

export const Device = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  name: NonEmptyText,
  platform: DevicePlatform,
  platformDeviceId: Schema.NullOr(NonEmptyText),
  lastSeenAtMs: UtcMillis,
  createdAtMs: UtcMillis,
  revokedAtMs: Schema.NullOr(UtcMillis),
});
export type Device = Schema.Schema.Type<typeof Device>;

export const AuthSession = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  deviceId: Uuid,
  sessionTokenHash: Sha256Digest,
  issuedAtMs: UtcMillis,
  lastUsedAtMs: UtcMillis,
  expiresAtMs: UtcMillis,
  revokedAtMs: Schema.NullOr(UtcMillis),
});
export type AuthSession = Schema.Schema.Type<typeof AuthSession>;

export const CreateUser = Schema.Struct({
  id: Uuid,
  username: NonEmptyText,
  usernameNormalized: Schema.String.check(Schema.isPattern(/^[a-z0-9._-]+$/)),
  displayName: NonEmptyText,
  passwordHash: Schema.String.check(Schema.isMinLength(1)),
  role: Schema.optional(UserRole),
  nowMs: UtcMillis,
});
export type CreateUser = Schema.Schema.Type<typeof CreateUser>;

export const CreateDevice = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  name: NonEmptyText,
  platform: DevicePlatform,
  platformDeviceId: Schema.optional(Schema.NullOr(NonEmptyText)),
  nowMs: UtcMillis,
});
export type CreateDevice = Schema.Schema.Type<typeof CreateDevice>;

export const CreateAuthSession = Schema.Struct({
  id: Uuid,
  userId: Uuid,
  deviceId: Uuid,
  sessionTokenHash: Sha256Digest,
  issuedAtMs: UtcMillis,
  expiresAtMs: UtcMillis,
});
export type CreateAuthSession = Schema.Schema.Type<typeof CreateAuthSession>;

export const UserCredentials = Schema.Struct({
  user: User,
  passwordHash: Schema.String.check(Schema.isMinLength(1)),
});
export type UserCredentials = Schema.Schema.Type<typeof UserCredentials>;

export const RevokeSession = Schema.Struct({
  sessionId: Uuid,
  nowMs: UtcMillis,
});
export type RevokeSession = Schema.Schema.Type<typeof RevokeSession>;
