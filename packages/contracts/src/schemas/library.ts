import { Schema } from "effect";
import { GrantCapability, NonEmptyText, UtcMillis, Uuid } from "./common.ts";

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
  capabilities: Schema.Array(GrantCapability),
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
  capabilities: Schema.Array(GrantCapability),
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

/** One folder on the server, for choosing a library root. Unreadable and hidden folders are left out. */
export const DirectoryListing = Schema.Struct({
  path: Schema.String,
  /** The home folder of the account the server runs as, where browsing starts. */
  home: Schema.String,
  /** Null at the top of the filesystem or when the server cannot read the folder above. */
  parent: Schema.NullOr(Schema.String),
  /** From the top of the filesystem down to this folder. */
  trail: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
  directories: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
  /** Media files only, with "video" or "audio" as kind. */
  files: Schema.Array(
    Schema.Struct({ name: Schema.String, size: Schema.Number, kind: Schema.String }),
  ),
  /** True when the folder held more entries than the server lists. */
  truncated: Schema.Boolean,
  /** A library root this folder is, contains, or sits inside, which a new root may not overlap. */
  overlaps: Schema.NullOr(
    Schema.Struct({ rootId: Schema.String, libraryId: Schema.String, libraryName: Schema.String }),
  ),
});
export type DirectoryListing = Schema.Schema.Type<typeof DirectoryListing>;
