PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_build_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deployment_name` text NOT NULL,
	`output` text NOT NULL,
	`success` integer,
	`duration` integer,
	`status` text DEFAULT 'complete' NOT NULL,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_build_logs`("id", "deployment_name", "output", "success", "duration", "timestamp") SELECT "id", "deployment_name", "output", "success", "duration", "timestamp" FROM `build_logs`;--> statement-breakpoint
DROP TABLE `build_logs`;--> statement-breakpoint
ALTER TABLE `__new_build_logs` RENAME TO `build_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_build_logs_deployment` ON `build_logs` (`deployment_name`);--> statement-breakpoint
CREATE INDEX `idx_build_logs_timestamp` ON `build_logs` (`deployment_name`,`timestamp`);