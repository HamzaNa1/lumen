import { Database, sql } from "@lumen/database";
import { Effect } from "effect";

export const migrateServerDatabase = Effect.fn("database.migrateServer")(function* () {
  const database = yield* Database;
  const statements = [
    `CREATE TABLE IF NOT EXISTS server_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      installation_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS server_scan_state (
      root_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      FOREIGN KEY (root_id) REFERENCES library_roots(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS server_scan_seen (
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      seen_at_ms INTEGER NOT NULL,
      PRIMARY KEY (run_id, source_id),
      FOREIGN KEY (run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES media_sources(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS server_playback_sequences (
      session_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (session_id, track_id),
      FOREIGN KEY (session_id) REFERENCES playback_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS server_event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      topic TEXT NOT NULL,
      user_id TEXT,
      payload_json TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS server_event_log_user_id_idx ON server_event_log(user_id, id)`,
    `CREATE TRIGGER IF NOT EXISTS catalog_items_parent_library_insert BEFORE INSERT ON catalog_items
      WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM catalog_items p WHERE p.id = NEW.parent_id AND p.library_id = NEW.library_id)
      BEGIN SELECT RAISE(ABORT, 'catalog parent must belong to the same library'); END`,
    `CREATE TRIGGER IF NOT EXISTS catalog_items_parent_library_update BEFORE UPDATE OF parent_id, library_id ON catalog_items
      WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM catalog_items p WHERE p.id = NEW.parent_id AND p.library_id = NEW.library_id)
      BEGIN SELECT RAISE(ABORT, 'catalog parent must belong to the same library'); END`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS catalog_item_fts USING fts5(item_id UNINDEXED, library_id UNINDEXED, title, subtitle, tokenize = 'unicode61 remove_diacritics 2')`,
    `CREATE TRIGGER IF NOT EXISTS catalog_items_fts_insert AFTER INSERT ON catalog_items BEGIN
      INSERT INTO catalog_item_fts(item_id, library_id, title, subtitle) VALUES (NEW.id, NEW.library_id, NEW.title, COALESCE(NEW.original_title, ''));
    END`,
    `CREATE TRIGGER IF NOT EXISTS catalog_items_fts_update AFTER UPDATE ON catalog_items BEGIN
      DELETE FROM catalog_item_fts WHERE item_id = OLD.id;
      INSERT INTO catalog_item_fts(item_id, library_id, title, subtitle) VALUES (NEW.id, NEW.library_id, NEW.title, COALESCE(NEW.original_title, ''));
    END`,
    `CREATE TRIGGER IF NOT EXISTS catalog_items_fts_delete AFTER DELETE ON catalog_items BEGIN
      DELETE FROM catalog_item_fts WHERE item_id = OLD.id;
    END`,
  ];
  for (const statement of statements) yield* database.run(sql.raw(statement));
});
