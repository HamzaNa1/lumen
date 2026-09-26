CREATE TABLE `user_home_preferences` (
	`user_id` text PRIMARY KEY,
	`preferences_json` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT `fk_user_home_preferences_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "user_home_preferences_json_chk" CHECK(json_valid("preferences_json"))
);
