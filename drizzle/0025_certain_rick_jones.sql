CREATE TABLE `app_materialization` (
	`app_id` text NOT NULL,
	`site_id` text NOT NULL,
	`capability` text NOT NULL,
	`desired_digest` text,
	`available_digest` text,
	`desired_generation` integer,
	`available_generation` integer,
	`state` text NOT NULL,
	`blockers` text DEFAULT '[]' NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`verified_at` text,
	PRIMARY KEY(`app_id`, `site_id`, `capability`)
);
--> statement-breakpoint
CREATE TABLE `app_replicas` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`site_id` text NOT NULL,
	`active_release_digest` text,
	`desired_release_digest` text,
	`runtime_status` text DEFAULT 'pending' NOT NULL,
	`data_mode` text DEFAULT 'single-site' NOT NULL,
	`sync_policy` text DEFAULT 'none' NOT NULL,
	`shared_lineage` integer DEFAULT false NOT NULL,
	`schema_fingerprint` text,
	`profile_version` text,
	`base_checkpoint_id` text,
	`branch_checkpoint_id` text,
	`pending_changesets` integer DEFAULT 0 NOT NULL,
	`pending_blobs` integer DEFAULT 0 NOT NULL,
	`conflict_count` integer DEFAULT 0 NOT NULL,
	`readiness` text DEFAULT '{}' NOT NULL,
	`last_policy_event_id` text,
	`last_contact_at` integer,
	`removed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_app_replicas_app_site` ON `app_replicas` (`app_id`,`site_id`);--> statement-breakpoint
CREATE TABLE `artifact_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`source_site_id` text NOT NULL,
	`destination_site_id` text NOT NULL,
	`digest` text NOT NULL,
	`expected_size` integer NOT NULL,
	`verified_offset` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`temporary_path` text,
	`error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`digest` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`media_type` text NOT NULL,
	`architecture` text,
	`local_path` text NOT NULL,
	`verification_status` text NOT NULL,
	`created_by_event_id` text,
	`retention_class` text DEFAULT 'temporary' NOT NULL,
	`pin_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`last_access_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blob_references` (
	`app_id` text NOT NULL,
	`logical_path` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`digest` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`marker` text DEFAULT 'present' NOT NULL,
	`conflict_state` text,
	PRIMARY KEY(`app_id`, `logical_path`, `checkpoint_id`)
);
--> statement-breakpoint
CREATE TABLE `data_changesets` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`origin_site_id` text NOT NULL,
	`base_checkpoint_id` text NOT NULL,
	`branch_manifest_digest` text NOT NULL,
	`schema_fingerprint` text,
	`database_artifact_digest` text,
	`file_delta_artifact_digest` text,
	`authenticated_digest` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`conflict_report` text,
	`resulting_checkpoint_id` text,
	`created_at` text NOT NULL,
	`verified_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_data_changesets_app_status` ON `data_changesets` (`app_id`,`status`);--> statement-breakpoint
CREATE TABLE `data_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`parent_id` text,
	`origin_site_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`database_artifact_digest` text,
	`filesystem_artifact_digest` text,
	`manifest_artifact_digest` text NOT NULL,
	`schema_fingerprint` text,
	`profile_version` text,
	`verification_status` text NOT NULL,
	`acknowledgements` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_data_checkpoints_app_sequence` ON `data_checkpoints` (`app_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `data_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`changeset_id` text,
	`kind` text NOT NULL,
	`logical_address` text NOT NULL,
	`base_value` text,
	`home_value` text,
	`suitcase_value` text,
	`resolution` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_data_conflicts_app_status` ON `data_conflicts` (`app_id`,`status`);--> statement-breakpoint
CREATE TABLE `data_reconciliation_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` text NOT NULL,
	`analyzer_version` text NOT NULL,
	`schema_fingerprint` text,
	`sqlite_files` text DEFAULT '[]' NOT NULL,
	`eligible_tables` text DEFAULT '[]' NOT NULL,
	`excluded_tables` text DEFAULT '[]' NOT NULL,
	`upload_paths` text DEFAULT '[]' NOT NULL,
	`opaque_paths` text DEFAULT '[]' NOT NULL,
	`conflict_policy` text DEFAULT 'collect' NOT NULL,
	`compatibility_digest` text NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fleet_events` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_id` text NOT NULL,
	`origin_site_id` text NOT NULL,
	`origin_sequence` integer NOT NULL,
	`app_id` text,
	`authority_epoch` integer,
	`generation` integer,
	`actor` text NOT NULL,
	`operation` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL,
	`artifact_digests` text DEFAULT '[]' NOT NULL,
	`parent_event_id` text,
	`authenticated_digest` text NOT NULL,
	`created_at` text NOT NULL,
	`applied_at` text,
	`rejection_reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_fleet_events_origin` ON `fleet_events` (`origin_site_id`,`origin_sequence`);--> statement-breakpoint
CREATE INDEX `idx_fleet_events_app_generation` ON `fleet_events` (`app_id`,`authority_epoch`,`generation`);--> statement-breakpoint
CREATE TABLE `fleet_recovery_bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_id` text NOT NULL,
	`format_version` integer NOT NULL,
	`artifact_digest` text NOT NULL,
	`encryption_metadata` text NOT NULL,
	`inventory_digest` text NOT NULL,
	`verification_status` text NOT NULL,
	`rehearsal_status` text,
	`created_at` text NOT NULL,
	`verified_at` text,
	`rehearsed_at` text
);
--> statement-breakpoint
CREATE TABLE `fleets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`root_public_identity` text NOT NULL,
	`home_site_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `portability_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`spec_digest` text NOT NULL,
	`site_id` text NOT NULL,
	`analyzer_version` text NOT NULL,
	`classification` text NOT NULL,
	`capability_vector` text NOT NULL,
	`findings` text NOT NULL,
	`evidence` text NOT NULL,
	`profile_digest` text,
	`created_at` text NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_portability_reports_app_site` ON `portability_reports` (`app_id`,`site_id`);--> statement-breakpoint
CREATE TABLE `release_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`origin_site_id` text NOT NULL,
	`actor` text NOT NULL,
	`base_authority_epoch` integer NOT NULL,
	`base_generation` integer NOT NULL,
	`source_artifact_digest` text,
	`image_artifact_digest` text,
	`configuration_digest` text,
	`architecture` text,
	`state` text NOT NULL,
	`superseded_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_release_candidates_app_state` ON `release_candidates` (`app_id`,`state`);--> statement-breakpoint
CREATE TABLE `site_sync_cursors` (
	`local_site_id` text NOT NULL,
	`remote_site_id` text NOT NULL,
	`stream` text NOT NULL,
	`last_accepted_sequence` integer DEFAULT 0 NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`last_attempt_at` text,
	`last_success_at` text,
	PRIMARY KEY(`local_site_id`, `remote_site_id`, `stream`)
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_id` text NOT NULL,
	`node_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`public_key` text NOT NULL,
	`credential_hash` text,
	`credential_status` text DEFAULT 'active' NOT NULL,
	`platform` text,
	`architecture` text,
	`version` text,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`mode` text DEFAULT 'docked' NOT NULL,
	`default_data_policy` text DEFAULT 'none' NOT NULL,
	`access_mode` text DEFAULT 'existing-lan' NOT NULL,
	`security_profile` text DEFAULT 'isolated' NOT NULL,
	`network_fingerprint` text,
	`readiness_summary` text DEFAULT '{}' NOT NULL,
	`last_contact_at` integer,
	`revoked_at` text,
	`removed_at` text,
	`quarantine_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sites_fleet` ON `sites` (`fleet_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_sites_node` ON `sites` (`node_id`);--> statement-breakpoint
CREATE TABLE `suitcase_capacity_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_id` text NOT NULL,
	`selected_app_ids` text NOT NULL,
	`assumptions` text NOT NULL,
	`minimum_memory_bytes` integer NOT NULL,
	`recommended_memory_bytes` integer NOT NULL,
	`minimum_storage_bytes` integer NOT NULL,
	`recommended_storage_bytes` integer NOT NULL,
	`contributors` text NOT NULL,
	`confidence` text NOT NULL,
	`unknowns` text NOT NULL,
	`measured_result` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `volume_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`authority_site_id` text NOT NULL,
	`authority_epoch` integer NOT NULL,
	`data_sequence` integer NOT NULL,
	`parent_snapshot_id` text,
	`manifest_artifact_digest` text NOT NULL,
	`consistency_mode` text NOT NULL,
	`logical_bytes` integer NOT NULL,
	`unique_bytes` integer NOT NULL,
	`verification_status` text NOT NULL,
	`release_generation` integer,
	`retention_class` text NOT NULL,
	`latest_home_recovery` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_volume_snapshots_app_sequence` ON `volume_snapshots` (`app_id`,`data_sequence`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `app_id` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `data_mode` text DEFAULT 'single-site';--> statement-breakpoint
ALTER TABLE `deployments` ADD `reconciliation_profile_version` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `release_authority_epoch` integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE `deployments` ADD `release_generation` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `deployments` ADD `desired_release_digest` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `source_artifact_digest` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `image_artifact_digest` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `snapshot_artifact_digest` text;--> statement-breakpoint
CREATE INDEX `idx_deployments_app_id` ON `deployments` (`app_id`);