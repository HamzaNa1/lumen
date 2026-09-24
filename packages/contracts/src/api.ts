import { Schema } from "effect";
import { UserRole, UtcMillis, Uuid } from "./schemas/common.ts";

export const ApiErrorCode = Schema.Literals([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
]);

export const ApiError = Schema.Struct({
  code: ApiErrorCode,
  message: Schema.String,
  requestId: Schema.String,
  detailsJson: Schema.NullOr(Schema.String),
});
export type ApiError = Schema.Schema.Type<typeof ApiError>;

export const LoginRequest = Schema.Struct({
  username: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
  deviceId: Uuid,
  deviceName: Schema.String.check(Schema.isMinLength(1)),
  platform: Schema.Literals(["web", "desktop", "ios", "android", "other"]),
  platformDeviceId: Schema.NullOr(Schema.String),
  nowMs: UtcMillis,
});
export type LoginRequest = Schema.Schema.Type<typeof LoginRequest>;

export const LoginResponse = Schema.Struct({
  userId: Uuid,
  role: UserRole,
  sessionId: Uuid,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  accessExpiresAtMs: UtcMillis,
  refreshExpiresAtMs: UtcMillis,
});
export type LoginResponse = Schema.Schema.Type<typeof LoginResponse>;

export const RegisterRequest = Schema.Struct({
  username: Schema.String.check(Schema.isMinLength(1)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(1024)),
  deviceId: Uuid,
  deviceName: Schema.String.check(Schema.isMinLength(1)),
  platform: Schema.Literals(["web", "desktop", "ios", "android", "other"]),
  platformDeviceId: Schema.NullOr(Schema.String),
  nowMs: UtcMillis,
});
export type RegisterRequest = Schema.Schema.Type<typeof RegisterRequest>;

export const RefreshRequest = Schema.Struct({
  refreshToken: Schema.String.check(Schema.isMinLength(1)),
  nowMs: UtcMillis,
});
export type RefreshRequest = Schema.Schema.Type<typeof RefreshRequest>;

export const RevokeSessionRequest = Schema.Struct({
  sessionId: Uuid,
  nowMs: UtcMillis,
});
export type RevokeSessionRequest = Schema.Schema.Type<typeof RevokeSessionRequest>;

export const CreateLibraryRequest = Schema.Struct({
  id: Uuid,
  name: Schema.String.check(Schema.isMinLength(1)),
  slug: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  rootPath: Schema.String.check(Schema.isMinLength(1)),
  rootId: Uuid,
});
export type CreateLibraryRequest = Schema.Schema.Type<typeof CreateLibraryRequest>;

export const StartScanRequest = Schema.Struct({
  libraryId: Uuid,
  mode: Schema.Literals(["full", "incremental", "refresh"]),
  nowMs: UtcMillis,
});
export type StartScanRequest = Schema.Schema.Type<typeof StartScanRequest>;

export const StartPlaybackRequest = Schema.Struct({
  deviceId: Uuid,
  trackId: Schema.NullOr(Uuid),
  nowMs: UtcMillis,
  expiresAtMs: UtcMillis,
});
export type StartPlaybackRequest = Schema.Schema.Type<typeof StartPlaybackRequest>;

export const PlaybackProgressRequest = Schema.Struct({
  trackId: Uuid,
  positionMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nowMs: UtcMillis,
});
export type PlaybackProgressRequest = Schema.Schema.Type<typeof PlaybackProgressRequest>;
