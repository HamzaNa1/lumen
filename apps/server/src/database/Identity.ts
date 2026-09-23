import { Database, sql } from "@lumen/database";
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
  const existing = yield* database.get<ServerIdentity>(sql`
    SELECT installation_id AS installationId, created_at_ms AS createdAtMs
    FROM server_identity
    WHERE singleton = 1
  `);
  if (existing != null) return existing;
  const identity = { installationId: newUuid(), createdAtMs: nowMs } satisfies ServerIdentity;
  yield* database.run(sql`
    INSERT OR IGNORE INTO server_identity(singleton, installation_id, created_at_ms, updated_at_ms)
    VALUES (1, ${identity.installationId}, ${identity.createdAtMs}, ${identity.createdAtMs})
  `);
  return yield* database.get<ServerIdentity>(sql`
    SELECT installation_id AS installationId, created_at_ms AS createdAtMs
    FROM server_identity
    WHERE singleton = 1
  `).pipe(Effect.orElseSucceed(() => identity));
});

export const ServerIdentityLive = Layer.effect(ServerIdentityService, loadOrCreateServerIdentity);
