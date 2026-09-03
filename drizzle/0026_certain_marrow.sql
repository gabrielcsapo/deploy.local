CREATE TABLE `application_aliases` (
	`fleet_id` text NOT NULL,
	`alias` text NOT NULL,
	`app_id` text NOT NULL,
	`origin_site_id` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`fleet_id`, `alias`, `app_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_application_aliases_alias` ON `application_aliases` (`fleet_id`,`alias`,`state`);--> statement-breakpoint
CREATE TABLE `data_sync_policies` (
	`app_id` text NOT NULL,
	`site_id` text DEFAULT '' NOT NULL,
	`policy` text NOT NULL,
	`conflict_policy` text DEFAULT 'collect' NOT NULL,
	`acknowledged_risks` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`app_id`, `site_id`)
);
--> statement-breakpoint
CREATE TABLE `readiness_certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`site_id` text NOT NULL,
	`spec_digest` text NOT NULL,
	`checkpoint_id` text,
	`capability_digest` text NOT NULL,
	`analyzer_version` text NOT NULL,
	`runtime_ready` integer NOT NULL,
	`build_ready` integer NOT NULL,
	`data_ready` integer NOT NULL,
	`access_ready` integer NOT NULL,
	`blockers` text DEFAULT '[]' NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text,
	`invalidated_at` text,
	`invalidation_reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_readiness_certificates_app_site` ON `readiness_certificates` (`app_id`,`site_id`);--> statement-breakpoint
CREATE TABLE `site_pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`fleet_id` text NOT NULL,
	`name` text NOT NULL,
	`code_hash` text NOT NULL,
	`default_data_policy` text NOT NULL,
	`access_mode` text NOT NULL,
	`security_profile` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_site_pairing_codes_hash` ON `site_pairing_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_site_pairing_codes_expiry` ON `site_pairing_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `site_users` (
	`site_id` text NOT NULL,
	`username` text NOT NULL,
	`role` text NOT NULL,
	`password_verifier` text NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`site_id`, `username`)
);
