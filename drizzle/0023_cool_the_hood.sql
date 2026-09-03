CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`type` text NOT NULL,
	`deployment_name` text NOT NULL,
	`artifact_path` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_agent_jobs_node_status` ON `agent_jobs` (`node_id`,`status`,`created_at`);