import { Database, serverIdentity } from "@lumen/database";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { newUuid } from "../core/Security";

export interface ServerIdentity {
  readonly installationId: string;
  readonly createdAtMs: number;
}

export class ServerIdentityService extends Context.Service<ServerIdentityService, ServerIdentity>()(
  "@lumen/server/Identity",
) {}

export const loadOrCreateServerIdentity = Effect.gen(function* () {
  const database = yield* Database;
  const nowMs = Date.now();
  const existing = yield* database
    .select({
      installationId: serverIdentity.installationId,
      createdAtMs: serverIdentity.createdAtMs,
    })
    .from(serverIdentity)
    .where(eq(serverIdentity.singleton, 1))
    .get();
  if (existing != null) return existing;
  const identity = { installationId: newUuid(), createdAtMs: nowMs } satisfies ServerIdentity;
  yield* database
    .insert(serverIdentity)
    .values({
      singleton: 1,
      installationId: identity.installationId,
      createdAtMs: identity.createdAtMs,
      updatedAtMs: identity.createdAtMs,
    })
    .onConflictDoNothing();
  const stored = yield* database
    .select({
      installationId: serverIdentity.installationId,
      createdAtMs: serverIdentity.createdAtMs,
    })
    .from(serverIdentity)
    .where(eq(serverIdentity.singleton, 1))
    .get();
  return stored ?? identity;
});

export const ServerIdentityLive = Layer.effect(ServerIdentityService, loadOrCreateServerIdentity);
