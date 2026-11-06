ALTER TABLE `scan_runs` ADD `stats_json` text;--> statement-breakpoint
ALTER TABLE `scan_runs` ADD `files_pruned_at_ms` integer;--> statement-breakpoint
ALTER TABLE `scan_runs` ADD `jobs_pruned_at_ms` integer;--> statement-breakpoint
CREATE INDEX `server_scan_seen_source_idx` ON `server_scan_seen` (`source_id`);--> statement-breakpoint
CREATE INDEX `scan_jobs_source_idx` ON `scan_jobs` (`source_id`);--> statement-breakpoint
CREATE INDEX `scan_jobs_parent_idx` ON `scan_jobs` (`parent_job_id`);--> statement-breakpoint
CREATE INDEX `scan_jobs_run_source_operation_idx` ON `scan_jobs` (`run_id`,`source_id`,`operation`);--> statement-breakpoint
CREATE INDEX `scan_runs_files_retention_idx` ON `scan_runs` (`files_pruned_at_ms`,`finished_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `scan_runs_jobs_retention_idx` ON `scan_runs` (`jobs_pruned_at_ms`,`finished_at_ms`,`id`) WHERE "scan_runs"."files_pruned_at_ms" is not null and "scan_runs"."stats_json" is not null;--> statement-breakpoint
CREATE INDEX `scan_runs_finished_idx` ON `scan_runs` (`finished_at_ms`,`id`) WHERE "scan_runs"."files_pruned_at_ms" is not null and "scan_runs"."jobs_pruned_at_ms" is not null;