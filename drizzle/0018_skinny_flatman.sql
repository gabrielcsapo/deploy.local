CREATE INDEX `idx_request_logs_ts` ON `request_logs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_resource_metrics_ts` ON `resource_metrics` (`timestamp`);