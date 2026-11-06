import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "./support/database";
import { expect, password, repository, test } from "./support/server";

const shippedMigrations = async () => {
  const folder = join(repository, "packages/database/drizzle");
  return (await readdir(folder))
    .filter((name) => existsSync(join(folder, name, "migration.sql")))
    .sort();
};

// Recreates a database left by an earlier release that had applied only the first migrations.
const openMigratedThrough = async (path: string, through: number) => {
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
  const database = openDatabase(path);
  try {
    database.exec(
      "CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT, applied_at TEXT)",
    );
    for (const name of (await shippedMigrations()).slice(0, through)) {
      const sql = await readFile(
        join(repository, "packages/database/drizzle", name, "migration.sql"),
        "utf8",
      );
      database.exec(sql);
      database
        .prepare("INSERT INTO __drizzle_migrations(hash,name) VALUES(?,?)")
        .run(createHash("sha256").update(sql).digest("hex"), name);
    }
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
};

const startupEvents = (log: readonly string[]) =>
  log
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { event: string; durationMs?: number; applied?: number })
    .filter(({ event }) =>
      /^(server_starting|server_services|server_listening|database_)/.test(event),
    );

for (const through of [3, 6, 8, 9])
  test(`server upgrades a persisted database after migration ${through} without losing identities, search or watch state`, async ({
    server,
  }) => {
    await server.stop();
    const before = await openMigratedThrough(server.databasePath, through);
    const migrations = await shippedMigrations();
    const library = crypto.randomUUID();
    const root = crypto.randomUUID();
    const source = crypto.randomUUID();
    const run = crypto.randomUUID();
    const user = crypto.randomUUID();
    const item = crypto.randomUUID();
    try {
      before
        .prepare(
          "INSERT INTO libraries(id,name,slug,created_at_ms,updated_at_ms) VALUES(?,'Archive','archive',1,1)",
        )
        .run(library);
      before
        .prepare(
          "INSERT INTO library_roots(id,library_id,path,created_at_ms,updated_at_ms) VALUES(?,?,?,1,1)",
        )
        .run(root, library, join(server.root, "offline"));
      before
        .prepare(
          "INSERT INTO media_sources(id,library_id,root_id,relative_path,absolute_path,scanned_at_ms) VALUES(?,?,?,'film.mkv','/offline/film.mkv',1)",
        )
        .run(source, library, root);
      before
        .prepare(
          "INSERT INTO scan_runs(id,library_id,mode,status,created_at_ms) VALUES(?,?,'incremental','succeeded',1)",
        )
        .run(run, library);
      before
        .prepare("INSERT INTO server_scan_missing(run_id,source_id,missing_at_ms) VALUES(?,?,2)")
        .run(run, source);
      if (through >= 6) {
        const hash = execFileSync(
          "bun",
          ["-e", "console.log(await Bun.password.hash(process.argv[1]))", password],
          { encoding: "utf8" },
        ).trim();
        before
          .prepare(
            "INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,created_at_ms,updated_at_ms) VALUES(?,'visitor','visitor','Visitor',?,?,1,1)",
          )
          .run(user, hash, through < 7 ? "guest" : "user");
        before
          .prepare(
            "INSERT INTO devices(id,user_id,name,platform,last_seen_at_ms,created_at_ms) VALUES('device',?,'Old device','web',1,1)",
          )
          .run(user);
        before
          .prepare(
            `INSERT INTO library_grants(id,library_id,user_id,${through < 7 ? "role," : ""}capabilities_json,created_at_ms,updated_at_ms) VALUES('grant',?,?,${through < 7 ? "'user'," : ""}'["library:read"]',1,1)`,
          )
          .run(library, user);
        before
          .prepare(
            "INSERT INTO streams(id,source_id,kind,codec,language,ordinal,is_default) VALUES('stream',?,'audio','aac','eng',1,1)",
          )
          .run(source);
        before
          .prepare(
            "INSERT INTO catalog_items(id,library_id,kind,title,sort_title,index_number,added_at_ms,updated_at_ms) VALUES(?,?,'episode','Pilot','pilot',10,1,1)",
          )
          .run(item, library);
        before
          .prepare(
            "INSERT INTO item_watch_states(user_id,item_id,position_seconds,completed,updated_at_ms) VALUES(?,?,321,0,1)",
          )
          .run(user, item);
      }
    } finally {
      before.close();
    }
    await server.start();
    const db = openDatabase(server.databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()?.count).toBe(
        migrations.length,
      );
      db.prepare("DELETE FROM media_sources WHERE id = ?").run(source);
      expect(db.prepare("SELECT source_id FROM server_scan_missing").all()).toEqual([
        { source_id: source },
      ]);
      expect(() =>
        db.exec(
          "INSERT INTO devices(id,user_id,name,platform,last_seen_at_ms,created_at_ms) VALUES('orphan','absent','Orphan','web',1,1)",
        ),
      ).toThrow();
      expect(() =>
        db.exec(
          "INSERT INTO libraries(id,name,slug,created_at_ms,updated_at_ms) VALUES('invalid','Bad','Bad',1,0)",
        ),
      ).toThrow();
      if (through >= 6) {
        const account = await server.login("visitor");
        expect(await server.api("/auth/me", { token: account.accessToken })).toMatchObject({
          role: "user",
        });
        expect(await server.api(`/items/${item}`, { token: account.accessToken })).toMatchObject({
          item: { indexNumber: 10, indexNumberEnd: null },
          watchState: { positionSeconds: 321 },
        });
        db.prepare(
          "UPDATE catalog_items SET title = 'Pilot Parts', index_number_end = 11 WHERE id = ?",
        ).run(item);
        for (const end of [9, 10])
          expect(() =>
            db.prepare("UPDATE catalog_items SET index_number_end = ? WHERE id = ?").run(end, item),
          ).toThrow();
        expect(() =>
          db.prepare("UPDATE catalog_items SET parent_id = 'missing' WHERE id = ?").run(item),
        ).toThrow();
        expect(
          db
            .prepare("SELECT item_id FROM catalog_item_fts WHERE catalog_item_fts MATCH 'parts'")
            .all(),
        ).toEqual([{ item_id: item }]);
        db.prepare("INSERT INTO user_track_preferences(user_id) VALUES(?)").run(user);
        db.prepare(
          "INSERT INTO media_track_overrides(user_id,item_id,subtitle_json) VALUES(?,?, '\"off\"')",
        ).run(user, item);
        db.prepare("DELETE FROM users WHERE id = ?").run(user);
        expect(db.prepare("SELECT * FROM user_track_preferences").all()).toEqual([]);
        expect(db.prepare("SELECT * FROM media_track_overrides").all()).toEqual([]);
      }
      db.prepare("DELETE FROM libraries WHERE id = ?").run(library);
      expect(db.prepare("SELECT * FROM server_scan_missing").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

test("legacy refresh exchange is one-use, revokes the old session and survives restart", async ({
  server,
  admin,
}) => {
  const refreshToken = crypto.randomUUID();
  const db = openDatabase(server.databasePath);
  try {
    const now = Date.now();
    db.prepare(
      "INSERT INTO refresh_tokens(id,session_id,token_hash,family_id,generation,issued_at_ms,expires_at_ms) VALUES(?,?,?,?,0,?,?)",
    ).run(
      crypto.randomUUID(),
      admin.sessionId,
      createHash("sha256").update(refreshToken).digest("hex"),
      crypto.randomUUID(),
      now,
      now + 86400_000,
    );
  } finally {
    db.close();
  }
  await server.restart();
  const next = await server.api<{ accessToken: string; sessionId: string }>(
    "/auth/migrate-session",
    { status: 200, body: { refreshToken } },
  );
  expect(next.sessionId).not.toBe(admin.sessionId);
  await server.api("/auth/me", { token: next.accessToken });
  await server.api("/auth/me", { token: admin.accessToken, status: 401 });
  await server.api("/auth/migrate-session", { status: 401, body: { refreshToken } });
});

test("server reports timed startup phases and validates foreign keys only for an unvalidated migration state", async ({
  server,
}) => {
  const migrated = [
    "server_starting",
    "server_services_initializing",
    "database_open_started",
    "database_open_completed",
    "database_migrations_started",
    "database_migrations_completed",
  ];
  const served = ["server_services_initialized", "server_listening"];
  const first = startupEvents(server.log);
  expect(first.map(({ event }) => event)).toEqual([
    ...migrated,
    "database_foreign_key_check_started",
    "database_foreign_key_check_completed",
    ...served,
  ]);
  for (const { event, durationMs } of first)
    if (/_(completed|initialized|listening)$/.test(event))
      expect(durationMs, event).toBeGreaterThanOrEqual(0);
  const logged = server.log.length;
  await server.restart();
  const restarted = startupEvents(server.log.slice(logged));
  expect(restarted.map(({ event }) => event)).toEqual([
    ...migrated,
    "database_foreign_key_check_skipped",
    ...served,
  ]);
  expect(restarted[5]).toMatchObject({ applied: 0 });
});

test("server keeps refusing to serve after committed migrations fail foreign key validation", async ({
  server,
}) => {
  await server.stop();
  const migrations = await shippedMigrations();
  const before = await openMigratedThrough(server.databasePath, 9);
  try {
    before.exec("PRAGMA foreign_keys = OFF");
    before.exec(
      "INSERT INTO devices(id,user_id,name,platform,last_seen_at_ms,created_at_ms) VALUES('orphan','absent','Orphan','web',1,1)",
    );
  } finally {
    before.close();
  }
  for (const applied of [migrations.length - 9, 0]) {
    const logged = server.log.length;
    await expect(server.start()).rejects.toThrow(/Server exited \(1\)/);
    const events = startupEvents(server.log.slice(logged));
    expect(events.map(({ event }) => event)).toContain("database_foreign_key_check_failed");
    expect(events.map(({ event }) => event)).not.toContain("server_listening");
    expect(events.find(({ event }) => event === "database_migrations_completed")).toMatchObject({
      applied,
    });
  }
  const db = openDatabase(server.databasePath);
  try {
    expect(db.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()?.count).toBe(
      migrations.length,
    );
    db.exec("DELETE FROM devices WHERE id = 'orphan'");
  } finally {
    db.close();
  }
  const logged = server.log.length;
  await server.start();
  expect(startupEvents(server.log.slice(logged)).map(({ event }) => event)).toContain(
    "database_foreign_key_check_completed",
  );
  expect(await server.api("/auth/setup")).toEqual({ setupRequired: true });
});
