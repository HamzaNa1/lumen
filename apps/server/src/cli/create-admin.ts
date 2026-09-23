import { Database, Repositories, RepositoriesLive, sql } from "@lumen/database";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Layer } from "effect";
import { makeServerConfig } from "../config/ServerConfig";
import { makeDatabaseLayers } from "../database/DatabaseLayer";
import { hashPassword, newUuid } from "../core/Security";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--") && value !== undefined) args.set(key.slice(2), value);
}

const config = await Effect.runPromise(makeServerConfig());
const username = args.get("username")?.trim() ?? "";
const displayName = args.get("display-name")?.trim() ?? username;
const password = args.get("password") ?? process.env.LUMEN_ADMIN_PASSWORD ?? "";
if (!/^[a-z0-9._-]+$/u.test(username) || displayName.length === 0 || password.length < 12) {
  throw new Error("Use --username, --display-name and a password of at least 12 characters");
}

await mkdir(dirname(config.databasePath), { recursive: true });
await mkdir(config.dataDir, { recursive: true });
const databaseLayer = makeDatabaseLayers(config);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database;
    const repositories = yield* Repositories;
    const existing = yield* database.get<{ count: number }>(sql`SELECT count(*) AS count FROM users`);
    const count = existing?.count ?? 0;
    if (count > 0 && config.adminBootstrapToken === null) throw new Error("An administrator already exists; set LUMEN_ADMIN_BOOTSTRAP_TOKEN to authorize another bootstrap");
    if (count > 0) {
      const supplied = args.get("bootstrap-token") ?? process.env.LUMEN_ADMIN_BOOTSTRAP_TOKEN ?? "";
      if (supplied !== config.adminBootstrapToken) throw new Error("Bootstrap token is invalid");
    }
    const passwordHash = yield* Effect.promise(() => hashPassword(password));
    return yield* repositories.auth.createUser({
      id: newUuid(),
      username,
      usernameNormalized: username.toLowerCase(),
      displayName,
      passwordHash,
      role: "admin",
      nowMs: Date.now(),
    });
  }).pipe(Effect.provide(Layer.mergeAll(databaseLayer, RepositoriesLive(databaseLayer)))),
);

console.log(JSON.stringify({ id: result.id, username: result.username, role: result.role }));
