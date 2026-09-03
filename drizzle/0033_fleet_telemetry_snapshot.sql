CREATE TABLE `fleet_telemetry_records` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_id` text NOT NULL,
	`origin_site_id` text NOT NULL,
	`origin_sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`app_id` text,
	`deployment_name` text NOT NULL,
	`logical_key` text NOT NULL,
	`observed_at` text NOT NULL,
	`payload` text NOT NULL,
	`artifact_digests` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fleet_telemetry_origin_sequence` ON `fleet_telemetry_records` (`origin_site_id`,`origin_sequence`);--> statement-breakpoint
CREATE INDEX `idx_fleet_telemetry_logical` ON `fleet_telemetry_records` (`origin_site_id`,`kind`,`logical_key`,`origin_sequence`);--> statement-breakpoint
CREATE INDEX `idx_fleet_telemetry_app` ON `fleet_telemetry_records` (`deployment_name`,`kind`,`observed_at`);