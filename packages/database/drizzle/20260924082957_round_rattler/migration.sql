ALTER TABLE `streams` ADD `title` text;--> statement-breakpoint
ALTER TABLE `streams` ADD `ordinal` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `streams_source_kind_language_uq`;--> statement-breakpoint
DROP INDEX IF EXISTS `streams_source_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `streams_source_default_uq`;--> statement-breakpoint
UPDATE `streams` SET `is_default` = 0 WHERE `kind` <> 'audio';--> statement-breakpoint
CREATE UNIQUE INDEX `streams_source_ordinal_uq` ON `streams` (`source_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `streams_source_default_uq` ON `streams` (`source_id`,`kind`) WHERE "streams"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `streams_source_kind_ordinal_idx` ON `streams` (`source_id`,`kind`,`ordinal`);--> statement-breakpoint
CREATE TRIGGER `streams_ordinal_insert_chk` BEFORE INSERT ON `streams` WHEN NEW.`ordinal` < 0 BEGIN SELECT RAISE(ABORT, 'streams_ordinal_chk'); END;--> statement-breakpoint
CREATE TRIGGER `streams_ordinal_update_chk` BEFORE UPDATE OF `ordinal` ON `streams` WHEN NEW.`ordinal` < 0 BEGIN SELECT RAISE(ABORT, 'streams_ordinal_chk'); END;--> statement-breakpoint
UPDATE `scan_jobs` SET
  `status` = 'queued',
  `attempts` = 0,
  `available_at_ms` = unixepoch() * 1000,
  `locked_at_ms` = NULL,
  `locked_by` = NULL,
  `started_at_ms` = NULL,
  `finished_at_ms` = NULL,
  `error_code` = NULL,
  `error_message` = NULL
WHERE `status` IN ('failed', 'succeeded')
  AND `operation` IN ('probe', 'metadata', 'artwork', 'analyze')
  AND `source_id` IS NOT NULL
  AND (
    NOT EXISTS (SELECT 1 FROM `tracks` WHERE `tracks`.`source_id` = `scan_jobs`.`source_id`)
    OR EXISTS (SELECT 1 FROM `streams` WHERE `streams`.`source_id` = `scan_jobs`.`source_id` AND `streams`.`ordinal` IS NULL)
  );