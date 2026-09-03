DROP INDEX `idx_app_replicas_app_site`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_app_replicas_app_site` ON `app_replicas` (`app_id`,`site_id`);