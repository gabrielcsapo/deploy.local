CREATE TABLE `component_site_overrides` (
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`site_id` text NOT NULL,
	`component_key` text NOT NULL,
	`instances` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`app_id`, `site_id`, `component_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_component_site_overrides_deployment` ON `component_site_overrides` (`deployment_name`,`site_id`);--> statement-breakpoint
ALTER TABLE `application_spec_revisions` ADD `original_artifact_digest` text;--> statement-breakpoint
ALTER TABLE `application_spec_revisions` ADD `normalized_artifact_digest` text;--> statement-breakpoint
ALTER TABLE `component_placements` ADD `default_instances` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `component_placements` ADD `minimum_ready` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `component_placements` ADD `rollout_strategy` text DEFAULT 'rolling' NOT NULL;--> statement-breakpoint
ALTER TABLE `component_placements` ADD `max_surge` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `component_placements` ADD `max_unavailable` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `component_placements` ADD `placement_intent` text DEFAULT 'coLocate' NOT NULL;--> statement-breakpoint
ALTER TABLE `component_placements` ADD `capacity` text DEFAULT '{}' NOT NULL;
