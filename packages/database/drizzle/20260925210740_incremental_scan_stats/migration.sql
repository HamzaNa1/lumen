CREATE TABLE `server_scan_missing` (
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`missing_at_ms` integer NOT NULL,
	CONSTRAINT `server_scan_missing_pk` PRIMARY KEY(`run_id`, `source_id`),
	CONSTRAINT `fk_server_scan_missing_run_id_scan_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `scan_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_server_scan_missing_source_id_media_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `server_scan_seen` ADD `change` text DEFAULT 'unchanged' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_server_scan_seen` (
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`seen_at_ms` integer NOT NULL,
	`change` text DEFAULT 'unchanged' NOT NULL,
	CONSTRAINT `server_scan_seen_pk` PRIMARY KEY(`run_id`, `source_id`),
	CONSTRAINT `fk_server_scan_seen_run_id_scan_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `scan_runs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_server_scan_seen_source_id_media_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE,
	CONSTRAINT "server_scan_seen_change_chk" CHECK("change" in ('new', 'changed', 'moved', 'unchanged'))
);
--> statement-breakpoint
INSERT INTO `__new_server_scan_seen`(`run_id`, `source_id`, `seen_at_ms`) SELECT `run_id`, `source_id`, `seen_at_ms` FROM `server_scan_seen`;--> statement-breakpoint
DROP TABLE `server_scan_seen`;--> statement-breakpoint
ALTER TABLE `__new_server_scan_seen` RENAME TO `server_scan_seen`;--> statement-breakpoint
PRAGMA foreign_keys=ON;