CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`source_id` integer,
	`external_id` text,
	`canonical_url` text,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`extracted_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `scrape_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `items_run_idx` ON `items` (`run_id`);--> statement-breakpoint
CREATE INDEX `items_hash_idx` ON `items` (`payload_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `items_run_payload_hash_uniq` ON `items` (`run_id`,`payload_hash`);--> statement-breakpoint
CREATE TABLE `scrape_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer,
	`seed_url` text NOT NULL,
	`adapter_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`item_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scrape_runs_adapter_idx` ON `scrape_runs` (`adapter_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`adapter_id` text NOT NULL,
	`base_url_pattern` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sources_adapter_idx` ON `sources` (`adapter_id`);