import {
  CreateLibrary,
  CreateLibraryRoot,
  GrantCapability,
  Library,
  LibraryGrant,
  LibraryRoot,
  UpsertLibraryGrant,
  UserRole,
  UtcMillis,
  Uuid,
} from "@lumen/contracts";
import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { DatabaseClient } from "../Database";
import { libraries, libraryGrants, libraryRoots } from "../tables/schema";
import { boundary, decodeJson, encodeJson, guard } from "./Boundary";

const librarySelection = {
  id: libraries.id,
  name: libraries.name,
  slug: libraries.slug,
  isEnabled: libraries.isEnabled,
  createdAtMs: libraries.createdAtMs,
  updatedAtMs: libraries.updatedAtMs,
};

const rootSelection = {
  id: libraryRoots.id,
  libraryId: libraryRoots.libraryId,
  path: libraryRoots.path,
  isEnabled: libraryRoots.isEnabled,
  priority: libraryRoots.priority,
  createdAtMs: libraryRoots.createdAtMs,
  updatedAtMs: libraryRoots.updatedAtMs,
};

const grantSelection = {
  id: libraryGrants.id,
  libraryId: libraryGrants.libraryId,
  userId: libraryGrants.userId,
  role: libraryGrants.role,
  capabilitiesJson: libraryGrants.capabilitiesJson,
  canDownload: libraryGrants.canDownload,
  expiresAtMs: libraryGrants.expiresAtMs,
  createdAtMs: libraryGrants.createdAtMs,
  updatedAtMs: libraryGrants.updatedAtMs,
};

const EntityId = Schema.Struct({ id: Uuid });
const LibraryId = Schema.Struct({ libraryId: Uuid });

const mapGrant = Effect.fn("LibraryRepository.mapGrant")(function* (row: unknown) {
  const value = yield* boundary(
    Schema.Struct({
      id: Uuid,
      libraryId: Uuid,
      userId: Uuid,
      role: UserRole,
      capabilitiesJson: Schema.String,
      canDownload: Schema.Boolean,
      expiresAtMs: Schema.NullOr(UtcMillis),
      createdAtMs: UtcMillis,
      updatedAtMs: UtcMillis,
    }),
    row,
    "library.mapGrant",
  );
  const capabilities = yield* decodeJson(
    Schema.Array(GrantCapability),
    value.capabilitiesJson,
    "library.mapGrant.capabilities",
  );
  return yield* boundary(LibraryGrant, { ...value, capabilities }, "library.mapGrant.result");
});

export const makeLibraryRepository = (database: DatabaseClient) => {
  const create = Effect.fn("LibraryRepository.create")(function* (input: unknown) {
    const value = yield* boundary(CreateLibrary, input, "library.create");
    const resultRows = yield* guard(
      database
        .insert(libraries)
        .values({
          id: value.id,
          name: value.name,
          slug: value.slug,
          createdAtMs: value.nowMs,
          updatedAtMs: value.nowMs,
        })
        .returning(librarySelection),
      "library.create",
    );
    const [row] = resultRows;
    return yield* boundary(Library, row, "library.create.result");
  });

  const get = Effect.fn("LibraryRepository.get")(function* (input: unknown) {
    const value = yield* boundary(EntityId, input, "library.get");
    const row = yield* guard(
      database.select(librarySelection).from(libraries).where(eq(libraries.id, value.id)).get(),
      "library.get",
    );
    return yield* boundary(Library, row, "library.get.result");
  });

  const list = Effect.fn("LibraryRepository.list")(function* () {
    const rows = yield* guard(
      database.select(librarySelection).from(libraries).orderBy(asc(libraries.name)),
      "library.list",
    );
    return yield* boundary(Schema.Array(Library), rows, "library.list.result");
  });

  const addRoot = Effect.fn("LibraryRepository.addRoot")(function* (input: unknown) {
    const value = yield* boundary(CreateLibraryRoot, input, "library.addRoot");
    const resultRows = yield* guard(
      database
        .insert(libraryRoots)
        .values({
          id: value.id,
          libraryId: value.libraryId,
          path: value.path,
          priority: value.priority,
          createdAtMs: value.nowMs,
          updatedAtMs: value.nowMs,
        })
        .returning(rootSelection),
      "library.addRoot",
    );
    const [row] = resultRows;
    return yield* boundary(LibraryRoot, row, "library.addRoot.result");
  });

  const listRoots = Effect.fn("LibraryRepository.listRoots")(function* (input: unknown) {
    const value = yield* boundary(LibraryId, input, "library.listRoots");
    const rows = yield* guard(
      database
        .select(rootSelection)
        .from(libraryRoots)
        .where(eq(libraryRoots.libraryId, value.libraryId))
        .orderBy(asc(libraryRoots.priority), asc(libraryRoots.path)),
      "library.listRoots",
    );
    return yield* boundary(Schema.Array(LibraryRoot), rows, "library.listRoots.result");
  });

  const upsertGrant = Effect.fn("LibraryRepository.upsertGrant")(function* (input: unknown) {
    const value = yield* boundary(UpsertLibraryGrant, input, "library.upsertGrant");
    const capabilitiesJson = yield* encodeJson(value.capabilities, "library.upsertGrant.encode");
    const resultRows = yield* guard(
      database
        .insert(libraryGrants)
        .values({
          id: value.id,
          libraryId: value.libraryId,
          userId: value.userId,
          role: value.role,
          capabilitiesJson,
          canDownload: value.canDownload,
          expiresAtMs: value.expiresAtMs,
          createdAtMs: value.nowMs,
          updatedAtMs: value.nowMs,
        })
        .onConflictDoUpdate({
          target: [libraryGrants.libraryId, libraryGrants.userId],
          set: {
            role: value.role,
            capabilitiesJson,
            canDownload: value.canDownload,
            expiresAtMs: value.expiresAtMs,
            updatedAtMs: value.nowMs,
          },
        })
        .returning(grantSelection),
      "library.upsertGrant",
    );
    const [row] = resultRows;
    return yield* mapGrant(row);
  });

  const listGrants = Effect.fn("LibraryRepository.listGrants")(function* (input: unknown) {
    const value = yield* boundary(LibraryId, input, "library.listGrants");
    const rows = yield* guard(
      database
        .select(grantSelection)
        .from(libraryGrants)
        .where(eq(libraryGrants.libraryId, value.libraryId)),
      "library.listGrants",
    );
    return yield* Effect.forEach(rows, mapGrant, { concurrency: 1 });
  });

  const deleteRoot = Effect.fn("LibraryRepository.deleteRoot")(function* (input: unknown) {
    const value = yield* boundary(EntityId, input, "library.deleteRoot");
    return yield* guard(
      database
        .delete(libraryRoots)
        .where(eq(libraryRoots.id, value.id))
        .returning({ id: libraryRoots.id }),
      "library.deleteRoot",
    );
  });

  return { create, get, list, addRoot, listRoots, upsertGrant, listGrants, deleteRoot };
};

export type LibraryRepository = ReturnType<typeof makeLibraryRepository>;
