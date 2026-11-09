CREATE TABLE `download_grants` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`track_id` text NOT NULL,
	`item_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	CONSTRAINT `fk_download_grants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_download_grants_track_id_tracks_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_download_grants_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `download_grants_device_fk` FOREIGN KEY (`device_id`,`user_id`) REFERENCES `devices`(`id`,`user_id`) ON DELETE CASCADE,
	CONSTRAINT "download_grants_expiry_chk" CHECK("expires_at_ms" > "created_at_ms")
);
--> statement-breakpoint
ALTER TABLE `users` ADD `can_download` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `download_grants_token_hash_uq` ON `download_grants` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `download_grants_device_track_uq` ON `download_grants` (`device_id`,`track_id`);--> statement-breakpoint
CREATE INDEX `download_grants_user_idx` ON `download_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `download_grants_track_idx` ON `download_grants` (`track_id`);--> statement-breakpoint
ALTER TABLE `library_grants` DROP COLUMN `can_download`;