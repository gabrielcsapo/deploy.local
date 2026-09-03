CREATE TABLE `component_profile_volume_bindings` (
	`app_id` text NOT NULL,
	`site_id` text NOT NULL,
	`component_key` text NOT NULL,
	`resource_key` text NOT NULL,
	`active_provider_volume` text NOT NULL,
	`rollback_provider_volume` text,
	`active_operation_id` text NOT NULL,
	`rollback_operation_id` text,
	`active_spec_digest` text NOT NULL,
	`rollback_spec_digest` text,
	`artifact_digest` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `site_id`, `component_key`, `resource_key`)
);
--> statement-breakpoint
CREATE TABLE `volume_authority_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`source_site_id` text NOT NULL,
	`target_site_id` text NOT NULL,
	`state` text NOT NULL,
	`expected_snapshot_id` text,
	`expected_authority_epoch` integer NOT NULL,
	`expected_data_sequence` integer NOT NULL,
	`snapshot_id` text,
	`snapshot_authority_epoch` integer,
	`snapshot_data_sequence` integer,
	`manifest_artifact_digest` text,
	`requested_by` text NOT NULL,
	`request_event_id` text,
	`snapshot_event_id` text,
	`target_ready_event_id` text,
	`commit_event_id` text,
	`terminal_event_id` text,
	`source_resumed` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`error` text,
	`requested_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_volume_authority_transfers_app_state` ON `volume_authority_transfers` (`app_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_volume_authority_transfers_site_state` ON `volume_authority_transfers` (`source_site_id`,`target_site_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_volume_authority_transfers_one_active_app`
  ON `volume_authority_transfers` (`app_id`)
  WHERE `state` IN ('requested', 'source-capturing', 'snapshot-ready', 'target-restoring', 'target-ready');--> statement-breakpoint
ALTER TABLE `component_profile_operations` ADD `artifact_media_type` text;--> statement-breakpoint
ALTER TABLE `component_profile_operations` ADD `source_spec_digest` text;--> statement-breakpoint
ALTER TABLE `component_profile_operations` ADD `target_spec_digest` text;--> statement-breakpoint
ALTER TABLE `component_profile_operations` ADD `source_volume` text;--> statement-breakpoint
ALTER TABLE `component_profile_operations` ADD `target_volume` text;--> statement-breakpoint
ALTER TABLE `component_profile_operations` ADD `rollback_volume` text;--> statement-breakpoint
ALTER TABLE `component_profile_operations` ADD `evidence` text DEFAULT '{}' NOT NULL;
