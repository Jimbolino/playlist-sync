DELETE FROM `items`
WHERE `external_id` IS NOT NULL
  AND `id` NOT IN (
    SELECT MIN(`id`)
    FROM `items`
    WHERE `external_id` IS NOT NULL
    GROUP BY `source_id`, `external_id`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_external_uniq` ON `items` (`source_id`,`external_id`);
