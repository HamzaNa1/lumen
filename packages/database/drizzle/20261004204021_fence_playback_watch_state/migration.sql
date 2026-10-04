CREATE TABLE `server_playback_watch_versions` (
	`session_id` text NOT NULL,
	`track_id` text NOT NULL,
	`item_id` text NOT NULL,
	`manual_version` integer NOT NULL,
	CONSTRAINT `server_playback_watch_versions_pk` PRIMARY KEY(`session_id`, `track_id`),
	CONSTRAINT `fk_server_playback_watch_versions_session_id_playback_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `playback_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_server_playback_watch_versions_track_id_tracks_id_fk` FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_server_playback_watch_versions_item_id_catalog_items_id_fk` FOREIGN KEY (`item_id`) REFERENCES `catalog_items`(`id`) ON DELETE CASCADE
);
