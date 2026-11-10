CREATE INDEX IF NOT EXISTS idx_history_build_log ON history(build_log_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deployments_build_log ON deployments(current_build_log_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_backups_build_log ON backups(related_build_log_id);
