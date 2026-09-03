CREATE TABLE `catalog_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`application_name` text NOT NULL,
	`blueprint_id` text NOT NULL,
	`release` text NOT NULL,
	`blueprint_digest` text NOT NULL,
	`installed_spec_digest` text NOT NULL,
	`current_spec_digest` text NOT NULL,
	`site_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`drifted_addresses` text DEFAULT '[]' NOT NULL,
	`local_blueprint_id` text,
	`last_operation_id` text,
	`failure` text,
	`data_retained` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_catalog_installations_application` ON `catalog_installations` (`application_name`);--> statement-breakpoint
CREATE INDEX `idx_catalog_installations_blueprint` ON `catalog_installations` (`blueprint_id`,`release`);--> statement-breakpoint
CREATE INDEX `idx_catalog_installations_state` ON `catalog_installations` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `catalog_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`application_name` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`plan` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`actor` text NOT NULL,
	`retain_data` integer,
	`recovery_point_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_catalog_operations_installation` ON `catalog_operations` (`installation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_catalog_operations_state` ON `catalog_operations` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `catalog_recovery_points` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`application_name` text NOT NULL,
	`site_id` text NOT NULL,
	`release` text NOT NULL,
	`spec_digest` text NOT NULL,
	`status` text NOT NULL,
	`artifact_reference` text,
	`artifact_digest` text,
	`verification` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`verified_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_catalog_recovery_points_installation` ON `catalog_recovery_points` (`installation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_catalog_recovery_points_verification` ON `catalog_recovery_points` (`installation_id`,`status`);