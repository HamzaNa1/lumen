import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name).notNull().default(sql`(unixepoch() * 1000)`);
const nullableTimestamp = (name: string) => integer(name);
const createdAt = (name = "created_at_ms") => timestamp(name);
const updatedAt = (name = "updated_at_ms") => timestamp(name);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    usernameNormalized: text("username_normalized").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAtMs: createdAt(),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    uniqueIndex("users_username_normalized_uq").on(table.usernameNormalized),
    check("users_username_nonempty_chk", sql`length(trim(${table.username})) > 0`),
    check(
      "users_username_normalized_chk",
      sql`length(${table.usernameNormalized}) > 0 and ${table.usernameNormalized} not glob '*[^a-z0-9._-]*'`,
    ),
    check("users_display_name_nonempty_chk", sql`length(trim(${table.displayName})) > 0`),
    check("users_role_chk", sql`${table.role} in ('admin', 'user', 'guest')`),
    check("users_timestamps_chk", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    platformDeviceId: text("platform_device_id"),
    lastSeenAtMs: timestamp("last_seen_at_ms"),
    createdAtMs: createdAt(),
    revokedAtMs: nullableTimestamp("revoked_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "devices_user_id_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    uniqueIndex("devices_id_user_uq").on(table.id, table.userId),
    uniqueIndex("devices_user_platform_device_uq")
      .on(table.userId, table.platform, table.platformDeviceId)
      .where(sql`${table.platformDeviceId} is not null`),
    index("devices_user_active_idx").on(table.userId, table.revokedAtMs),
    check("devices_name_nonempty_chk", sql`length(trim(${table.name})) > 0`),
    check(
      "devices_platform_chk",
      sql`${table.platform} in ('web', 'desktop', 'ios', 'android', 'other')`,
    ),
    check(
      "devices_revoked_chk",
      sql`${table.revokedAtMs} is null or ${table.revokedAtMs} >= ${table.createdAtMs}`,
    ),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    sessionTokenHash: text("session_token_hash").notNull(),
    issuedAtMs: timestamp("issued_at_ms"),
    lastUsedAtMs: timestamp("last_used_at_ms"),
    expiresAtMs: integer("expires_at_ms").notNull(),
    revokedAtMs: nullableTimestamp("revoked_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "auth_sessions_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_sessions_device_fk",
      columns: [table.deviceId, table.userId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete("cascade"),
    uniqueIndex("auth_sessions_token_hash_uq").on(table.sessionTokenHash),
    index("auth_sessions_user_expiry_idx").on(table.userId, table.expiresAtMs),
    index("auth_sessions_device_idx").on(table.deviceId),
    check(
      "auth_sessions_token_hash_chk",
      sql`length(${table.sessionTokenHash}) = 64 and ${table.sessionTokenHash} not glob '*[^0-9a-f]*'`,
    ),
    check("auth_sessions_expiry_chk", sql`${table.expiresAtMs} > ${table.issuedAtMs}`),
    check(
      "auth_sessions_usage_chk",
      sql`${table.lastUsedAtMs} >= ${table.issuedAtMs} and (${table.revokedAtMs} is null or ${table.revokedAtMs} >= ${table.issuedAtMs})`,
    ),
  ],
);

export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    familyId: text("family_id").notNull(),
    generation: integer("generation").notNull().default(0),
    issuedAtMs: timestamp("issued_at_ms"),
    expiresAtMs: integer("expires_at_ms").notNull(),
    usedAtMs: nullableTimestamp("used_at_ms"),
    revokedAtMs: nullableTimestamp("revoked_at_ms"),
    replacedByTokenId: text("replaced_by_token_id"),
  },
  (table) => [
    foreignKey({
      name: "refresh_tokens_session_fk",
      columns: [table.sessionId],
      foreignColumns: [authSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "refresh_tokens_replacement_fk",
      columns: [table.replacedByTokenId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    uniqueIndex("refresh_tokens_hash_uq").on(table.tokenHash),
    index("refresh_tokens_family_generation_idx").on(table.familyId, table.generation),
    index("refresh_tokens_session_idx").on(table.sessionId),
    check(
      "refresh_tokens_hash_chk",
      sql`length(${table.tokenHash}) = 64 and ${table.tokenHash} not glob '*[^0-9a-f]*'`,
    ),
    check("refresh_tokens_generation_chk", sql`${table.generation} >= 0`),
    check("refresh_tokens_expiry_chk", sql`${table.expiresAtMs} > ${table.issuedAtMs}`),
    check(
      "refresh_tokens_usage_chk",
      sql`(${table.usedAtMs} is null or ${table.usedAtMs} >= ${table.issuedAtMs}) and (${table.revokedAtMs} is null or ${table.revokedAtMs} >= ${table.issuedAtMs})`,
    ),
  ],
);

export const libraries = sqliteTable(
  "libraries",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    createdAtMs: createdAt(),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    uniqueIndex("libraries_slug_uq").on(table.slug),
    check("libraries_name_nonempty_chk", sql`length(trim(${table.name})) > 0`),
    check(
      "libraries_slug_chk",
      sql`${table.slug} not glob '*[^a-z0-9-]*' and ${table.slug} not glob '--*' and ${table.slug} not glob '*-' and ${table.slug} not glob '-*'`,
    ),
    check("libraries_timestamps_chk", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);

export const libraryRoots = sqliteTable(
  "library_roots",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    path: text("path").notNull(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    priority: integer("priority").notNull().default(0),
    createdAtMs: createdAt(),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "library_roots_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    uniqueIndex("library_roots_id_library_uq").on(table.id, table.libraryId),
    uniqueIndex("library_roots_path_uq").on(table.path),
    index("library_roots_library_priority_idx").on(table.libraryId, table.priority),
    check("library_roots_path_absolute_chk", sql`length(trim(${table.path})) > 0`),
    check("library_roots_priority_chk", sql`${table.priority} >= 0`),
    check("library_roots_timestamps_chk", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);

export const libraryGrants = sqliteTable(
  "library_grants",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
    canDownload: integer("can_download", { mode: "boolean" }).notNull().default(false),
    expiresAtMs: nullableTimestamp("expires_at_ms"),
    createdAtMs: createdAt(),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "library_grants_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "library_grants_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    uniqueIndex("library_grants_library_user_uq").on(table.libraryId, table.userId),
    index("library_grants_user_idx").on(table.userId),
    check("library_grants_role_chk", sql`${table.role} in ('admin', 'user', 'guest')`),
    check("library_grants_capabilities_json_chk", sql`json_valid(${table.capabilitiesJson})`),
    check(
      "library_grants_expiry_chk",
      sql`${table.expiresAtMs} is null or ${table.expiresAtMs} > ${table.createdAtMs}`,
    ),
    check("library_grants_timestamps_chk", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);

export const mediaSources = sqliteTable(
  "media_sources",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    rootId: text("root_id").notNull(),
    relativePath: text("relative_path").notNull(),
    absolutePath: text("absolute_path").notNull(),
    kind: text("kind").notNull().default("local"),
    fileSizeBytes: integer("file_size_bytes"),
    modifiedAtMs: nullableTimestamp("modified_at_ms"),
    inode: text("inode"),
    contentFingerprint: text("content_fingerprint"),
    scannedAtMs: timestamp("scanned_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "media_sources_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "media_sources_root_fk",
      columns: [table.rootId, table.libraryId],
      foreignColumns: [libraryRoots.id, libraryRoots.libraryId],
    }).onDelete("cascade"),
    uniqueIndex("media_sources_id_library_uq").on(table.id, table.libraryId),
    uniqueIndex("media_sources_absolute_path_uq").on(table.absolutePath),
    uniqueIndex("media_sources_library_relative_path_uq").on(table.libraryId, table.relativePath),
    index("media_sources_library_scanned_idx").on(table.libraryId, table.scannedAtMs),
    index("media_sources_fingerprint_idx").on(table.contentFingerprint),
    check("media_sources_kind_chk", sql`${table.kind} in ('local', 'smb', 'nfs', 'remote')`),
    check("media_sources_relative_path_chk", sql`length(trim(${table.relativePath})) > 0`),
    check("media_sources_absolute_path_chk", sql`length(trim(${table.absolutePath})) > 0`),
    check(
      "media_sources_size_chk",
      sql`${table.fileSizeBytes} is null or ${table.fileSizeBytes} >= 0`,
    ),
  ],
);

export const streams = sqliteTable(
  "streams",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    container: text("container"),
    codec: text("codec"),
    language: text("language"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    bitrate: integer("bitrate"),
    sampleRateHz: integer("sample_rate_hz"),
    channels: integer("channels"),
    width: integer("width"),
    height: integer("height"),
  },
  (table) => [
    foreignKey({
      name: "streams_source_fk",
      columns: [table.sourceId],
      foreignColumns: [mediaSources.id],
    }).onDelete("cascade"),
    uniqueIndex("streams_id_source_uq").on(table.id, table.sourceId),
    uniqueIndex("streams_source_kind_language_uq").on(
      table.sourceId,
      table.kind,
      sql<string>`coalesce(${table.language}, '')`,
    ),
    uniqueIndex("streams_source_default_uq")
      .on(table.sourceId)
      .where(sql`${table.kind} = 'audio' and ${table.isDefault} = 1`),
    index("streams_source_idx").on(table.sourceId),
    check("streams_kind_chk", sql`${table.kind} in ('audio', 'video', 'subtitle')`),
    check("streams_bitrate_chk", sql`${table.bitrate} is null or ${table.bitrate} >= 0`),
    check(
      "streams_sample_rate_chk",
      sql`${table.sampleRateHz} is null or ${table.sampleRateHz} > 0`,
    ),
    check("streams_channels_chk", sql`${table.channels} is null or ${table.channels} > 0`),
    check(
      "streams_dimensions_chk",
      sql`(${table.width} is null or ${table.width} > 0) and (${table.height} is null or ${table.height} > 0)`,
    ),
  ],
);

export const chapters = sqliteTable(
  "chapters",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
  },
  (table) => [
    foreignKey({
      name: "chapters_stream_fk",
      columns: [table.streamId],
      foreignColumns: [streams.id],
    }).onDelete("cascade"),
    uniqueIndex("chapters_stream_ordinal_uq").on(table.streamId, table.ordinal),
    check("chapters_ordinal_chk", sql`${table.ordinal} >= 0`),
    check("chapters_title_chk", sql`length(trim(${table.title})) > 0`),
    check("chapters_timing_chk", sql`${table.startMs} >= 0 and ${table.endMs} > ${table.startMs}`),
  ],
);

export const streamSidecars = sqliteTable(
  "stream_sidecars",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id").notNull(),
    kind: text("kind").notNull(),
    relativePath: text("relative_path").notNull(),
    mediaType: text("media_type"),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    foreignKey({
      name: "stream_sidecars_stream_fk",
      columns: [table.streamId],
      foreignColumns: [streams.id],
    }).onDelete("cascade"),
    uniqueIndex("stream_sidecars_stream_kind_path_uq").on(
      table.streamId,
      table.kind,
      table.relativePath,
    ),
    uniqueIndex("stream_sidecars_content_hash_uq").on(table.contentHash),
    check(
      "stream_sidecars_kind_chk",
      sql`${table.kind} in ('cue', 'nfo', 'lyrics', 'chapters', 'artwork', 'other')`,
    ),
    check("stream_sidecars_path_chk", sql`length(trim(${table.relativePath})) > 0`),
    check(
      "stream_sidecars_hash_chk",
      sql`length(${table.contentHash}) = 64 and ${table.contentHash} not glob '*[^0-9a-f]*'`,
    ),
  ],
);

export const artists = sqliteTable(
  "artists",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    sortName: text("sort_name"),
    externalIdsJson: text("external_ids_json").notNull().default("{}"),
    createdAtMs: createdAt(),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "artists_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    uniqueIndex("artists_id_library_uq").on(table.id, table.libraryId),
    uniqueIndex("artists_library_normalized_name_uq").on(table.libraryId, table.normalizedName),
    index("artists_library_sort_name_idx").on(table.libraryId, table.sortName),
    check("artists_name_chk", sql`length(trim(${table.name})) > 0`),
    check("artists_normalized_name_chk", sql`length(trim(${table.normalizedName})) > 0`),
    check("artists_external_ids_json_chk", sql`json_valid(${table.externalIdsJson})`),
    check("artists_timestamps_chk", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);

export const albums = sqliteTable(
  "albums",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    albumArtistId: text("album_artist_id"),
    releaseDate: text("release_date"),
    originalReleaseDate: text("original_release_date"),
    releaseYear: integer("release_year"),
    barcode: text("barcode"),
    externalIdsJson: text("external_ids_json").notNull().default("{}"),
    createdAtMs: createdAt(),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "albums_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "albums_artist_fk",
      columns: [table.albumArtistId, table.libraryId],
      foreignColumns: [artists.id, artists.libraryId],
    }).onDelete("restrict"),
    uniqueIndex("albums_id_library_uq").on(table.id, table.libraryId),
    uniqueIndex("albums_library_normalized_title_artist_uq").on(
      table.libraryId,
      table.normalizedTitle,
      sql<string>`coalesce(${table.albumArtistId}, '')`,
    ),
    index("albums_library_title_idx").on(table.libraryId, table.title),
    check("albums_title_chk", sql`length(trim(${table.title})) > 0`),
    check("albums_normalized_title_chk", sql`length(trim(${table.normalizedTitle})) > 0`),
    check(
      "albums_release_year_chk",
      sql`${table.releaseYear} is null or ${table.releaseYear} between 0 and 9999`,
    ),
    check("albums_external_ids_json_chk", sql`json_valid(${table.externalIdsJson})`),
    check("albums_timestamps_chk", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);

export const tracks = sqliteTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    sourceId: text("source_id").notNull(),
    primaryStreamId: text("primary_stream_id").notNull(),
    albumId: text("album_id"),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    trackNumber: integer("track_number"),
    discNumber: integer("disc_number"),
    durationMs: integer("duration_ms"),
    isExplicit: integer("is_explicit", { mode: "boolean" }).notNull().default(false),
    createdAtMs: createdAt(),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "tracks_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "tracks_source_fk",
      columns: [table.sourceId, table.libraryId],
      foreignColumns: [mediaSources.id, mediaSources.libraryId],
    }).onDelete("cascade"),
    foreignKey({
      name: "tracks_primary_stream_fk",
      columns: [table.primaryStreamId, table.sourceId],
      foreignColumns: [streams.id, streams.sourceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "tracks_album_fk",
      columns: [table.albumId, table.libraryId],
      foreignColumns: [albums.id, albums.libraryId],
    }).onDelete("restrict"),
    uniqueIndex("tracks_id_library_uq").on(table.id, table.libraryId),
    uniqueIndex("tracks_primary_stream_uq").on(table.primaryStreamId),
    index("tracks_library_album_disc_track_idx").on(
      table.libraryId,
      table.albumId,
      table.discNumber,
      table.trackNumber,
    ),
    index("tracks_source_idx").on(table.sourceId),
    check("tracks_title_chk", sql`length(trim(${table.title})) > 0`),
    check("tracks_normalized_title_chk", sql`length(trim(${table.normalizedTitle})) > 0`),
    check(
      "tracks_numbers_chk",
      sql`(${table.trackNumber} is null or ${table.trackNumber} >= 0) and (${table.discNumber} is null or ${table.discNumber} >= 0)`,
    ),
    check("tracks_duration_chk", sql`${table.durationMs} is null or ${table.durationMs} >= 0`),
    check("tracks_timestamps_chk", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
  ],
);

export const trackArtists = sqliteTable(
  "track_artists",
  {
    trackId: text("track_id").notNull(),
    artistId: text("artist_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    role: text("role").notNull().default("primary"),
  },
  (table) => [
    foreignKey({
      name: "track_artists_track_fk",
      columns: [table.trackId],
      foreignColumns: [tracks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "track_artists_artist_fk",
      columns: [table.artistId],
      foreignColumns: [artists.id],
    }).onDelete("cascade"),
    primaryKey({ name: "track_artists_pk", columns: [table.trackId, table.artistId, table.role] }),
    uniqueIndex("track_artists_role_ordinal_uq").on(table.trackId, table.role, table.ordinal),
    index("track_artists_artist_idx").on(table.artistId),
    check("track_artists_ordinal_chk", sql`${table.ordinal} >= 0`),
    check(
      "track_artists_role_chk",
      sql`${table.role} in ('primary', 'featured', 'composer', 'conductor', 'remixer', 'other')`,
    ),
  ],
);

export const albumArtists = sqliteTable(
  "album_artists",
  {
    albumId: text("album_id").notNull(),
    artistId: text("artist_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    role: text("role").notNull().default("primary"),
  },
  (table) => [
    foreignKey({
      name: "album_artists_album_fk",
      columns: [table.albumId],
      foreignColumns: [albums.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "album_artists_artist_fk",
      columns: [table.artistId],
      foreignColumns: [artists.id],
    }).onDelete("cascade"),
    primaryKey({ name: "album_artists_pk", columns: [table.albumId, table.artistId, table.role] }),
    uniqueIndex("album_artists_role_ordinal_uq").on(table.albumId, table.role, table.ordinal),
    index("album_artists_artist_idx").on(table.artistId),
    check("album_artists_ordinal_chk", sql`${table.ordinal} >= 0`),
    check(
      "album_artists_role_chk",
      sql`${table.role} in ('primary', 'featured', 'composer', 'conductor', 'remixer', 'other')`,
    ),
  ],
);

export const trackMetadata = sqliteTable(
  "track_metadata",
  {
    trackId: text("track_id").notNull(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    language: text("language"),
    sourceId: text("source_id"),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "track_metadata_track_fk",
      columns: [table.trackId],
      foreignColumns: [tracks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "track_metadata_source_fk",
      columns: [table.sourceId],
      foreignColumns: [mediaSources.id],
    }).onDelete("set null"),
    primaryKey({
      name: "track_metadata_pk",
      columns: [table.trackId, table.namespace, table.key, table.language],
    }),
    index("track_metadata_source_idx").on(table.sourceId),
    check(
      "track_metadata_namespace_chk",
      sql`${table.namespace} in ('core', 'technical', 'tag', 'external', 'analysis')`,
    ),
    check("track_metadata_key_chk", sql`length(trim(${table.key})) > 0`),
    check("track_metadata_value_json_chk", sql`json_valid(${table.valueJson})`),
    uniqueIndex("track_metadata_identity_uq").on(
      table.trackId,
      table.namespace,
      table.key,
      sql<string>`coalesce(${table.language}, '')`,
    ),
  ],
);

export const artwork = sqliteTable(
  "artwork",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    sourceId: text("source_id"),
    kind: text("kind").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentHash: text("content_hash").notNull(),
    relativePath: text("relative_path").notNull(),
    createdAtMs: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "artwork_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artwork_source_fk",
      columns: [table.sourceId, table.libraryId],
      foreignColumns: [mediaSources.id, mediaSources.libraryId],
    }).onDelete("restrict"),
    uniqueIndex("artwork_library_hash_kind_uq").on(table.libraryId, table.contentHash, table.kind),
    uniqueIndex("artwork_library_path_uq").on(table.libraryId, table.relativePath),
    index("artwork_source_idx").on(table.sourceId),
    check("artwork_kind_chk", sql`${table.kind} in ('front', 'back', 'disc', 'artist', 'other')`),
    check("artwork_mime_type_chk", sql`length(trim(${table.mimeType})) > 0`),
    check("artwork_dimensions_chk", sql`${table.width} > 0 and ${table.height} > 0`),
    check("artwork_byte_size_chk", sql`${table.byteSize} >= 0`),
    check(
      "artwork_hash_chk",
      sql`length(${table.contentHash}) = 64 and ${table.contentHash} not glob '*[^0-9a-f]*'`,
    ),
    check("artwork_path_chk", sql`length(trim(${table.relativePath})) > 0`),
  ],
);

export const artworkAssignments = sqliteTable(
  "artwork_assignments",
  {
    artworkId: text("artwork_id").notNull(),
    albumId: text("album_id"),
    artistId: text("artist_id"),
    trackId: text("track_id"),
    ordinal: integer("ordinal").notNull().default(0),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    foreignKey({
      name: "artwork_assignments_artwork_fk",
      columns: [table.artworkId],
      foreignColumns: [artwork.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artwork_assignments_album_fk",
      columns: [table.albumId],
      foreignColumns: [albums.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artwork_assignments_artist_fk",
      columns: [table.artistId],
      foreignColumns: [artists.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "artwork_assignments_track_fk",
      columns: [table.trackId],
      foreignColumns: [tracks.id],
    }).onDelete("cascade"),
    uniqueIndex("artwork_assignments_target_uq").on(
      table.albumId,
      table.artistId,
      table.trackId,
      table.ordinal,
    ),
    uniqueIndex("artwork_assignments_primary_uq")
      .on(table.albumId, table.artistId, table.trackId)
      .where(sql`${table.isPrimary} = 1`),
    check(
      "artwork_assignments_target_chk",
      sql`(${table.albumId} is not null) + (${table.artistId} is not null) + (${table.trackId} is not null) = 1`,
    ),
    check("artwork_assignments_ordinal_chk", sql`${table.ordinal} >= 0`),
  ],
);

export const watchStates = sqliteTable(
  "watch_states",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    trackId: text("track_id").notNull(),
    positionMs: integer("position_ms").notNull().default(0),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "watch_states_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "watch_states_track_fk",
      columns: [table.trackId],
      foreignColumns: [tracks.id],
    }).onDelete("cascade"),
    uniqueIndex("watch_states_user_track_uq").on(table.userId, table.trackId),
    index("watch_states_user_updated_idx").on(table.userId, table.updatedAtMs),
    check("watch_states_position_chk", sql`${table.positionMs} >= 0`),
  ],
);

export const favorites = sqliteTable(
  "favorites",
  {
    userId: text("user_id").notNull(),
    trackId: text("track_id").notNull(),
    createdAtMs: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "favorites_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "favorites_track_fk",
      columns: [table.trackId],
      foreignColumns: [tracks.id],
    }).onDelete("cascade"),
    primaryKey({ name: "favorites_pk", columns: [table.userId, table.trackId] }),
    index("favorites_user_created_idx").on(table.userId, table.createdAtMs),
  ],
);

export const playbackSessions = sqliteTable(
  "playback_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deviceId: text("device_id").notNull(),
    state: text("state").notNull().default("idle"),
    grantTokenHash: text("grant_token_hash").notNull(),
    activeTrackId: text("active_track_id"),
    startedAtMs: timestamp("started_at_ms"),
    lastSeenAtMs: timestamp("last_seen_at_ms"),
    expiresAtMs: integer("expires_at_ms").notNull(),
    closedAtMs: nullableTimestamp("closed_at_ms"),
    errorCode: text("error_code"),
  },
  (table) => [
    foreignKey({
      name: "playback_sessions_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "playback_sessions_device_fk",
      columns: [table.deviceId, table.userId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "playback_sessions_track_fk",
      columns: [table.activeTrackId],
      foreignColumns: [tracks.id],
    }).onDelete("set null"),
    uniqueIndex("playback_sessions_grant_hash_uq").on(table.grantTokenHash),
    index("playback_sessions_device_state_idx").on(table.deviceId, table.state),
    index("playback_sessions_user_expiry_idx").on(table.userId, table.expiresAtMs),
    check(
      "playback_sessions_state_chk",
      sql`${table.state} in ('idle', 'playing', 'paused', 'buffering', 'ended', 'error')`,
    ),
    check("playback_sessions_expiry_chk", sql`${table.expiresAtMs} > ${table.startedAtMs}`),
    check("playback_sessions_seen_chk", sql`${table.lastSeenAtMs} >= ${table.startedAtMs}`),
    check(
      "playback_sessions_closed_chk",
      sql`${table.closedAtMs} is null or (${table.closedAtMs} >= ${table.startedAtMs} and ${table.closedAtMs} <= ${table.expiresAtMs})`,
    ),
    check(
      "playback_sessions_error_code_chk",
      sql`${table.errorCode} is null or ${table.errorCode} glob '[A-Z0-9_]*'`,
    ),
  ],
);

export const playbackGrants = sqliteTable(
  "playback_grants",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    trackId: text("track_id").notNull(),
    canSeek: integer("can_seek", { mode: "boolean" }).notNull().default(true),
    canSkip: integer("can_skip", { mode: "boolean" }).notNull().default(false),
    maxBitrateKbps: integer("max_bitrate_kbps"),
    expiresAtMs: integer("expires_at_ms").notNull(),
  },
  (table) => [
    foreignKey({
      name: "playback_grants_session_fk",
      columns: [table.sessionId],
      foreignColumns: [playbackSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "playback_grants_track_fk",
      columns: [table.trackId],
      foreignColumns: [tracks.id],
    }).onDelete("cascade"),
    uniqueIndex("playback_grants_session_track_uq").on(table.sessionId, table.trackId),
    index("playback_grants_track_idx").on(table.trackId),
    check(
      "playback_grants_bitrate_chk",
      sql`${table.maxBitrateKbps} is null or ${table.maxBitrateKbps} > 0`,
    ),
  ],
);

export const playbackProgress = sqliteTable(
  "playback_progress",
  {
    sessionId: text("session_id").notNull(),
    trackId: text("track_id").notNull(),
    positionMs: integer("position_ms").notNull().default(0),
    durationMs: integer("duration_ms"),
    updatedAtMs: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "playback_progress_session_fk",
      columns: [table.sessionId],
      foreignColumns: [playbackSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "playback_progress_track_fk",
      columns: [table.trackId],
      foreignColumns: [tracks.id],
    }).onDelete("cascade"),
    primaryKey({ name: "playback_progress_pk", columns: [table.sessionId, table.trackId] }),
    index("playback_progress_track_updated_idx").on(table.trackId, table.updatedAtMs),
    check("playback_progress_position_chk", sql`${table.positionMs} >= 0`),
    check(
      "playback_progress_duration_chk",
      sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
    ),
    check(
      "playback_progress_bounds_chk",
      sql`${table.durationMs} is null or ${table.positionMs} <= ${table.durationMs}`,
    ),
  ],
);

export const scanRuns = sqliteTable(
  "scan_runs",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("queued"),
    startedAtMs: nullableTimestamp("started_at_ms"),
    finishedAtMs: nullableTimestamp("finished_at_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAtMs: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "scan_runs_library_fk",
      columns: [table.libraryId],
      foreignColumns: [libraries.id],
    }).onDelete("cascade"),
    index("scan_runs_library_created_idx").on(table.libraryId, table.createdAtMs),
    index("scan_runs_status_idx").on(table.status, table.createdAtMs),
    check("scan_runs_mode_chk", sql`${table.mode} in ('full', 'incremental', 'refresh')`),
    check(
      "scan_runs_status_chk",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "scan_runs_started_chk",
      sql`${table.startedAtMs} is null or ${table.startedAtMs} >= ${table.createdAtMs}`,
    ),
    check(
      "scan_runs_finished_chk",
      sql`${table.finishedAtMs} is null or (${table.startedAtMs} is not null and ${table.finishedAtMs} >= ${table.startedAtMs})`,
    ),
  ],
);

export const scanJobs = sqliteTable(
  "scan_jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    parentJobId: text("parent_job_id"),
    sourceId: text("source_id"),
    dedupeKey: text("dedupe_key").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAtMs: timestamp("available_at_ms"),
    lockedAtMs: nullableTimestamp("locked_at_ms"),
    lockedBy: text("locked_by"),
    startedAtMs: nullableTimestamp("started_at_ms"),
    finishedAtMs: nullableTimestamp("finished_at_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    foreignKey({
      name: "scan_jobs_run_fk",
      columns: [table.runId],
      foreignColumns: [scanRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "scan_jobs_parent_fk",
      columns: [table.parentJobId],
      foreignColumns: [table.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "scan_jobs_source_fk",
      columns: [table.sourceId],
      foreignColumns: [mediaSources.id],
    }).onDelete("cascade"),
    uniqueIndex("scan_jobs_run_dedupe_uq").on(table.runId, table.dedupeKey),
    index("scan_jobs_claim_idx").on(table.status, table.priority, table.availableAtMs),
    index("scan_jobs_run_status_idx").on(table.runId, table.status),
    check(
      "scan_jobs_operation_chk",
      sql`${table.operation} in ('discover', 'probe', 'artwork', 'metadata', 'analyze', 'cleanup')`,
    ),
    check(
      "scan_jobs_status_chk",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check("scan_jobs_priority_chk", sql`${table.priority} between 0 and 1000`),
    check(
      "scan_jobs_attempts_chk",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} between 1 and 20 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check("scan_jobs_lock_chk", sql`(${table.lockedAtMs} is null) = (${table.lockedBy} is null)`),
    check(
      "scan_jobs_started_chk",
      sql`${table.startedAtMs} is null or ${table.startedAtMs} >= ${table.availableAtMs}`,
    ),
    check(
      "scan_jobs_finished_chk",
      sql`${table.finishedAtMs} is null or (${table.startedAtMs} is not null and ${table.finishedAtMs} >= ${table.startedAtMs})`,
    ),
  ],
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAtMs: timestamp("available_at_ms"),
    lockedAtMs: nullableTimestamp("locked_at_ms"),
    publishedAtMs: nullableTimestamp("published_at_ms"),
    lastError: text("last_error"),
    createdAtMs: createdAt(),
  },
  (table) => [
    index("outbox_events_claim_idx").on(table.status, table.availableAtMs),
    index("outbox_events_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId,
      table.createdAtMs,
    ),
    check(
      "outbox_events_status_chk",
      sql`${table.status} in ('pending', 'processing', 'published', 'failed')`,
    ),
    check("outbox_events_attempts_chk", sql`${table.attempts} >= 0`),
    check("outbox_events_payload_json_chk", sql`json_valid(${table.payloadJson})`),
    check(
      "outbox_events_published_chk",
      sql`${table.publishedAtMs} is null or (${table.status} = 'published' and ${table.publishedAtMs} >= ${table.createdAtMs})`,
    ),
  ],
);

export const schema = {
  users,
  devices,
  authSessions,
  refreshTokens,
  libraries,
  libraryRoots,
  libraryGrants,
  mediaSources,
  streams,
  chapters,
  streamSidecars,
  artists,
  albums,
  tracks,
  trackArtists,
  albumArtists,
  trackMetadata,
  artwork,
  artworkAssignments,
  watchStates,
  favorites,
  playbackSessions,
  playbackGrants,
  playbackProgress,
  scanRuns,
  scanJobs,
  outboxEvents,
};
