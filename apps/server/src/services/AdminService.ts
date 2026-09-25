import {
  authSessions,
  Database,
  devices,
  libraries,
  libraryProfiles,
  Repositories,
  users,
} from "@lumen/database";
import { and, asc, count, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { badRequest, conflict, notFound } from "../core/Errors";
import { hashPassword, newUuid } from "../core/Security";
import { mapRepositoryError } from "../core/Cause";
import { AccessControl } from "./AccessControl";
import type { AuthPrincipal } from "./AuthService";
import type { CreateUserBody, UpdateUserBody } from "../http/Schemas";
import type { Schema } from "effect";

type CreateUserInput = Schema.Schema.Type<typeof CreateUserBody>;
type UpdateUserInput = Schema.Schema.Type<typeof UpdateUserBody>;

export interface AdminServiceShape {
  readonly listUsers: (principal: AuthPrincipal) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly createUser: (
    principal: AuthPrincipal,
    input: CreateUserInput,
    nowMs: number,
  ) => Effect.Effect<unknown, unknown>;
  readonly updateUser: (
    principal: AuthPrincipal,
    userId: string,
    input: UpdateUserInput,
    nowMs: number,
  ) => Effect.Effect<unknown, unknown>;
  readonly listDevices: (
    principal: AuthPrincipal,
    userId: string,
  ) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly revokeDevice: (
    principal: AuthPrincipal,
    deviceId: string,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly listSessions: (
    principal: AuthPrincipal,
    userId: string,
    nowMs: number,
  ) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly revokeSession: (
    principal: AuthPrincipal,
    sessionId: string,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly listLibraries: (
    principal: AuthPrincipal,
    nowMs: number,
  ) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly listAllLibraries: (
    principal: AuthPrincipal,
  ) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
}

export const makeAdminService = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const access = yield* AccessControl;
  const userSelection = {
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    role: users.role,
    isActive: users.isActive,
    createdAtMs: users.createdAtMs,
    updatedAtMs: users.updatedAtMs,
  };
  const librarySelection = {
    id: libraries.id,
    name: libraries.name,
    slug: libraries.slug,
    kind: sql<"movies" | "shows" | "music">`coalesce(${libraryProfiles.kind}, 'movies')`,
    isEnabled: libraries.isEnabled,
    createdAtMs: libraries.createdAtMs,
    updatedAtMs: libraries.updatedAtMs,
  };
  const listUsers: AdminServiceShape["listUsers"] = Effect.fn("Admin.listUsers")(
    function* (principal) {
      yield* access.requireAdmin(principal);
      return yield* database.select(userSelection).from(users).orderBy(asc(users.username));
    },
  );
  const createUser: AdminServiceShape["createUser"] = Effect.fn("Admin.createUser")(
    function* (principal, input, nowMs) {
      yield* access.requireAdmin(principal);
      const normalized = input.username.trim().toLowerCase();
      if (!/^[a-z0-9._-]+$/u.test(normalized))
        return yield* badRequest("Username contains unsupported characters");
      const passwordHash = yield* Effect.promise(() => hashPassword(input.password));
      const [row] = yield* database
        .insert(users)
        .values({
          id: newUuid(),
          username: input.username.trim(),
          usernameNormalized: normalized,
          displayName: input.displayName.trim(),
          passwordHash,
          role: input.role ?? "user",
          isActive: true,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .returning(userSelection);
      return row;
    },
  );
  const updateUser: AdminServiceShape["updateUser"] = Effect.fn("Admin.updateUser")(
    function* (principal, userId, input, nowMs) {
      yield* access.requireAdmin(principal);
      const password = input.password;
      const passwordHash =
        password === undefined ? null : yield* Effect.promise(() => hashPassword(password));
      const row = yield* database.transaction((transaction) =>
        Effect.gen(function* () {
          if (input.role !== undefined || input.isActive === false) {
            const current = yield* transaction
              .select({ role: users.role, isActive: users.isActive })
              .from(users)
              .where(eq(users.id, userId))
              .get();
            if (current == null) return yield* notFound("User not found");
            if (
              current.role === "admin" &&
              current.isActive &&
              ((input.role !== undefined && input.role !== "admin") || input.isActive === false)
            ) {
              const administrators = yield* transaction
                .select({ count: count() })
                .from(users)
                .where(and(eq(users.role, "admin"), eq(users.isActive, true)))
                .get();
              if ((administrators?.count ?? 0) <= 1)
                return yield* conflict("The last active administrator cannot be removed");
            }
          }
          const [updated] = yield* transaction
            .update(users)
            .set({
              displayName: input.displayName?.trim(),
              passwordHash: passwordHash ?? undefined,
              role: input.role,
              isActive: input.isActive,
              updatedAtMs: nowMs,
            })
            .where(eq(users.id, userId))
            .returning(userSelection);
          if (updated == null) return yield* notFound("User not found");
          if (input.password !== undefined) {
            yield* transaction
              .update(authSessions)
              .set({
                revokedAtMs: sql`coalesce(${authSessions.revokedAtMs}, ${nowMs})`,
              })
              .where(
                and(eq(authSessions.userId, userId), ne(authSessions.id, principal.sessionId)),
              );
          }
          return updated;
        }),
      );
      return row;
    },
  );
  const listDevices: AdminServiceShape["listDevices"] = Effect.fn("Admin.listDevices")(
    function* (principal, userId) {
      yield* access.requireAdmin(principal);
      return yield* database
        .select()
        .from(devices)
        .where(eq(devices.userId, userId))
        .orderBy(desc(devices.createdAtMs));
    },
  );
  const revokeDevice: AdminServiceShape["revokeDevice"] = Effect.fn("Admin.revokeDevice")(
    function* (principal, deviceId, nowMs) {
      yield* access.requireAdmin(principal);
      yield* database
        .update(devices)
        .set({
          revokedAtMs: sql`coalesce(${devices.revokedAtMs}, ${nowMs})`,
        })
        .where(eq(devices.id, deviceId));
      yield* database
        .update(authSessions)
        .set({
          revokedAtMs: sql`coalesce(${authSessions.revokedAtMs}, ${nowMs})`,
        })
        .where(eq(authSessions.deviceId, deviceId));
    },
  );
  const listSessions: AdminServiceShape["listSessions"] = Effect.fn("Admin.listSessions")(
    function* (principal, userId, nowMs) {
      yield* access.requireAdmin(principal);
      return yield* database
        .select({
          id: authSessions.id,
          userId: authSessions.userId,
          deviceId: authSessions.deviceId,
          issuedAtMs: authSessions.issuedAtMs,
          lastSeenAtMs: authSessions.lastUsedAtMs,
          expiresAtMs: authSessions.expiresAtMs,
          revokedAtMs: authSessions.revokedAtMs,
        })
        .from(authSessions)
        .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAtMs, nowMs)))
        .orderBy(desc(authSessions.issuedAtMs));
    },
  );
  const revokeSession: AdminServiceShape["revokeSession"] = Effect.fn("Admin.revokeSession")(
    function* (principal, sessionId, nowMs) {
      yield* access.requireAdmin(principal);
      yield* repositories.auth
        .revokeSession({ sessionId, nowMs })
        .pipe(Effect.mapError(mapRepositoryError));
    },
  );
  const listLibraries: AdminServiceShape["listLibraries"] = Effect.fn("Admin.listLibraries")(
    function* (principal, nowMs) {
      const ids = yield* access.accessibleLibraryIds(principal, nowMs);
      if (ids.length === 0) return [];
      return yield* database
        .select(librarySelection)
        .from(libraries)
        .leftJoin(libraryProfiles, eq(libraryProfiles.libraryId, libraries.id))
        .where(inArray(libraries.id, [...ids]))
        .orderBy(asc(libraries.name));
    },
  );
  const listAllLibraries: AdminServiceShape["listAllLibraries"] = Effect.fn(
    "Admin.listAllLibraries",
  )(function* (principal) {
    yield* access.requireAdmin(principal);
    return yield* database
      .select(librarySelection)
      .from(libraries)
      .leftJoin(libraryProfiles, eq(libraryProfiles.libraryId, libraries.id))
      .orderBy(asc(libraries.name));
  });
  return {
    listUsers,
    createUser,
    updateUser,
    listDevices,
    revokeDevice,
    listSessions,
    revokeSession,
    listLibraries,
    listAllLibraries,
  };
});

export class AdminService extends Context.Service<AdminService, AdminServiceShape>()(
  "@lumen/server/Admin",
) {}
export const AdminServiceLive = Layer.effect(AdminService, makeAdminService);
