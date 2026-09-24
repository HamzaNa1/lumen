DROP INDEX IF EXISTS `artwork_library_hash_kind_uq`;--> statement-breakpoint
CREATE INDEX `artwork_library_hash_kind_idx` ON `artwork` (`library_id`,`content_hash`,`kind`);