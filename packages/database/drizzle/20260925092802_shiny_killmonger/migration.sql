CREATE TABLE `album_artists` (
	`album_id` text NOT NULL,
	`artist_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`role` text DEFAULT 'primary' NOT NULL,
	CONSTRAINT `album_artists_pk` PRIMARY KEY(`album_id`, `artist_id`, `role`),
	CONSTRAINT `album_artists_album_fk` FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON DELETE CASCADE,
	CONSTRAINT `album_artists_artist_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON DELETE CASCADE,
	CONSTRAINT "album_artists_ordinal_chk" CHECK("ordinal" >= 0),
	CONSTRAINT "album_artists_role_chk" CHECK("role" in ('primary', 'featured', 'composer', 'conductor', 'remixer', 'other'))
);
--> statement-breakpoint
CREATE TABLE `albums` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`album_artist_id` text,
	`release_date` text,
	`original_release_date` text,
	`release_year` integer,
	`barcode` text,
	`external_ids_json` text DEFAULT '{}' NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `albums_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `albums_artist_fk` FOREIGN KEY (`album_artist_id`,`library_id`) REFERENCES `artists`(`id`,`library_id`) ON DELETE RESTRICT,
	CONSTRAINT "albums_title_chk" CHECK(length(trim("title")) > 0),
	CONSTRAINT "albums_normalized_title_chk" CHECK(length(trim("normalized_title")) > 0),
	CONSTRAINT "albums_release_year_chk" CHECK("release_year" is null or "release_year" between 0 and 9999),
	CONSTRAINT "albums_external_ids_json_chk" CHECK(json_valid("external_ids_json")),
	CONSTRAINT "albums_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `artists` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`sort_name` text,
	`external_ids_json` text DEFAULT '{}' NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `artists_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "artists_name_chk" CHECK(length(trim("name")) > 0),
	CONSTRAINT "artists_normalized_name_chk" CHECK(length(trim("normalized_name")) > 0),
	CONSTRAINT "artists_external_ids_json_chk" CHECK(json_valid("external_ids_json")),
	CONSTRAINT "artists_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `artwork` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`source_id` text,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`content_hash` text NOT NULL,
	`relative_path` text NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `artwork_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `artwork_source_fk` FOREIGN KEY (`source_id`,`library_id`) REFERENCES `media_sources`(`id`,`library_id`) ON DELETE RESTRICT,
	CONSTRAINT "artwork_kind_chk" CHECK("kind" in ('front', 'back', 'disc', 'artist', 'other')),
	CONSTRAINT "artwork_mime_type_chk" CHECK(length(trim("mime_type")) > 0),
	CONSTRAINT "artwork_dimensions_chk" CHECK("width" > 0 and "height" > 0),
	CONSTRAINT "artwork_byte_size_chk" CHECK("byte_size" >= 0),
	CONSTRAINT "artwork_hash_chk" CHECK(length("content_hash") = 64 and "content_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "artwork_path_chk" CHECK(length(trim("relative_path")) > 0)
);
--> statement-breakpoint
CREATE TABLE `artwork_assignments` (
	`artwork_id` text NOT NULL,
	`album_id` text,
	`artist_id` text,
	`track_id` text,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	CONSTRAINT `artwork_assignments_artwork_fk` FOREIGN KEY (`artwork_id`) REFERENCES `artwork`(`id`) ON DELETE CASCADE,
	CONSTRAINT `artwork_assignments_album_fk` FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON DELETE CASCADE,
	CONSTRAINT `artwork_assignments_artist_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON DELETE CASCADE,
	CONSTRAINT `artwork_assignments_track_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "artwork_assignments_target_chk" CHECK(("album_id" is not null) + ("artist_id" is not null) + ("track_id" is not null) = 1),
	CONSTRAINT "artwork_assignments_ordinal_chk" CHECK("ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`session_token_hash` text NOT NULL,
	`issued_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	CONSTRAINT `auth_sessions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `auth_sessions_device_fk` FOREIGN KEY (`device_id`,`user_id`) REFERENCES `devices`(`id`,`user_id`) ON DELETE CASCADE,
	CONSTRAINT "auth_sessions_token_hash_chk" CHECK(length("session_token_hash") = 64 and "session_token_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "auth_sessions_expiry_chk" CHECK("expires_at_ms" > "issued_at_ms"),
	CONSTRAINT "auth_sessions_usage_chk" CHECK("last_used_at_ms" >= "issued_at_ms" and ("revoked_at_ms" is null or "revoked_at_ms" >= "issued_at_ms"))
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY,
	`stream_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	CONSTRAINT `chapters_stream_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chapters_ordinal_chk" CHECK("ordinal" >= 0),
	CONSTRAINT "chapters_title_chk" CHECK(length(trim("title")) > 0),
	CONSTRAINT "chapters_timing_chk" CHECK("start_ms" >= 0 and "end_ms" > "start_ms")
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`platform_device_id` text,
	`last_seen_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`revoked_at_ms` integer,
	CONSTRAINT `devices_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "devices_name_nonempty_chk" CHECK(length(trim("name")) > 0),
	CONSTRAINT "devices_platform_chk" CHECK("platform" in ('web', 'desktop', 'ios', 'android', 'other')),
	CONSTRAINT "devices_revoked_chk" CHECK("revoked_at_ms" is null or "revoked_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `favorites` (
	`user_id` text NOT NULL,
	`track_id` text NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `favorites_pk` PRIMARY KEY(`user_id`, `track_id`),
	CONSTRAINT `favorites_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `favorites_track_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "libraries_name_nonempty_chk" CHECK(length(trim("name")) > 0),
	CONSTRAINT "libraries_slug_chk" CHECK("slug" not glob '*[^a-z0-9-]*' and "slug" not glob '--*' and "slug" not glob '*-' and "slug" not glob '-*'),
	CONSTRAINT "libraries_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `library_grants` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`can_download` integer DEFAULT false NOT NULL,
	`expires_at_ms` integer,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `library_grants_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `library_grants_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "library_grants_role_chk" CHECK("role" in ('admin', 'user', 'guest')),
	CONSTRAINT "library_grants_capabilities_json_chk" CHECK(json_valid("capabilities_json")),
	CONSTRAINT "library_grants_expiry_chk" CHECK("expires_at_ms" is null or "expires_at_ms" > "created_at_ms"),
	CONSTRAINT "library_grants_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `library_roots` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`path` text NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `library_roots_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "library_roots_path_absolute_chk" CHECK(length(trim("path")) > 0),
	CONSTRAINT "library_roots_priority_chk" CHECK("priority" >= 0),
	CONSTRAINT "library_roots_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `media_sources` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`root_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`absolute_path` text NOT NULL,
	`kind` text DEFAULT 'local' NOT NULL,
	`file_size_bytes` integer,
	`modified_at_ms` integer,
	`inode` text,
	`content_fingerprint` text,
	`scanned_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `media_sources_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `media_sources_root_fk` FOREIGN KEY (`root_id`,`library_id`) REFERENCES `library_roots`(`id`,`library_id`) ON DELETE CASCADE,
	CONSTRAINT "media_sources_kind_chk" CHECK("kind" in ('local', 'smb', 'nfs', 'remote')),
	CONSTRAINT "media_sources_relative_path_chk" CHECK(length(trim("relative_path")) > 0),
	CONSTRAINT "media_sources_absolute_path_chk" CHECK(length(trim("absolute_path")) > 0),
	CONSTRAINT "media_sources_size_chk" CHECK("file_size_bytes" is null or "file_size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`locked_at_ms` integer,
	`published_at_ms` integer,
	`last_error` text,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "outbox_events_status_chk" CHECK("status" in ('pending', 'processing', 'published', 'failed')),
	CONSTRAINT "outbox_events_attempts_chk" CHECK("attempts" >= 0),
	CONSTRAINT "outbox_events_payload_json_chk" CHECK(json_valid("payload_json")),
	CONSTRAINT "outbox_events_published_chk" CHECK("published_at_ms" is null or ("status" = 'published' and "published_at_ms" >= "created_at_ms"))
);
--> statement-breakpoint
CREATE TABLE `playback_grants` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`track_id` text NOT NULL,
	`can_seek` integer DEFAULT true NOT NULL,
	`can_skip` integer DEFAULT false NOT NULL,
	`max_bitrate_kbps` integer,
	`expires_at_ms` integer NOT NULL,
	CONSTRAINT `playback_grants_session_fk` FOREIGN KEY (`session_id`) REFERENCES `playback_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `playback_grants_track_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "playback_grants_bitrate_chk" CHECK("max_bitrate_kbps" is null or "max_bitrate_kbps" > 0)
);
--> statement-breakpoint
CREATE TABLE `playback_progress` (
	`session_id` text NOT NULL,
	`track_id` text NOT NULL,
	`position_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `playback_progress_pk` PRIMARY KEY(`session_id`, `track_id`),
	CONSTRAINT `playback_progress_session_fk` FOREIGN KEY (`session_id`) REFERENCES `playback_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `playback_progress_track_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "playback_progress_position_chk" CHECK("position_ms" >= 0),
	CONSTRAINT "playback_progress_duration_chk" CHECK("duration_ms" is null or "duration_ms" >= 0),
	CONSTRAINT "playback_progress_bounds_chk" CHECK("duration_ms" is null or "position_ms" <= "duration_ms")
);
--> statement-breakpoint
CREATE TABLE `playback_sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`grant_token_hash` text NOT NULL,
	`active_track_id` text,
	`started_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`closed_at_ms` integer,
	`error_code` text,
	CONSTRAINT `playback_sessions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `playback_sessions_device_fk` FOREIGN KEY (`device_id`,`user_id`) REFERENCES `devices`(`id`,`user_id`) ON DELETE CASCADE,
	CONSTRAINT `playback_sessions_track_fk` FOREIGN KEY (`active_track_id`) REFERENCES `tracks`(`id`) ON DELETE SET NULL,
	CONSTRAINT "playback_sessions_state_chk" CHECK("state" in ('idle', 'playing', 'paused', 'buffering', 'ended', 'error')),
	CONSTRAINT "playback_sessions_expiry_chk" CHECK("expires_at_ms" > "started_at_ms"),
	CONSTRAINT "playback_sessions_seen_chk" CHECK("last_seen_at_ms" >= "started_at_ms"),
	CONSTRAINT "playback_sessions_closed_chk" CHECK("closed_at_ms" is null or ("closed_at_ms" >= "started_at_ms" and "closed_at_ms" <= "expires_at_ms")),
	CONSTRAINT "playback_sessions_error_code_chk" CHECK("error_code" is null or "error_code" glob '[A-Z0-9_]*')
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`family_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`issued_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`used_at_ms` integer,
	`revoked_at_ms` integer,
	`replaced_by_token_id` text,
	CONSTRAINT `refresh_tokens_session_fk` FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `refresh_tokens_replacement_fk` FOREIGN KEY (`replaced_by_token_id`) REFERENCES `refresh_tokens`(`id`) ON DELETE SET NULL,
	CONSTRAINT "refresh_tokens_hash_chk" CHECK(length("token_hash") = 64 and "token_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "refresh_tokens_generation_chk" CHECK("generation" >= 0),
	CONSTRAINT "refresh_tokens_expiry_chk" CHECK("expires_at_ms" > "issued_at_ms"),
	CONSTRAINT "refresh_tokens_usage_chk" CHECK(("used_at_ms" is null or "used_at_ms" >= "issued_at_ms") and ("revoked_at_ms" is null or "revoked_at_ms" >= "issued_at_ms"))
);
--> statement-breakpoint
CREATE TABLE `scan_jobs` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`parent_job_id` text,
	`source_id` text,
	`dedupe_key` text NOT NULL,
	`operation` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`available_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`locked_at_ms` integer,
	`locked_by` text,
	`started_at_ms` integer,
	`finished_at_ms` integer,
	`error_code` text,
	`error_message` text,
	CONSTRAINT `scan_jobs_run_fk` FOREIGN KEY (`run_id`) REFERENCES `scan_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `scan_jobs_parent_fk` FOREIGN KEY (`parent_job_id`) REFERENCES `scan_jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `scan_jobs_source_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE,
	CONSTRAINT "scan_jobs_operation_chk" CHECK("operation" in ('discover', 'probe', 'artwork', 'metadata', 'analyze', 'cleanup')),
	CONSTRAINT "scan_jobs_status_chk" CHECK("status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "scan_jobs_priority_chk" CHECK("priority" between 0 and 1000),
	CONSTRAINT "scan_jobs_attempts_chk" CHECK("attempts" >= 0 and "max_attempts" between 1 and 20 and "attempts" <= "max_attempts"),
	CONSTRAINT "scan_jobs_lock_chk" CHECK(("locked_at_ms" is null) = ("locked_by" is null)),
	CONSTRAINT "scan_jobs_started_chk" CHECK("started_at_ms" is null or "started_at_ms" >= "available_at_ms"),
	CONSTRAINT "scan_jobs_finished_chk" CHECK("finished_at_ms" is null or ("started_at_ms" is not null and "finished_at_ms" >= "started_at_ms"))
);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at_ms` integer,
	`finished_at_ms` integer,
	`error_code` text,
	`error_message` text,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `scan_runs_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "scan_runs_mode_chk" CHECK("mode" in ('full', 'incremental', 'refresh')),
	CONSTRAINT "scan_runs_status_chk" CHECK("status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "scan_runs_started_chk" CHECK("started_at_ms" is null or "started_at_ms" >= "created_at_ms"),
	CONSTRAINT "scan_runs_finished_chk" CHECK("finished_at_ms" is null or ("started_at_ms" is not null and "finished_at_ms" >= "started_at_ms"))
);
--> statement-breakpoint
CREATE TABLE `stream_sidecars` (
	`id` text PRIMARY KEY,
	`stream_id` text NOT NULL,
	`kind` text NOT NULL,
	`relative_path` text NOT NULL,
	`media_type` text,
	`content_hash` text NOT NULL,
	CONSTRAINT `stream_sidecars_stream_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`id`) ON DELETE CASCADE,
	CONSTRAINT "stream_sidecars_kind_chk" CHECK("kind" in ('cue', 'nfo', 'lyrics', 'chapters', 'artwork', 'other')),
	CONSTRAINT "stream_sidecars_path_chk" CHECK(length(trim("relative_path")) > 0),
	CONSTRAINT "stream_sidecars_hash_chk" CHECK(length("content_hash") = 64 and "content_hash" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `streams` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`container` text,
	`codec` text,
	`language` text,
	`title` text,
	`ordinal` integer,
	`is_default` integer DEFAULT false NOT NULL,
	`bitrate` integer,
	`sample_rate_hz` integer,
	`channels` integer,
	`width` integer,
	`height` integer,
	CONSTRAINT `streams_source_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE,
	CONSTRAINT "streams_kind_chk" CHECK("kind" in ('audio', 'video', 'subtitle')),
	CONSTRAINT "streams_ordinal_chk" CHECK("ordinal" is null or "ordinal" >= 0),
	CONSTRAINT "streams_bitrate_chk" CHECK("bitrate" is null or "bitrate" >= 0),
	CONSTRAINT "streams_sample_rate_chk" CHECK("sample_rate_hz" is null or "sample_rate_hz" > 0),
	CONSTRAINT "streams_channels_chk" CHECK("channels" is null or "channels" > 0),
	CONSTRAINT "streams_dimensions_chk" CHECK(("width" is null or "width" > 0) and ("height" is null or "height" > 0))
);
--> statement-breakpoint
CREATE TABLE `track_artists` (
	`track_id` text NOT NULL,
	`artist_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`role` text DEFAULT 'primary' NOT NULL,
	CONSTRAINT `track_artists_pk` PRIMARY KEY(`track_id`, `artist_id`, `role`),
	CONSTRAINT `track_artists_track_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `track_artists_artist_fk` FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON DELETE CASCADE,
	CONSTRAINT "track_artists_ordinal_chk" CHECK("ordinal" >= 0),
	CONSTRAINT "track_artists_role_chk" CHECK("role" in ('primary', 'featured', 'composer', 'conductor', 'remixer', 'other'))
);
--> statement-breakpoint
CREATE TABLE `track_metadata` (
	`track_id` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`language` text,
	`source_id` text,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `track_metadata_pk` PRIMARY KEY(`track_id`, `namespace`, `key`, `language`),
	CONSTRAINT `track_metadata_track_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `track_metadata_source_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE SET NULL,
	CONSTRAINT "track_metadata_namespace_chk" CHECK("namespace" in ('core', 'technical', 'tag', 'external', 'analysis')),
	CONSTRAINT "track_metadata_key_chk" CHECK(length(trim("key")) > 0),
	CONSTRAINT "track_metadata_value_json_chk" CHECK(json_valid("value_json"))
);
--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`source_id` text NOT NULL,
	`primary_stream_id` text NOT NULL,
	`album_id` text,
	`title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`track_number` integer,
	`disc_number` integer,
	`duration_ms` integer,
	`is_explicit` integer DEFAULT false NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `tracks_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `tracks_source_fk` FOREIGN KEY (`source_id`,`library_id`) REFERENCES `media_sources`(`id`,`library_id`) ON DELETE CASCADE,
	CONSTRAINT `tracks_primary_stream_fk` FOREIGN KEY (`primary_stream_id`,`source_id`) REFERENCES `streams`(`id`,`source_id`) ON DELETE CASCADE,
	CONSTRAINT `tracks_album_fk` FOREIGN KEY (`album_id`,`library_id`) REFERENCES `albums`(`id`,`library_id`) ON DELETE RESTRICT,
	CONSTRAINT "tracks_title_chk" CHECK(length(trim("title")) > 0),
	CONSTRAINT "tracks_normalized_title_chk" CHECK(length(trim("normalized_title")) > 0),
	CONSTRAINT "tracks_numbers_chk" CHECK(("track_number" is null or "track_number" >= 0) and ("disc_number" is null or "disc_number" >= 0)),
	CONSTRAINT "tracks_duration_chk" CHECK("duration_ms" is null or "duration_ms" >= 0),
	CONSTRAINT "tracks_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`username` text NOT NULL,
	`username_normalized` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "users_username_nonempty_chk" CHECK(length(trim("username")) > 0),
	CONSTRAINT "users_username_normalized_chk" CHECK(length("username_normalized") > 0 and "username_normalized" not glob '*[^a-z0-9._-]*'),
	CONSTRAINT "users_display_name_nonempty_chk" CHECK(length(trim("display_name")) > 0),
	CONSTRAINT "users_role_chk" CHECK("role" in ('admin', 'user', 'guest')),
	CONSTRAINT "users_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
CREATE TABLE `watch_states` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`track_id` text NOT NULL,
	`position_ms` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `watch_states_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `watch_states_track_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "watch_states_position_chk" CHECK("position_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE `catalog_item_artwork` (
	`item_id` text NOT NULL,
	`role` text NOT NULL,
	`artwork_id` text NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `catalog_item_artwork_pk` PRIMARY KEY(`item_id`, `role`),
	CONSTRAINT `fk_catalog_item_artwork_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_catalog_item_artwork_artwork_id_artwork_id_fk` FOREIGN KEY (`artwork_id`) REFERENCES `artwork`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `catalog_item_metadata` (
	`item_id` text PRIMARY KEY,
	`release_date` text,
	`content_rating` text,
	`community_rating` real,
	`genres_json` text DEFAULT '[]' NOT NULL,
	`studios_json` text DEFAULT '[]' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`external_ids_json` text DEFAULT '{}' NOT NULL,
	`field_sources_json` text DEFAULT '{}' NOT NULL,
	`locked_fields_json` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `fk_catalog_item_metadata_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `catalog_item_origins` (
	`item_id` text PRIMARY KEY,
	`root_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `fk_catalog_item_origins_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_catalog_item_origins_root_id_library_roots_id_fk` FOREIGN KEY (`root_id`) REFERENCES `library_roots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `catalog_item_outbox` (
	`event_id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`item_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `catalog_item_outbox_event_fk` FOREIGN KEY (`event_id`) REFERENCES `outbox_events`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `catalog_item_parents` (
	`parent_id` text NOT NULL,
	`child_id` text NOT NULL,
	CONSTRAINT `catalog_item_parents_pk` PRIMARY KEY(`parent_id`, `child_id`),
	CONSTRAINT `catalog_item_parents_parent_fk` FOREIGN KEY (`parent_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `catalog_item_parents_child_fk` FOREIGN KEY (`child_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT "catalog_item_parents_identity_chk" CHECK("parent_id" <> "child_id")
);
--> statement-breakpoint
CREATE TABLE `catalog_item_sources` (
	`item_id` text NOT NULL,
	`source_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`source_generation` integer DEFAULT 1 NOT NULL,
	`version_label` text,
	CONSTRAINT `catalog_item_sources_pk` PRIMARY KEY(`item_id`, `source_id`),
	CONSTRAINT `catalog_item_sources_item_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `catalog_item_sources_source_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE,
	CONSTRAINT "catalog_item_sources_generation_chk" CHECK("source_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE `catalog_items` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`sort_title` text NOT NULL,
	`original_title` text,
	`overview` text,
	`year` integer,
	`index_number` integer,
	`duration_seconds` integer,
	`metadata_state` text DEFAULT 'local' NOT NULL,
	`added_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `catalog_items_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "catalog_items_kind_chk" CHECK("kind" in ('movie', 'show', 'season', 'episode', 'artist', 'album', 'track')),
	CONSTRAINT "catalog_items_parent_fk" CHECK("parent_id" is null or "parent_id" <> "id"),
	CONSTRAINT "catalog_items_year_chk" CHECK("year" is null or "year" between 1800 and 9999),
	CONSTRAINT "catalog_items_index_chk" CHECK("index_number" is null or "index_number" >= 0),
	CONSTRAINT "catalog_items_duration_chk" CHECK("duration_seconds" is null or "duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE `direct_playback_progress` (
	`session_id` text PRIMARY KEY,
	`item_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`position_seconds` integer NOT NULL,
	`duration_seconds` integer,
	`is_ended` integer DEFAULT false NOT NULL,
	`accepted_at_ms` integer NOT NULL,
	CONSTRAINT `direct_playback_progress_session_fk` FOREIGN KEY (`session_id`) REFERENCES `direct_playback_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `direct_playback_progress_item_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT "direct_playback_progress_sequence_chk" CHECK("sequence" > 0),
	CONSTRAINT "direct_playback_progress_position_chk" CHECK("position_seconds" >= 0),
	CONSTRAINT "direct_playback_progress_duration_chk" CHECK("duration_seconds" is null or "duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE `direct_playback_sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`item_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_generation` integer NOT NULL,
	`grant_token_hash` text NOT NULL,
	`state` text DEFAULT 'playing' NOT NULL,
	`last_accepted_sequence` integer DEFAULT 0 NOT NULL,
	`ownership_generation` integer NOT NULL,
	`started_at_ms` integer NOT NULL,
	`last_heartbeat_at_ms` integer NOT NULL,
	`grant_expires_at_ms` integer NOT NULL,
	`hard_expires_at_ms` integer NOT NULL,
	`closed_at_ms` integer,
	CONSTRAINT `direct_playback_sessions_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `direct_playback_sessions_item_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `direct_playback_sessions_source_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE,
	CONSTRAINT "direct_playback_sessions_state_chk" CHECK("state" in ('playing', 'paused', 'buffering', 'ended', 'error', 'closed')),
	CONSTRAINT "direct_playback_sessions_generation_chk" CHECK("source_generation" > 0),
	CONSTRAINT "direct_playback_sessions_sequence_chk" CHECK("last_accepted_sequence" >= 0),
	CONSTRAINT "direct_playback_sessions_ownership_chk" CHECK("ownership_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE `item_favorites` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT `item_favorites_pk` PRIMARY KEY(`user_id`, `item_id`),
	CONSTRAINT `item_favorites_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `item_favorites_item_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `item_watch_states` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position_seconds` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`ownership_generation` integer DEFAULT 1 NOT NULL,
	`manual_version` integer DEFAULT 0 NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `item_watch_states_pk` PRIMARY KEY(`user_id`, `item_id`),
	CONSTRAINT `item_watch_states_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `item_watch_states_item_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT "item_watch_states_position_chk" CHECK("position_seconds" >= 0),
	CONSTRAINT "item_watch_states_generation_chk" CHECK("ownership_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`next_run_at_ms` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`last_error_code` text,
	`last_error_message` text,
	CONSTRAINT "jobs_state_chk" CHECK("state" in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_payload_json_chk" CHECK(json_valid("payload_json")),
	CONSTRAINT "jobs_attempts_chk" CHECK("attempts" >= 0 and "max_attempts" between 1 and 20),
	CONSTRAINT "jobs_lease_chk" CHECK(("lease_owner" is null) = ("lease_expires_at_ms" is null))
);
--> statement-breakpoint
CREATE TABLE `library_profiles` (
	`library_id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`scan_mode` text DEFAULT 'incremental' NOT NULL,
	`last_scan_at_ms` integer,
	CONSTRAINT `library_profiles_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "library_profiles_kind_chk" CHECK("kind" in ('movies', 'shows', 'music')),
	CONSTRAINT "library_profiles_scan_mode_chk" CHECK("scan_mode" in ('full', 'incremental', 'refresh'))
);
--> statement-breakpoint
CREATE TABLE `library_root_states` (
	`root_id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`canonical_path` text NOT NULL,
	`canonical_key` text NOT NULL,
	`is_available` integer DEFAULT true NOT NULL,
	`unavailable_reason` text,
	`scan_generation` integer DEFAULT 0 NOT NULL,
	`last_seen_at_ms` integer,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `library_root_states_root_fk` FOREIGN KEY (`root_id`,`library_id`) REFERENCES `library_roots`(`id`,`library_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `media_source_availability` (
	`source_id` text PRIMARY KEY,
	`is_available` integer DEFAULT true NOT NULL,
	`last_seen_at_ms` integer,
	`missing_since_ms` integer,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `media_source_availability_source_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metadata_provider_settings` (
	`provider` text PRIMARY KEY,
	`api_key` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_records` (
	`id` text PRIMARY KEY,
	`item_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_item_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`confidence` integer NOT NULL,
	`fetched_at_ms` integer NOT NULL,
	`locked_fields_json` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `provider_records_item_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT "provider_records_payload_json_chk" CHECK(json_valid("payload_json")),
	CONSTRAINT "provider_records_locks_json_chk" CHECK(json_valid("locked_fields_json")),
	CONSTRAINT "provider_records_confidence_chk" CHECK("confidence" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE `server_audit_events` (
	`id` text PRIMARY KEY,
	`actor_user_id` text,
	`event_type` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT "server_audit_events_json_chk" CHECK(json_valid("detail_json"))
);
--> statement-breakpoint
CREATE TABLE `server_event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`created_at_ms` integer NOT NULL,
	`topic` text NOT NULL,
	`user_id` text,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `server_identity` (
	`singleton` integer PRIMARY KEY,
	`installation_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "server_identity_singleton_chk" CHECK("singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `server_library_watch_state` (
	`root_id` text PRIMARY KEY,
	`modified_at_ms` integer NOT NULL,
	`checked_at_ms` integer NOT NULL,
	CONSTRAINT `fk_server_library_watch_state_root_id_library_roots_id_fk` FOREIGN KEY (`root_id`) REFERENCES `library_roots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `server_playback_sequences` (
	`session_id` text NOT NULL,
	`track_id` text NOT NULL,
	`sequence` integer NOT NULL,
	CONSTRAINT `server_playback_sequences_pk` PRIMARY KEY(`session_id`, `track_id`),
	CONSTRAINT `fk_server_playback_sequences_session_id_playback_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `playback_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_server_playback_sequences_track_id_tracks_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `server_scan_seen` (
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`seen_at_ms` integer NOT NULL,
	CONSTRAINT `server_scan_seen_pk` PRIMARY KEY(`run_id`, `source_id`),
	CONSTRAINT `fk_server_scan_seen_run_id_scan_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `scan_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_server_scan_seen_source_id_media_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `server_scheduled_jobs` (
	`name` text PRIMARY KEY,
	`interval_ms` integer NOT NULL,
	`next_run_at_ms` integer NOT NULL,
	`last_started_at_ms` integer,
	`last_finished_at_ms` integer,
	`last_error` text,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "server_scheduled_jobs_interval_chk" CHECK("interval_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE `server_settings` (
	`id` integer PRIMARY KEY,
	`server_id` text NOT NULL,
	`display_name` text NOT NULL,
	`api_version` text DEFAULT '1.0.0' NOT NULL,
	`schema_version` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `album_artists_role_ordinal_uq` ON `album_artists` (`album_id`,`role`,`ordinal`);--> statement-breakpoint
CREATE INDEX `album_artists_artist_idx` ON `album_artists` (`artist_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `albums_id_library_uq` ON `albums` (`id`,`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `albums_library_normalized_title_artist_uq` ON `albums` (`library_id`,`normalized_title`,coalesce("album_artist_id", ''));--> statement-breakpoint
CREATE INDEX `albums_library_title_idx` ON `albums` (`library_id`,`title`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_id_library_uq` ON `artists` (`id`,`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_library_normalized_name_uq` ON `artists` (`library_id`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `artists_library_sort_name_idx` ON `artists` (`library_id`,`sort_name`);--> statement-breakpoint
CREATE INDEX `artwork_library_hash_kind_idx` ON `artwork` (`library_id`,`content_hash`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `artwork_library_path_uq` ON `artwork` (`library_id`,`relative_path`);--> statement-breakpoint
CREATE INDEX `artwork_source_idx` ON `artwork` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artwork_assignments_target_uq` ON `artwork_assignments` (`album_id`,`artist_id`,`track_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `artwork_assignments_primary_uq` ON `artwork_assignments` (`album_id`,`artist_id`,`track_id`) WHERE "artwork_assignments"."is_primary" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_hash_uq` ON `auth_sessions` (`session_token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_expiry_idx` ON `auth_sessions` (`user_id`,`expires_at_ms`);--> statement-breakpoint
CREATE INDEX `auth_sessions_device_idx` ON `auth_sessions` (`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chapters_stream_ordinal_uq` ON `chapters` (`stream_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_id_user_uq` ON `devices` (`id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_user_platform_device_uq` ON `devices` (`user_id`,`platform`,`platform_device_id`) WHERE "devices"."platform_device_id" is not null;--> statement-breakpoint
CREATE INDEX `devices_user_active_idx` ON `devices` (`user_id`,`revoked_at_ms`);--> statement-breakpoint
CREATE INDEX `favorites_user_created_idx` ON `favorites` (`user_id`,`created_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_slug_uq` ON `libraries` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_grants_library_user_uq` ON `library_grants` (`library_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `library_grants_user_idx` ON `library_grants` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_roots_id_library_uq` ON `library_roots` (`id`,`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_roots_path_uq` ON `library_roots` (`path`);--> statement-breakpoint
CREATE INDEX `library_roots_library_priority_idx` ON `library_roots` (`library_id`,`priority`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_sources_id_library_uq` ON `media_sources` (`id`,`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_sources_absolute_path_uq` ON `media_sources` (`absolute_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_sources_library_relative_path_uq` ON `media_sources` (`library_id`,`relative_path`);--> statement-breakpoint
CREATE INDEX `media_sources_library_scanned_idx` ON `media_sources` (`library_id`,`scanned_at_ms`);--> statement-breakpoint
CREATE INDEX `media_sources_fingerprint_idx` ON `media_sources` (`content_fingerprint`);--> statement-breakpoint
CREATE INDEX `outbox_events_claim_idx` ON `outbox_events` (`status`,`available_at_ms`);--> statement-breakpoint
CREATE INDEX `outbox_events_aggregate_idx` ON `outbox_events` (`aggregate_type`,`aggregate_id`,`created_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `playback_grants_session_track_uq` ON `playback_grants` (`session_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `playback_grants_track_idx` ON `playback_grants` (`track_id`);--> statement-breakpoint
CREATE INDEX `playback_progress_track_updated_idx` ON `playback_progress` (`track_id`,`updated_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `playback_sessions_grant_hash_uq` ON `playback_sessions` (`grant_token_hash`);--> statement-breakpoint
CREATE INDEX `playback_sessions_device_state_idx` ON `playback_sessions` (`device_id`,`state`);--> statement-breakpoint
CREATE INDEX `playback_sessions_user_expiry_idx` ON `playback_sessions` (`user_id`,`expires_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_hash_uq` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_family_generation_idx` ON `refresh_tokens` (`family_id`,`generation`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_session_idx` ON `refresh_tokens` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scan_jobs_run_dedupe_uq` ON `scan_jobs` (`run_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `scan_jobs_claim_idx` ON `scan_jobs` (`status`,`priority`,`available_at_ms`);--> statement-breakpoint
CREATE INDEX `scan_jobs_run_status_idx` ON `scan_jobs` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `scan_runs_library_created_idx` ON `scan_runs` (`library_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `scan_runs_status_idx` ON `scan_runs` (`status`,`created_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `stream_sidecars_stream_kind_path_uq` ON `stream_sidecars` (`stream_id`,`kind`,`relative_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `stream_sidecars_content_hash_uq` ON `stream_sidecars` (`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `streams_id_source_uq` ON `streams` (`id`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `streams_source_ordinal_uq` ON `streams` (`source_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `streams_source_default_uq` ON `streams` (`source_id`,`kind`) WHERE "streams"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `streams_source_kind_ordinal_idx` ON `streams` (`source_id`,`kind`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `track_artists_role_ordinal_uq` ON `track_artists` (`track_id`,`role`,`ordinal`);--> statement-breakpoint
CREATE INDEX `track_artists_artist_idx` ON `track_artists` (`artist_id`);--> statement-breakpoint
CREATE INDEX `track_metadata_source_idx` ON `track_metadata` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `track_metadata_identity_uq` ON `track_metadata` (`track_id`,`namespace`,`key`,coalesce("language", ''));--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_id_library_uq` ON `tracks` (`id`,`library_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_primary_stream_uq` ON `tracks` (`primary_stream_id`);--> statement-breakpoint
CREATE INDEX `tracks_library_album_disc_track_idx` ON `tracks` (`library_id`,`album_id`,`disc_number`,`track_number`);--> statement-breakpoint
CREATE INDEX `tracks_source_idx` ON `tracks` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_normalized_uq` ON `users` (`username_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `watch_states_user_track_uq` ON `watch_states` (`user_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `watch_states_user_updated_idx` ON `watch_states` (`user_id`,`updated_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_item_origins_path_uq` ON `catalog_item_origins` (`root_id`,`relative_path`,`kind`);--> statement-breakpoint
CREATE INDEX `catalog_item_origins_root_idx` ON `catalog_item_origins` (`root_id`);--> statement-breakpoint
CREATE INDEX `catalog_item_outbox_item_idx` ON `catalog_item_outbox` (`library_id`,`item_id`,`created_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_item_sources_primary_uq` ON `catalog_item_sources` (`item_id`) WHERE "catalog_item_sources"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `catalog_item_sources_source_idx` ON `catalog_item_sources` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_items_id_library_uq` ON `catalog_items` (`id`,`library_id`);--> statement-breakpoint
CREATE INDEX `catalog_items_browse_idx` ON `catalog_items` (`library_id`,`kind`,`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `catalog_items_recent_idx` ON `catalog_items` (`library_id`,`added_at_ms`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `direct_playback_sessions_grant_hash_uq` ON `direct_playback_sessions` (`grant_token_hash`);--> statement-breakpoint
CREATE INDEX `direct_playback_sessions_user_item_idx` ON `direct_playback_sessions` (`user_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `direct_playback_sessions_device_idx` ON `direct_playback_sessions` (`device_id`,`state`);--> statement-breakpoint
CREATE INDEX `item_favorites_created_idx` ON `item_favorites` (`user_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `item_watch_states_continue_idx` ON `item_watch_states` (`user_id`,`updated_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_uq` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`state`,`next_run_at_ms`,`lease_expires_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `library_root_states_canonical_key_uq` ON `library_root_states` (`canonical_key`);--> statement-breakpoint
CREATE INDEX `library_root_states_library_idx` ON `library_root_states` (`library_id`);--> statement-breakpoint
CREATE INDEX `media_source_availability_state_idx` ON `media_source_availability` (`is_available`,`updated_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_records_provider_item_uq` ON `provider_records` (`item_id`,`provider`,`provider_item_id`);--> statement-breakpoint
CREATE INDEX `server_audit_events_created_idx` ON `server_audit_events` (`created_at_ms`);--> statement-breakpoint
CREATE INDEX `server_event_log_user_id_idx` ON `server_event_log` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `server_scheduled_jobs_due_idx` ON `server_scheduled_jobs` (`next_run_at_ms`);--> statement-breakpoint
CREATE TRIGGER `catalog_items_parent_library_insert` BEFORE INSERT ON `catalog_items`
WHEN NEW.`parent_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `catalog_items` parent
	WHERE parent.`id` = NEW.`parent_id` AND parent.`library_id` = NEW.`library_id`
)
BEGIN SELECT RAISE(ABORT, 'catalog parent must belong to the same library'); END;
--> statement-breakpoint
CREATE TRIGGER `catalog_items_parent_library_update` BEFORE UPDATE OF `parent_id`, `library_id` ON `catalog_items`
WHEN NEW.`parent_id` IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `catalog_items` parent
	WHERE parent.`id` = NEW.`parent_id` AND parent.`library_id` = NEW.`library_id`
)
BEGIN SELECT RAISE(ABORT, 'catalog parent must belong to the same library'); END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `catalog_fts` USING fts5(
	`entity_type` UNINDEXED,
	`entity_id` UNINDEXED,
	`title`,
	`subtitle`,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `artists_fts_insert` AFTER INSERT ON `artists` BEGIN
	INSERT INTO `catalog_fts` (`entity_type`, `entity_id`, `title`, `subtitle`)
	VALUES ('artist', NEW.`id`, NEW.`name`, NEW.`sort_name`);
END;
--> statement-breakpoint
CREATE TRIGGER `artists_fts_delete` AFTER DELETE ON `artists` BEGIN
	DELETE FROM `catalog_fts` WHERE `entity_type` = 'artist' AND `entity_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `artists_fts_update` AFTER UPDATE ON `artists` BEGIN
	DELETE FROM `catalog_fts` WHERE `entity_type` = 'artist' AND `entity_id` = OLD.`id`;
	INSERT INTO `catalog_fts` (`entity_type`, `entity_id`, `title`, `subtitle`)
	VALUES ('artist', NEW.`id`, NEW.`name`, NEW.`sort_name`);
END;
--> statement-breakpoint
CREATE TRIGGER `albums_fts_insert` AFTER INSERT ON `albums` BEGIN
	INSERT INTO `catalog_fts` (`entity_type`, `entity_id`, `title`, `subtitle`)
	VALUES (
		'album',
		NEW.`id`,
		NEW.`title`,
		COALESCE((SELECT `name` FROM `artists` WHERE `id` = NEW.`album_artist_id`), '')
	);
END;
--> statement-breakpoint
CREATE TRIGGER `albums_fts_delete` AFTER DELETE ON `albums` BEGIN
	DELETE FROM `catalog_fts` WHERE `entity_type` = 'album' AND `entity_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `albums_fts_update` AFTER UPDATE ON `albums` BEGIN
	DELETE FROM `catalog_fts` WHERE `entity_type` = 'album' AND `entity_id` = OLD.`id`;
	INSERT INTO `catalog_fts` (`entity_type`, `entity_id`, `title`, `subtitle`)
	VALUES (
		'album',
		NEW.`id`,
		NEW.`title`,
		COALESCE((SELECT `name` FROM `artists` WHERE `id` = NEW.`album_artist_id`), '')
	);
END;
--> statement-breakpoint
CREATE TRIGGER `tracks_fts_insert` AFTER INSERT ON `tracks` BEGIN
	INSERT INTO `catalog_fts` (`entity_type`, `entity_id`, `title`, `subtitle`)
	VALUES (
		'track',
		NEW.`id`,
		NEW.`title`,
		COALESCE((SELECT `title` FROM `albums` WHERE `id` = NEW.`album_id`), '')
	);
END;
--> statement-breakpoint
CREATE TRIGGER `tracks_fts_delete` AFTER DELETE ON `tracks` BEGIN
	DELETE FROM `catalog_fts` WHERE `entity_type` = 'track' AND `entity_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `tracks_fts_update` AFTER UPDATE ON `tracks` BEGIN
	DELETE FROM `catalog_fts` WHERE `entity_type` = 'track' AND `entity_id` = OLD.`id`;
	INSERT INTO `catalog_fts` (`entity_type`, `entity_id`, `title`, `subtitle`)
	VALUES (
		'track',
		NEW.`id`,
		NEW.`title`,
		COALESCE((SELECT `title` FROM `albums` WHERE `id` = NEW.`album_id`), '')
	);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `catalog_item_fts` USING fts5(
	`item_id` UNINDEXED,
	`library_id` UNINDEXED,
	`title`,
	`subtitle`,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `catalog_items_fts_insert` AFTER INSERT ON `catalog_items` BEGIN
	INSERT INTO `catalog_item_fts` (`item_id`, `library_id`, `title`, `subtitle`)
	VALUES (NEW.`id`, NEW.`library_id`, NEW.`title`, COALESCE(NEW.`original_title`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_items_fts_update` AFTER UPDATE ON `catalog_items` BEGIN
	DELETE FROM `catalog_item_fts` WHERE `item_id` = OLD.`id`;
	INSERT INTO `catalog_item_fts` (`item_id`, `library_id`, `title`, `subtitle`)
	VALUES (NEW.`id`, NEW.`library_id`, NEW.`title`, COALESCE(NEW.`original_title`, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `catalog_items_fts_delete` AFTER DELETE ON `catalog_items` BEGIN
	DELETE FROM `catalog_item_fts` WHERE `item_id` = OLD.`id`;
END;
