import type { GrantCapability, User } from "@lumen/contracts";
import { Database, libraries, libraryGrants, tracks, users } from "@lumen/database";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { forbidden, notFound } from "../core/Errors";
import type { AuthPrincipal } from "./AuthService";

export interface AccessControlShape {
  readonly isAdmin: (user: User) => boolean;
  readonly requireAdmin: (principal: AuthPrincipal) => Effect.Effect<void, unknown>;
  readonly can: (
    principal: AuthPrincipal,
    libraryId: string,
    capability: GrantCapability,
    nowMs: number,
  ) => Effect.Effect<boolean, unknown>;
  readonly requireLibrary: (
    principal: AuthPrincipal,
    libraryId: string,
    capability: GrantCapability,
    nowMs: number,
  ) => Effect.Effect<void, unknown>;
  readonly requireTrack: (
    principal: AuthPrincipal,
    trackId: string,
    capability: GrantCapability,
    nowMs: number,
  ) => Effect.Effect<string, unknown>;
  readonly accessibleLibraryIds: (
    principal: AuthPrincipal,
    nowMs: number,
  ) => Effect.Effect<ReadonlyArray<string>, unknown>;
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
        database
          .select({
            capabilitiesJson: libraryGrants.capabilitiesJson,
            expiresAtMs: libraryGrants.expiresAtMs,
            isActive: users.isActive,
          })
          .from(libraryGrants)
          .innerJoin(users, eq(users.id, libraryGrants.userId))
          .where(
            and(
              eq(libraryGrants.libraryId, libraryId),
              eq(libraryGrants.userId, principal.user.id),
            ),
          )
          .get(),
        (row) => {
          if (
            row == null ||
            !row.isActive ||
            (row.expiresAtMs !== null && row.expiresAtMs <= nowMs)
          )
            return false;
          const capabilities = JSON.parse(row.capabilitiesJson) as ReadonlyArray<GrantCapability>;
          return capabilities.includes(capability);
        },
      );
    });
  const requireLibrary: AccessControlShape["requireLibrary"] = (
    principal,
    libraryId,
    capability,
    nowMs,
  ) =>
    can(principal, libraryId, capability, nowMs).pipe(
      Effect.flatMap((allowed) =>
        allowed ? Effect.void : Effect.fail(forbidden("Library access denied")),
      ),
    );
  const requireTrack: AccessControlShape["requireTrack"] = (
    principal,
    trackId,
    capability,
    nowMs,
  ) =>
    Effect.gen(function* () {
      const row = yield* database
        .select({ libraryId: tracks.libraryId })
        .from(tracks)
        .where(eq(tracks.id, trackId))
        .get();
      if (row == null) return yield* notFound("Track not found");
      yield* requireLibrary(principal, row.libraryId, capability, nowMs);
      return row.libraryId;
    });
  const accessibleLibraryIds: AccessControlShape["accessibleLibraryIds"] = (principal, nowMs) =>
    Effect.suspend(() => {
      if (isAdmin(principal.user)) {
        return database
          .select({ id: libraries.id })
          .from(libraries)
          .where(eq(libraries.isEnabled, true))
          .orderBy(asc(libraries.name))
          .pipe(Effect.map((rows) => rows.map((row) => row.id)));
      }
      return database
        .select({ id: libraryGrants.libraryId })
        .from(libraryGrants)
        .innerJoin(
          libraries,
          and(eq(libraries.id, libraryGrants.libraryId), eq(libraries.isEnabled, true)),
        )
        .where(
          and(
            eq(libraryGrants.userId, principal.user.id),
            or(isNull(libraryGrants.expiresAtMs), gt(libraryGrants.expiresAtMs, nowMs)),
            sql`exists (select 1 from json_each(${libraryGrants.capabilitiesJson}) where json_each.value = 'library:read')`,
          ),
        )
        .orderBy(asc(libraries.name))
        .pipe(Effect.map((rows) => rows.map((row) => row.id)));
    });
  return { isAdmin, requireAdmin, can, requireLibrary, requireTrack, accessibleLibraryIds };
});

export class AccessControl extends Context.Service<AccessControl, AccessControlShape>()(
  "@lumen/server/AccessControl",
) {}

export const AccessControlLive = Layer.effect(AccessControl, makeAccessControl);
