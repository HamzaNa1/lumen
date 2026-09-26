CREATE TABLE `series_episode_orders` (
	`item_id` text PRIMARY KEY,
	`tmdb_series_id` text NOT NULL,
	`group_id` text NOT NULL,
	CONSTRAINT `fk_series_episode_orders_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE
);
