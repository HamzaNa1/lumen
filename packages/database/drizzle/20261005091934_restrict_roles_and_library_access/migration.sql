PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_library_grants` (
	`id` text PRIMARY KEY,
	`library_id` text NOT NULL,
	`user_id` text NOT NULL,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`can_download` integer DEFAULT false NOT NULL,
	`expires_at_ms` integer,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `library_grants_library_fk` FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `library_grants_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "library_grants_capabilities_json_chk" CHECK(json_valid("capabilities_json")),
	CONSTRAINT "library_grants_expiry_chk" CHECK("expires_at_ms" is null or "expires_at_ms" > "created_at_ms"),
	CONSTRAINT "library_grants_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
INSERT INTO `__new_library_grants`(`id`, `library_id`, `user_id`, `capabilities_json`, `can_download`, `expires_at_ms`, `created_at_ms`, `updated_at_ms`) SELECT `id`, `library_id`, `user_id`, `capabilities_json`, `can_download`, `expires_at_ms`, `created_at_ms`, `updated_at_ms` FROM `library_grants`;--> statement-breakpoint
DROP TABLE `library_grants`;--> statement-breakpoint
ALTER TABLE `__new_library_grants` RENAME TO `library_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY,
	`username` text NOT NULL,
	`username_normalized` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`all_libraries` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "users_username_nonempty_chk" CHECK(length(trim("username")) > 0),
	CONSTRAINT "users_username_normalized_chk" CHECK(length("username_normalized") > 0 and "username_normalized" not glob '*[^a-z0-9._-]*'),
	CONSTRAINT "users_display_name_nonempty_chk" CHECK(length(trim("display_name")) > 0),
	CONSTRAINT "users_role_chk" CHECK("role" in ('admin', 'user')),
	CONSTRAINT "users_timestamps_chk" CHECK("updated_at_ms" >= "created_at_ms")
);
--> statement-breakpoint
INSERT INTO `__new_users`(`id`, `username`, `username_normalized`, `display_name`, `password_hash`, `role`, `is_active`, `created_at_ms`, `updated_at_ms`) SELECT `id`, `username`, `username_normalized`, `display_name`, `password_hash`, CASE `role` WHEN 'guest' THEN 'user' ELSE `role` END, `is_active`, `created_at_ms`, `updated_at_ms` FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `library_grants_library_user_uq` ON `library_grants` (`library_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `library_grants_user_idx` ON `library_grants` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_normalized_uq` ON `users` (`username_normalized`);