import type { GrantCapability, User } from "@lumen/contracts";
import { Database, sql } from "@lumen/database";
import { Context, Effect, Layer } from "effect";
import { forbidden, notFound } from "../core/Errors";
import type { AuthPrincipal } from "./AuthService";

interface GrantRow {
  readonly capabilitiesJson: string;
  readonly expiresAtMs: number | null;
  readonly isActive: boolean;
}

export interface AccessControlShape {
  readonly isAdmin: (user: User) => boolean;
  readonly requireAdmin: (principal: AuthPrincipal) => Effect.Effect<void, unknown>;
  readonly can: (principal: AuthPrincipal, libraryId: string, capability: GrantCapability, nowMs: number) => Effect.Effect<boolean, unknown>;
  readonly requireLibrary: (principal: AuthPrincipal, libraryId: string, capability: GrantCapability, nowMs: number) => Effect.Effect<void, unknown>;
  readonly requireTrack: (principal: AuthPrincipal, trackId: string, capability: GrantCapability, nowMs: number) => Effect.Effect<string, unknown>;
  readonly accessibleLibraryIds: (principal: AuthPrincipal, nowMs: number) => Effect.Effect<ReadonlyArray<string>, unknown>;
}

export const makeAccessControl = Effect.gen(function* () {
  const database = yield* Database;
  const isAdmin = (user: User): boolean => user.role === "admin" && user.isActive;
  const requireAdmin: AccessControlShape["requireAdmin"] = (principal) =>
    isAdmin(principal.user) ? Effect.void : Effect.fail(forbidden("Administrator access required"));
  const can: AccessControlShape["can"] = (principal, libraryId, capability, nowMs) =>
    Effect.suspend(() => {
      if (isAdmin(principal.user)) return Effect.succeed(true);
      return Effect.map(
        database.get<GrantRow>(sql`
          SELECT capabilities_json AS capabilitiesJson, expires_at_ms AS expiresAtMs, u.is_active AS isActive
          FROM library_grants g JOIN users u ON u.id = g.user_id
          WHERE g.library_id = ${libraryId} AND g.user_id = ${principal.user.id}
        `),
        (row) => {
          if (row == null || !row.isActive || row.expiresAtMs !== null && row.expiresAtMs <= nowMs) return false;
          const capabilities = JSON.parse(row.capabilitiesJson) as ReadonlyArray<GrantCapability>;
          return capabilities.includes(capability);
        },
      );
    });
  const requireLibrary: AccessControlShape["requireLibrary"] = (principal, libraryId, capability, nowMs) =>
    can(principal, libraryId, capability, nowMs).pipe(
      Effect.flatMap((allowed) => allowed ? Effect.void : Effect.fail(forbidden("Library access denied"))),
    );
  const requireTrack: AccessControlShape["requireTrack"] = (principal, trackId, capability, nowMs) =>
    Effect.gen(function* () {
      const row = yield* database.get<{ libraryId: string }>(sql`
        SELECT library_id AS libraryId FROM tracks WHERE id = ${trackId}
      `);
      if (row == null) return yield* notFound("Track not found");
      yield* requireLibrary(principal, row.libraryId, capability, nowMs);
      return row.libraryId;
    });
  const accessibleLibraryIds: AccessControlShape["accessibleLibraryIds"] = (principal, nowMs) =>
    Effect.suspend(() => {
      if (isAdmin(principal.user)) {
        return database.all<{ id: string }>(sql`SELECT id FROM libraries WHERE is_enabled = 1 ORDER BY name`).pipe(
          Effect.map((rows) => rows.map((row) => row.id)),
        );
      }
      return database.all<{ id: string }>(sql`
        SELECT g.library_id AS id
        FROM library_grants g
        JOIN libraries l ON l.id = g.library_id AND l.is_enabled = 1
        WHERE g.user_id = ${principal.user.id}
          AND (g.expires_at_ms IS NULL OR g.expires_at_ms > ${nowMs})
          AND EXISTS (
            SELECT 1 FROM json_each(g.capabilities_json)
            WHERE json_each.value = 'library:read'
          )
        ORDER BY l.name
      `).pipe(Effect.map((rows) => rows.map((row) => row.id)));
    });
  return { isAdmin, requireAdmin, can, requireLibrary, requireTrack, accessibleLibraryIds };
});

export class AccessControl extends Context.Service<AccessControl, AccessControlShape>()(
  "@lumen/server/AccessControl",
) {}

export const AccessControlLive = Layer.effect(AccessControl, makeAccessControl);
