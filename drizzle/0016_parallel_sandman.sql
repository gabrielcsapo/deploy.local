ALTER TABLE `backups` ADD `related_build_log_id` integer;--> statement-breakpoint
ALTER TABLE `backups` ADD `auto` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `history` ADD `build_log_id` integer;--> statement-breakpoint
ALTER TABLE `history` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `history` ADD `source` text;