CREATE TABLE `application_configuration_values` (
	`deployment_name` text NOT NULL,
	`spec_digest` text NOT NULL,
	`key` text NOT NULL,
	`site_id` text DEFAULT '' NOT NULL,
	`value_type` text NOT NULL,
	`value` text NOT NULL,
	`value_digest` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`deployment_name`, `spec_digest`, `key`, `site_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_application_configuration_deployment` ON `application_configuration_values` (`deployment_name`,`spec_digest`,`site_id`);--> statement-breakpoint
CREATE TABLE `application_spec_revisions` (
	`digest` text NOT NULL,
	`deployment_name` text NOT NULL,
	`parent_digest` text,
	`api_version` text NOT NULL,
	`source` text NOT NULL,
	`manifest_format` text NOT NULL,
	`normalized_spec` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`deployment_name`, `digest`)
);
--> statement-breakpoint
CREATE INDEX `idx_application_spec_revisions_deployment` ON `application_spec_revisions` (`deployment_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_application_spec_revisions_parent` ON `application_spec_revisions` (`parent_digest`);--> statement-breakpoint
CREATE TABLE `application_spec_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deployment_name` text NOT NULL,
	`from_digest` text,
	`to_digest` text NOT NULL,
	`source` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_application_spec_transitions_deployment` ON `application_spec_transitions` (`deployment_name`,`id`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `desired_spec_digest` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `active_spec_digest` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `configuration_digest` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `spec_source` text;