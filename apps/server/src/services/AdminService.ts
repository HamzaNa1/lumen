import { Database, Repositories, sql } from "@lumen/database";
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
  readonly createUser: (principal: AuthPrincipal, input: CreateUserInput, nowMs: number) => Effect.Effect<unknown, unknown>;
  readonly updateUser: (principal: AuthPrincipal, userId: string, input: UpdateUserInput, nowMs: number) => Effect.Effect<unknown, unknown>;
  readonly listDevices: (principal: AuthPrincipal, userId: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly revokeDevice: (principal: AuthPrincipal, deviceId: string, nowMs: number) => Effect.Effect<void, unknown>;
  readonly listSessions: (principal: AuthPrincipal, userId: string, nowMs: number) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly revokeSession: (principal: AuthPrincipal, sessionId: string, nowMs: number) => Effect.Effect<void, unknown>;
  readonly listLibraries: (principal: AuthPrincipal, nowMs: number) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
  readonly listAllLibraries: (principal: AuthPrincipal) => Effect.Effect<ReadonlyArray<unknown>, unknown>;
}

export const makeAdminService = Effect.gen(function* () {
  const database = yield* Database;
  const repositories = yield* Repositories;
  const access = yield* AccessControl;
  const listUsers: AdminServiceShape["listUsers"] = Effect.fn("Admin.listUsers")(function* (principal) {
    yield* access.requireAdmin(principal);
    const rows = yield* database.all<{ id: string; username: string; displayName: string; role: string; isActive: number; createdAtMs: number; updatedAtMs: number }>(sql`
      SELECT id, username, display_name AS displayName, role, is_active AS isActive, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
      FROM users ORDER BY username
    `);
    return rows.map((row) => ({ ...row, isActive: row.isActive === 1 }));
  });
  const createUser: AdminServiceShape["createUser"] = Effect.fn("Admin.createUser")(function* (principal, input, nowMs) {
    yield* access.requireAdmin(principal);
    const normalized = input.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/u.test(normalized)) return yield* badRequest("Username contains unsupported characters");
    const passwordHash = yield* Effect.promise(() => hashPassword(input.password));
    const row = yield* database.get<Record<string, unknown>>(sql`
      INSERT INTO users(id, username, username_normalized, display_name, password_hash, role, is_active, created_at_ms, updated_at_ms)
      VALUES (${newUuid()}, ${input.username.trim()}, ${normalized}, ${input.displayName.trim()}, ${passwordHash}, ${input.role ?? "user"}, 1, ${nowMs}, ${nowMs})
      RETURNING id, username, display_name AS displayName, role, is_active AS isActive, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
    `);
    return { ...row, isActive: row?.isActive === 1 };
  });
  const updateUser: AdminServiceShape["updateUser"] = Effect.fn("Admin.updateUser")(function* (principal, userId, input, nowMs) {
    yield* access.requireAdmin(principal);
    const password = input.password;
    const passwordHash = password === undefined ? null : yield* Effect.promise(() => hashPassword(password));
    const row = yield* database.transaction((transaction) => Effect.gen(function* () {
      if (input.role !== undefined || input.isActive === false) {
        const current = yield* transaction.get<{ role: string; isActive: number }>(sql`SELECT role, is_active AS isActive FROM users WHERE id = ${userId}`);
        if (current == null) return yield* notFound("User not found");
        if (current.role === "admin" && current.isActive === 1 && ((input.role !== undefined && input.role !== "admin") || input.isActive === false)) {
          const administrators = yield* transaction.get<{ count: number }>(sql`SELECT count(*) AS count FROM users WHERE role = 'admin' AND is_active = 1`);
          if ((administrators?.count ?? 0) <= 1) return yield* conflict("The last active administrator cannot be removed");
        }
      }
      const updated = yield* transaction.get<Record<string, unknown>>(sql`
        UPDATE users SET
          display_name = COALESCE(${input.displayName ?? null}, display_name),
          password_hash = COALESCE(${passwordHash}, password_hash),
          role = COALESCE(${input.role ?? null}, role),
          is_active = COALESCE(${input.isActive ?? null}, is_active),
          updated_at_ms = ${nowMs}
        WHERE id = ${userId}
        RETURNING id, username, display_name AS displayName, role, is_active AS isActive, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
      `);
      if (updated == null) return yield* notFound("User not found");
      if (input.password !== undefined) {
        yield* transaction.run(sql`UPDATE auth_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ${nowMs}) WHERE user_id = ${userId} AND id <> ${principal.sessionId}`);
      }
      return updated;
    }));
    return { ...row, isActive: row.isActive === 1 };
  });
  const listDevices: AdminServiceShape["listDevices"] = Effect.fn("Admin.listDevices")(function* (principal, userId) {
    yield* access.requireAdmin(principal);
    return yield* database.all(sql`
      SELECT id, user_id AS userId, name, platform, platform_device_id AS platformDeviceId, last_seen_at_ms AS lastSeenAtMs, created_at_ms AS createdAtMs, revoked_at_ms AS revokedAtMs
      FROM devices WHERE user_id = ${userId} ORDER BY created_at_ms DESC
    `);
  });
  const revokeDevice: AdminServiceShape["revokeDevice"] = Effect.fn("Admin.revokeDevice")(function* (principal, deviceId, nowMs) {
    yield* access.requireAdmin(principal);
    yield* database.run(sql`UPDATE devices SET revoked_at_ms = COALESCE(revoked_at_ms, ${nowMs}) WHERE id = ${deviceId}`);
    yield* database.run(sql`UPDATE auth_sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ${nowMs}) WHERE device_id = ${deviceId}`);
  });
  const listSessions: AdminServiceShape["listSessions"] = Effect.fn("Admin.listSessions")(function* (principal, userId, nowMs) {
    yield* access.requireAdmin(principal);
    return yield* database.all(sql`
      SELECT id, user_id AS userId, device_id AS deviceId, issued_at_ms AS issuedAtMs, last_used_at_ms AS lastSeenAtMs, expires_at_ms AS expiresAtMs, revoked_at_ms AS revokedAtMs
      FROM auth_sessions WHERE user_id = ${userId} AND expires_at_ms > ${nowMs} ORDER BY issued_at_ms DESC
    `);
  });
  const revokeSession: AdminServiceShape["revokeSession"] = Effect.fn("Admin.revokeSession")(function* (principal, sessionId, nowMs) {
    yield* access.requireAdmin(principal);
    yield* repositories.auth.revokeSession({ sessionId, nowMs }).pipe(Effect.mapError(mapRepositoryError));
  });
  const listLibraries: AdminServiceShape["listLibraries"] = Effect.fn("Admin.listLibraries")(function* (principal, nowMs) {
    const ids = yield* access.accessibleLibraryIds(principal, nowMs);
    if (ids.length === 0) return [];
    const placeholders = ids.map((id) => sql`${id}`);
    return yield* database.all<{ id: string; name: string; slug: string; kind: "movies" | "shows" | "music"; isEnabled: number; createdAtMs: number; updatedAtMs: number }>(sql`
      SELECT l.id, l.name, l.slug, COALESCE(lp.kind, 'movies') AS kind, l.is_enabled AS isEnabled, l.created_at_ms AS createdAtMs, l.updated_at_ms AS updatedAtMs
      FROM libraries l LEFT JOIN library_profiles lp ON lp.library_id = l.id
      WHERE l.id IN (${sql.join(placeholders, sql`, `)})
      ORDER BY l.name
    `).pipe(Effect.map((rows) => rows.map((row) => ({ ...row, isEnabled: row.isEnabled === 1 }))));
  });
  const listAllLibraries: AdminServiceShape["listAllLibraries"] = Effect.fn("Admin.listAllLibraries")(function* (principal) {
    yield* access.requireAdmin(principal);
    return yield* database.all<{ id: string; name: string; slug: string; kind: "movies" | "shows" | "music"; isEnabled: number; createdAtMs: number; updatedAtMs: number }>(sql`
      SELECT l.id, l.name, l.slug, COALESCE(lp.kind, 'movies') AS kind, l.is_enabled AS isEnabled, l.created_at_ms AS createdAtMs, l.updated_at_ms AS updatedAtMs
      FROM libraries l LEFT JOIN library_profiles lp ON lp.library_id = l.id
      ORDER BY l.name
    `).pipe(Effect.map((rows) => rows.map((row) => ({ ...row, isEnabled: row.isEnabled === 1 }))));
  });
  return { listUsers, createUser, updateUser, listDevices, revokeDevice, listSessions, revokeSession, listLibraries, listAllLibraries };
});

export class AdminService extends Context.Service<AdminService, AdminServiceShape>()("@lumen/server/Admin") {}
export const AdminServiceLive = Layer.effect(AdminService, makeAdminService);
