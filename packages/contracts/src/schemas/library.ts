import { Schema } from "effect";
import { GrantCapability, NonEmptyText, UserRole, UtcMillis, Uuid } from "./common.ts";

export const LibraryScanMode = Schema.Literals(["full", "incremental", "refresh"]);

export const Library = Schema.Struct({
  id: Uuid,
  name: NonEmptyText,
  slug: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  isEnabled: Schema.Boolean,
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type Library = Schema.Schema.Type<typeof Library>;

export const LibraryRoot = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  path: NonEmptyText,
  isEnabled: Schema.Boolean,
  priority: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type LibraryRoot = Schema.Schema.Type<typeof LibraryRoot>;

export const LibraryGrant = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  userId: Uuid,
  role: UserRole,
  capabilities: Schema.Array(GrantCapability),
  canDownload: Schema.Boolean,
  expiresAtMs: Schema.NullOr(UtcMillis),
  createdAtMs: UtcMillis,
  updatedAtMs: UtcMillis,
});
export type LibraryGrant = Schema.Schema.Type<typeof LibraryGrant>;

export const CreateLibrary = Schema.Struct({
  id: Uuid,
  name: NonEmptyText,
  slug: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
  nowMs: UtcMillis,
});
export type CreateLibrary = Schema.Schema.Type<typeof CreateLibrary>;

export const CreateLibraryRoot = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  path: NonEmptyText,
  priority: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nowMs: UtcMillis,
});
export type CreateLibraryRoot = Schema.Schema.Type<typeof CreateLibraryRoot>;

export const UpsertLibraryGrant = Schema.Struct({
  id: Uuid,
  libraryId: Uuid,
  userId: Uuid,
  role: UserRole,
  capabilities: Schema.Array(GrantCapability),
  canDownload: Schema.Boolean,
  expiresAtMs: Schema.NullOr(UtcMillis),
  nowMs: UtcMillis,
});
export type UpsertLibraryGrant = Schema.Schema.Type<typeof UpsertLibraryGrant>;

export const StartScan = Schema.Struct({
  runId: Uuid,
  libraryId: Uuid,
  mode: LibraryScanMode,
  startedAtMs: UtcMillis,
});
export type StartScan = Schema.Schema.Type<typeof StartScan>;
