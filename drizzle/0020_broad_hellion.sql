CREATE TABLE `request_logs_1m` (
	`deployment_name` text NOT NULL,
	`bucket_ms` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`errors_4xx` integer DEFAULT 0 NOT NULL,
	`errors_5xx` integer DEFAULT 0 NOT NULL,
	`duration_sum` integer DEFAULT 0 NOT NULL,
	`duration_min` integer DEFAULT 0 NOT NULL,
	`duration_max` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`deployment_name`, `bucket_ms`)
);
--> statement-breakpoint
CREATE INDEX `idx_request_logs_1m_bucket` ON `request_logs_1m` (`bucket_ms`);