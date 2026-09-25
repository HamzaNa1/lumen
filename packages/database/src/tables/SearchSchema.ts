import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Query-only representation. The backing object is an FTS5 virtual table and
// is therefore created by custom SQL in the versioned Drizzle migration.
export const catalogItemFts = sqliteTable("catalog_item_fts", {
  itemId: text("item_id"),
  libraryId: text("library_id"),
  title: text("title"),
  subtitle: text("subtitle"),
  rank: integer("rank"),
});

export const catalogFts = sqliteTable("catalog_fts", {
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  title: text("title"),
  subtitle: text("subtitle"),
});
