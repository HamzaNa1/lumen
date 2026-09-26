PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_server_scan_missing` (
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`missing_at_ms` integer NOT NULL,
	CONSTRAINT `server_scan_missing_pk` PRIMARY KEY(`run_id`, `source_id`),
	CONSTRAINT `fk_server_scan_missing_run_id_scan_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `scan_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_server_scan_missing`(`run_id`, `source_id`, `missing_at_ms`) SELECT `run_id`, `source_id`, `missing_at_ms` FROM `server_scan_missing`;--> statement-breakpoint
DROP TABLE `server_scan_missing`;--> statement-breakpoint
ALTER TABLE `__new_server_scan_missing` RENAME TO `server_scan_missing`;--> statement-breakpoint
PRAGMA foreign_keys=ON;