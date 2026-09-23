CREATE TABLE `media_source_availability` (
	`source_id` text PRIMARY KEY,
	`is_available` integer DEFAULT true NOT NULL,
	`last_seen_at_ms` integer,
	`missing_since_ms` integer,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `media_source_availability_source_fk` FOREIGN KEY (`source_id`) REFERENCES `media_sources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `media_source_availability_state_idx` ON `media_source_availability` (`is_available`,`updated_at_ms`);