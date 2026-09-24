CREATE TABLE `metadata_provider_settings` (
	`provider` text PRIMARY KEY,
	`api_key` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
