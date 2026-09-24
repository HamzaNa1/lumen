CREATE TABLE IF NOT EXISTS `catalog_item_artwork` (
	`item_id` text NOT NULL,
	`role` text NOT NULL,
	`artwork_id` text NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `catalog_item_artwork_pk` PRIMARY KEY(`item_id`, `role`),
	CONSTRAINT `fk_catalog_item_artwork_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_catalog_item_artwork_artwork_id_artwork_id_fk` FOREIGN KEY (`artwork_id`) REFERENCES `artwork`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `catalog_item_metadata` (
	`item_id` text PRIMARY KEY,
	`release_date` text,
	`content_rating` text,
	`community_rating` real,
	`genres_json` text DEFAULT '[]' NOT NULL,
	`studios_json` text DEFAULT '[]' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`external_ids_json` text DEFAULT '{}' NOT NULL,
	`field_sources_json` text DEFAULT '{}' NOT NULL,
	`locked_fields_json` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `fk_catalog_item_metadata_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `catalog_item_origins` (
	`item_id` text PRIMARY KEY,
	`root_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `fk_catalog_item_origins_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_catalog_item_origins_root_id_library_roots_id_fk` FOREIGN KEY (`root_id`) REFERENCES `library_roots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `catalog_item_origins_path_uq` ON `catalog_item_origins` (`root_id`,`relative_path`,`kind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `catalog_item_origins_root_idx` ON `catalog_item_origins` (`root_id`);
