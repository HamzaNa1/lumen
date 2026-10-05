import { Database, serverIdentity } from "@lumen/database";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ServerIdentityService } from "../database/Identity";

export interface ServerNameShape {
  readonly name: () => Effect.Effect<string, unknown>;
  readonly rename: (name: string, nowMs: number) => Effect.Effect<void, unknown>;
}

export const makeServerName = Effect.gen(function* () {
  const database = yield* Database;
  // The name lives on the identity row, which exists once the identity has been loaded.
  yield* ServerIdentityService;
  const name: ServerNameShape["name"] = () =>
    database
      .select({ name: serverIdentity.name })
      .from(serverIdentity)
      .where(eq(serverIdentity.singleton, 1))
      .get()
      .pipe(
        Effect.flatMap((row) =>
          row == null ? Effect.fail(new Error("Server identity is missing")) : Effect.succeed(row.name),
        ),
      );
  const rename: ServerNameShape["rename"] = (next, nowMs) =>
    database
      .update(serverIdentity)
      .set({ name: next, updatedAtMs: nowMs })
      .where(eq(serverIdentity.singleton, 1))
      .pipe(
        Effect.asVoid,
        Effect.mapError(() => new Error("Could not rename the server")),
      );
  return { name, rename };
});

export class ServerName extends Context.Service<ServerName, ServerNameShape>()(
  "@lumen/server/ServerName",
) {}
export const ServerNameLive = Layer.effect(ServerName, makeServerName);
