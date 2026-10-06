CREATE TABLE `media_track_overrides` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`audio_json` text,
	`subtitle_json` text,
	CONSTRAINT `media_track_overrides_pk` PRIMARY KEY(`user_id`, `item_id`),
	CONSTRAINT `fk_media_track_overrides_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_media_track_overrides_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user_track_preferences` (
	`user_id` text PRIMARY KEY,
	`audio_language` text DEFAULT 'en' NOT NULL,
	`subtitle_language` text,
	CONSTRAINT `fk_user_track_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `streams` ADD `commentary` integer;--> statement-breakpoint
ALTER TABLE `streams` ADD `forced` integer;--> statement-breakpoint
ALTER TABLE `streams` ADD `hearing_impaired` integer;