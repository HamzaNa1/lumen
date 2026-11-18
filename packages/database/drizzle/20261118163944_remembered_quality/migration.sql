ALTER TABLE `media_track_overrides` ADD `quality` text;--> statement-breakpoint
ALTER TABLE `user_track_preferences` ADD `quality` text DEFAULT 'original' NOT NULL;