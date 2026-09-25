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
CREATE VIRTUAL TABLE `catalog_item_fts` USING fts5(
	`item_id` UNINDEXED,
	`library_id` UNINDEXED,
	`title`,
	`subtitle`,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `catalog_item_fts` (`item_id`, `library_id`, `title`, `subtitle`)
SELECT `id`, `library_id`, `title`, COALESCE(`original_title`, '') FROM `catalog_items`;
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
