import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { artwork, libraryRoots, libraries, mediaSources, outboxEvents, users } from "./schema";

const millis = (name: string) => integer(name).notNull();

export const serverSettings = sqliteTable("server_settings", {
  id: integer("id").primaryKey(),
  serverId: text("server_id").notNull(),
  displayName: text("display_name").notNull(),
  apiVersion: text("api_version").notNull().default("1.0.0"),
  schemaVersion: integer("schema_version").notNull(),
  createdAtMs: millis("created_at_ms"),
  updatedAtMs: millis("updated_at_ms"),
});

export const metadataProviderSettings = sqliteTable("metadata_provider_settings", {
  provider: text("provider").primaryKey(),
  apiKey: text("api_key").notNull(),
  updatedAtMs: millis("updated_at_ms"),
});

export const libraryProfiles = sqliteTable(
  "library_profiles",
  {
    libraryId: text("library_id").primaryKey(),
    kind: text("kind").notNull(),
    scanMode: text("scan_mode").notNull().default("incremental"),
    lastScanAtMs: integer("last_scan_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "library_profiles_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    check("library_profiles_kind_chk", sql`${table.kind} in ('movies', 'shows', 'music')`),
    check(
      "library_profiles_scan_mode_chk",
      sql`${table.scanMode} in ('full', 'incremental', 'refresh')`,
    ),
  ],
);

export const libraryRootStates = sqliteTable(
  "library_root_states",
  {
    rootId: text("root_id").primaryKey(),
    libraryId: text("library_id").notNull(),
    canonicalPath: text("canonical_path").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    isAvailable: integer("is_available", { mode: "boolean" }).notNull().default(true),
    unavailableReason: text("unavailable_reason"),
    scanGeneration: integer("scan_generation").notNull().default(0),
    lastSeenAtMs: integer("last_seen_at_ms"),
    updatedAtMs: millis("updated_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "library_root_states_root_fk",
      columns: [table.rootId, table.libraryId],
      foreignColumns: [libraryRoots.id, libraryRoots.libraryId],
    }).onDelete("cascade"),
    uniqueIndex("library_root_states_canonical_key_uq").on(table.canonicalKey),
    index("library_root_states_library_idx").on(table.libraryId),
  ],
);

export const catalogItems = sqliteTable(
  "catalog_items",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    kind: text("kind").notNull(),
    parentId: text("parent_id"),
    title: text("title").notNull(),
    sortTitle: text("sort_title").notNull(),
    originalTitle: text("original_title"),
    overview: text("overview"),
    year: integer("year"),
    indexNumber: integer("index_number"),
    durationSeconds: integer("duration_seconds"),
    metadataState: text("metadata_state").notNull().default("local"),
    addedAtMs: millis("added_at_ms"),
    updatedAtMs: millis("updated_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "catalog_items_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    uniqueIndex("catalog_items_id_library_uq").on(table.id, table.libraryId),
    index("catalog_items_browse_idx").on(
      table.libraryId,
      table.kind,
      table.sortTitle,
      table.id,
    ),
    index("catalog_items_recent_idx").on(table.libraryId, table.addedAtMs, table.id),
    check(
      "catalog_items_kind_chk",
      sql`${table.kind} in ('movie', 'show', 'season', 'episode', 'artist', 'album', 'track')`,
    ),
    check("catalog_items_parent_fk", sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`),
    check("catalog_items_year_chk", sql`${table.year} is null or ${table.year} between 1800 and 9999`),
    check("catalog_items_index_chk", sql`${table.indexNumber} is null or ${table.indexNumber} >= 0`),
    check(
      "catalog_items_duration_chk",
      sql`${table.durationSeconds} is null or ${table.durationSeconds} >= 0`,
    ),
  ],
);

// Reserved for secondary relationships. The navigable show → season → episode
// tree has one parent and is represented only by catalog_items.parent_id.
export const catalogItemParents = sqliteTable(
  "catalog_item_parents",
  {
    parentId: text("parent_id").notNull(),
    childId: text("child_id").notNull(),
  },
  (table) => [
    foreignKey({
      name: "catalog_item_parents_parent_fk",
      columns: [table.parentId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "catalog_item_parents_child_fk",
      columns: [table.childId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    primaryKey({ name: "catalog_item_parents_pk", columns: [table.parentId, table.childId] }),
    check("catalog_item_parents_identity_chk", sql`${table.parentId} <> ${table.childId}`),
  ],
);

export const catalogItemSources = sqliteTable(
  "catalog_item_sources",
  {
    itemId: text("item_id").notNull(),
    sourceId: text("source_id").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    sourceGeneration: integer("source_generation").notNull().default(1),
    versionLabel: text("version_label"),
  },
  (table) => [
    foreignKey({
      name: "catalog_item_sources_item_fk",
      columns: [table.itemId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "catalog_item_sources_source_fk",
      columns: [table.sourceId],
      foreignColumns: [mediaSources.id],
    }).onDelete("cascade"),
    primaryKey({ name: "catalog_item_sources_pk", columns: [table.itemId, table.sourceId] }),
    uniqueIndex("catalog_item_sources_primary_uq")
      .on(table.itemId)
      .where(sql`${table.isPrimary} = 1`),
    index("catalog_item_sources_source_idx").on(table.sourceId),
    check("catalog_item_sources_generation_chk", sql`${table.sourceGeneration} > 0`),
  ],
);

// One primary path identity per logical item. A separate roots/path key prevents
// same-named series in different roots from being merged by their display title.
export const catalogItemOrigins = sqliteTable("catalog_item_origins", {
  itemId: text("item_id").primaryKey().references(() => catalogItems.id, { onDelete: "cascade" }),
  rootId: text("root_id").notNull().references(() => libraryRoots.id, { onDelete: "cascade" }),
  relativePath: text("relative_path").notNull(),
  kind: text("kind").notNull(),
}, (table) => [
  uniqueIndex("catalog_item_origins_path_uq").on(table.rootId, table.relativePath, table.kind),
  index("catalog_item_origins_root_idx").on(table.rootId),
]);

export const catalogItemMetadata = sqliteTable("catalog_item_metadata", {
  itemId: text("item_id").primaryKey().references(() => catalogItems.id, { onDelete: "cascade" }),
  releaseDate: text("release_date"),
  contentRating: text("content_rating"),
  communityRating: real("community_rating"),
  genresJson: text("genres_json").notNull().default("[]"),
  studiosJson: text("studios_json").notNull().default("[]"),
  tagsJson: text("tags_json").notNull().default("[]"),
  externalIdsJson: text("external_ids_json").notNull().default("{}"),
  fieldSourcesJson: text("field_sources_json").notNull().default("{}"),
  lockedFieldsJson: text("locked_fields_json").notNull().default("[]"),
});

export const catalogItemArtwork = sqliteTable("catalog_item_artwork", {
  itemId: text("item_id").notNull().references(() => catalogItems.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  artworkId: text("artwork_id").notNull().references(() => artwork.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
}, (table) => [primaryKey({ name: "catalog_item_artwork_pk", columns: [table.itemId, table.role] })]);

export const mediaSourceAvailability = sqliteTable(
  "media_source_availability",
  {
    sourceId: text("source_id").primaryKey(),
    isAvailable: integer("is_available", { mode: "boolean" }).notNull().default(true),
    lastSeenAtMs: integer("last_seen_at_ms"),
    missingSinceMs: integer("missing_since_ms"),
    updatedAtMs: millis("updated_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "media_source_availability_source_fk",
      columns: [table.sourceId],
      foreignColumns: [mediaSources.id],
    }).onDelete("cascade"),
    index("media_source_availability_state_idx").on(table.isAvailable, table.updatedAtMs),
  ],
);

export const providerRecords = sqliteTable(
  "provider_records",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    provider: text("provider").notNull(),
    providerItemId: text("provider_item_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    version: integer("version").notNull().default(1),
    confidence: integer("confidence").notNull(),
    fetchedAtMs: millis("fetched_at_ms"),
    lockedFieldsJson: text("locked_fields_json").notNull().default("[]"),
  },
  (table) => [
    foreignKey({
      name: "provider_records_item_fk",
      columns: [table.itemId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    uniqueIndex("provider_records_provider_item_uq").on(
      table.itemId,
      table.provider,
      table.providerItemId,
    ),
    check("provider_records_payload_json_chk", sql`json_valid(${table.payloadJson})`),
    check("provider_records_locks_json_chk", sql`json_valid(${table.lockedFieldsJson})`),
    check("provider_records_confidence_chk", sql`${table.confidence} between 0 and 100`),
  ],
);

export const itemWatchStates = sqliteTable(
  "item_watch_states",
  {
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    positionSeconds: integer("position_seconds").notNull().default(0),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    ownershipGeneration: integer("ownership_generation").notNull().default(1),
    manualVersion: integer("manual_version").notNull().default(0),
    updatedAtMs: millis("updated_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "item_watch_states_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "item_watch_states_item_fk",
      columns: [table.itemId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    primaryKey({ name: "item_watch_states_pk", columns: [table.userId, table.itemId] }),
    index("item_watch_states_continue_idx").on(table.userId, table.updatedAtMs),
    check("item_watch_states_position_chk", sql`${table.positionSeconds} >= 0`),
    check("item_watch_states_generation_chk", sql`${table.ownershipGeneration} > 0`),
  ],
);

export const itemFavorites = sqliteTable(
  "item_favorites",
  {
    userId: text("user_id").notNull(),
    itemId: text("item_id").notNull(),
    createdAtMs: millis("created_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "item_favorites_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "item_favorites_item_fk",
      columns: [table.itemId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    primaryKey({ name: "item_favorites_pk", columns: [table.userId, table.itemId] }),
    index("item_favorites_created_idx").on(table.userId, table.createdAtMs),
  ],
);

export const directPlaybackSessions = sqliteTable(
  "direct_playback_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    itemId: text("item_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceGeneration: integer("source_generation").notNull(),
    grantTokenHash: text("grant_token_hash").notNull(),
    state: text("state").notNull().default("playing"),
    lastAcceptedSequence: integer("last_accepted_sequence").notNull().default(0),
    ownershipGeneration: integer("ownership_generation").notNull(),
    startedAtMs: millis("started_at_ms"),
    lastHeartbeatAtMs: millis("last_heartbeat_at_ms"),
    grantExpiresAtMs: millis("grant_expires_at_ms"),
    hardExpiresAtMs: millis("hard_expires_at_ms"),
    closedAtMs: integer("closed_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "direct_playback_sessions_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "direct_playback_sessions_item_fk",
      columns: [table.itemId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "direct_playback_sessions_source_fk",
      columns: [table.sourceId],
      foreignColumns: [mediaSources.id],
    }).onDelete("cascade"),
    uniqueIndex("direct_playback_sessions_grant_hash_uq").on(table.grantTokenHash),
    index("direct_playback_sessions_user_item_idx").on(table.userId, table.itemId),
    index("direct_playback_sessions_device_idx").on(table.deviceId, table.state),
    check(
      "direct_playback_sessions_state_chk",
      sql`${table.state} in ('playing', 'paused', 'buffering', 'ended', 'error', 'closed')`,
    ),
    check("direct_playback_sessions_generation_chk", sql`${table.sourceGeneration} > 0`),
    check("direct_playback_sessions_sequence_chk", sql`${table.lastAcceptedSequence} >= 0`),
    check("direct_playback_sessions_ownership_chk", sql`${table.ownershipGeneration} > 0`),
  ],
);

export const directPlaybackProgress = sqliteTable(
  "direct_playback_progress",
  {
    sessionId: text("session_id").primaryKey(),
    itemId: text("item_id").notNull(),
    sequence: integer("sequence").notNull(),
    positionSeconds: integer("position_seconds").notNull(),
    durationSeconds: integer("duration_seconds"),
    isEnded: integer("is_ended", { mode: "boolean" }).notNull().default(false),
    acceptedAtMs: millis("accepted_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "direct_playback_progress_session_fk",
      columns: [table.sessionId],
      foreignColumns: [directPlaybackSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "direct_playback_progress_item_fk",
      columns: [table.itemId],
      foreignColumns: [catalogItems.id],
    }).onDelete("cascade"),
    check("direct_playback_progress_sequence_chk", sql`${table.sequence} > 0`),
    check("direct_playback_progress_position_chk", sql`${table.positionSeconds} >= 0`),
    check(
      "direct_playback_progress_duration_chk",
      sql`${table.durationSeconds} is null or ${table.durationSeconds} >= 0`,
    ),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    state: text("state").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextRunAtMs: millis("next_run_at_ms"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAtMs: integer("lease_expires_at_ms"),
    createdAtMs: millis("created_at_ms"),
    updatedAtMs: millis("updated_at_ms"),
    completedAtMs: integer("completed_at_ms"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
  },
  (table) => [
    uniqueIndex("jobs_idempotency_key_uq").on(table.idempotencyKey),
    index("jobs_claim_idx").on(table.state, table.nextRunAtMs, table.leaseExpiresAtMs),
    check("jobs_state_chk", sql`${table.state} in ('pending', 'running', 'succeeded', 'failed', 'cancelled')`),
    check("jobs_payload_json_chk", sql`json_valid(${table.payloadJson})`),
    check("jobs_attempts_chk", sql`${table.attempts} >= 0 and ${table.maxAttempts} between 1 and 20`),
    check(
      "jobs_lease_chk",
      sql`(${table.leaseOwner} is null) = (${table.leaseExpiresAtMs} is null)`,
    ),
  ],
);

export const serverAuditEvents = sqliteTable(
  "server_audit_events",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    eventType: text("event_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    detailJson: text("detail_json").notNull().default("{}"),
    createdAtMs: millis("created_at_ms"),
  },
  (table) => [
    index("server_audit_events_created_idx").on(table.createdAtMs),
    check("server_audit_events_json_chk", sql`json_valid(${table.detailJson})`),
  ],
);

export const catalogItemOutbox = sqliteTable(
  "catalog_item_outbox",
  {
    eventId: text("event_id").primaryKey(),
    libraryId: text("library_id").notNull(),
    itemId: text("item_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAtMs: millis("created_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "catalog_item_outbox_event_fk",
      columns: [table.eventId],
      foreignColumns: [outboxEvents.id],
    }).onDelete("cascade"),
    index("catalog_item_outbox_item_idx").on(table.libraryId, table.itemId, table.createdAtMs),
  ],
);
