DROP INDEX `items_source_external_uniq`;--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_external_uniq` ON `items` (`source_id`,`external_id`);