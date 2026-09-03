CREATE TABLE `node_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_enrollments_code_hash_unique` ON `node_enrollments` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_node_enrollments_expires` ON `node_enrollments` (`expires_at`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'agent' NOT NULL,
	`platform` text,
	`architecture` text,
	`agent_version` text,
	`address` text,
	`capabilities` text,
	`credential_hash` text,
	`enrolled_at` text NOT NULL,
	`last_seen_at` integer,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_name_unique` ON `nodes` (`name`);--> statement-breakpoint
CREATE INDEX `idx_nodes_last_seen` ON `nodes` (`last_seen_at`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `desired_node_id` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `active_node_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
UPDATE `users`
SET `role` = 'admin'
WHERE `username` = (
	SELECT `username` FROM `users` ORDER BY `created_at` ASC, `username` ASC LIMIT 1
);
