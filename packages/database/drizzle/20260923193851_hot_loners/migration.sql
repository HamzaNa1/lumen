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
CREATE UNIQUE INDEX `provider_records_provider_item_uq` ON `provider_records` (`item_id`,`provider`,`provider_item_id`);--> statement-breakpoint
CREATE INDEX `server_audit_events_created_idx` ON `server_audit_events` (`created_at_ms`);