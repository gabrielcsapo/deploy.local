CREATE TABLE `actual_volume_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`site_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`component_key` text NOT NULL,
	`instance_id` text NOT NULL,
	`provider_volume` text NOT NULL,
	`mount_path` text NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_actual_volume_attachments_instance` ON `actual_volume_attachments` (`instance_id`);--> statement-breakpoint
CREATE INDEX `idx_actual_volume_attachments_resource` ON `actual_volume_attachments` (`app_id`,`site_id`,`resource_key`);--> statement-breakpoint
CREATE TABLE `component_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`site_id` text NOT NULL,
	`component_key` text NOT NULL,
	`slot_key` text NOT NULL,
	`node_id` text,
	`release_digest` text NOT NULL,
	`configuration_digest` text NOT NULL,
	`image` text NOT NULL,
	`container_id` text,
	`container_name` text NOT NULL,
	`status` text NOT NULL,
	`health` text DEFAULT 'unknown' NOT NULL,
	`replacement_for` text,
	`drain_deadline` integer,
	`ready_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_component_instances_app_component` ON `component_instances` (`app_id`,`site_id`,`component_key`,`status`);--> statement-breakpoint
CREATE INDEX `idx_component_instances_slot` ON `component_instances` (`app_id`,`site_id`,`slot_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_component_instances_container` ON `component_instances` (`container_name`);--> statement-breakpoint
CREATE TABLE `component_job_executions` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`site_id` text NOT NULL,
	`release_digest` text NOT NULL,
	`configuration_digest` text NOT NULL,
	`job_key` text NOT NULL,
	`component_key` text NOT NULL,
	`scope` text NOT NULL,
	`instance_id` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`container_id` text,
	`exit_code` integer,
	`output` text,
	`lease_owner` text,
	`lease_expires_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_component_jobs_app_status` ON `component_job_executions` (`app_id`,`site_id`,`status`);--> statement-breakpoint
CREATE TABLE `component_placements` (
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`site_id` text NOT NULL,
	`component_key` text NOT NULL,
	`desired_instances` integer NOT NULL,
	`release_digest` text NOT NULL,
	`configuration_digest` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`profile` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`app_id`, `site_id`, `component_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_component_placements_deployment` ON `component_placements` (`deployment_name`,`site_id`);--> statement-breakpoint
CREATE TABLE `component_profile_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`site_id` text NOT NULL,
	`component_key` text NOT NULL,
	`instance_id` text,
	`profile` text NOT NULL,
	`operation` text NOT NULL,
	`command` text NOT NULL,
	`status` text NOT NULL,
	`artifact_path` text,
	`artifact_digest` text,
	`verification` text,
	`exit_code` integer,
	`output` text,
	`started_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_component_profile_operations_app` ON `component_profile_operations` (`app_id`,`site_id`,`component_key`,`operation`);--> statement-breakpoint
CREATE TABLE `component_profile_values` (
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`site_id` text NOT NULL,
	`component_key` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`value_digest` text NOT NULL,
	`secret` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `site_id`, `component_key`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_component_profile_values_deployment` ON `component_profile_values` (`deployment_name`);--> statement-breakpoint
CREATE TABLE `component_services` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`deployment_name` text NOT NULL,
	`component_key` text NOT NULL,
	`interface_key` text NOT NULL,
	`protocol` text NOT NULL,
	`container_port` integer NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`membership_generation` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_component_services_app` ON `component_services` (`app_id`,`published`);--> statement-breakpoint
CREATE INDEX `idx_component_services_deployment` ON `component_services` (`deployment_name`);--> statement-breakpoint
CREATE TABLE `service_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`site_id` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`readiness` text NOT NULL,
	`release_digest` text NOT NULL,
	`configuration_digest` text NOT NULL,
	`admitted_generation` integer DEFAULT 0 NOT NULL,
	`drain_deadline` integer,
	`last_health_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_service_endpoints_generation` ON `service_endpoints` (`service_id`,`admitted_generation`,`readiness`);--> statement-breakpoint
CREATE INDEX `idx_service_endpoints_instance` ON `service_endpoints` (`instance_id`);