ALTER TABLE `release_candidates` ADD `spec_digest` text;--> statement-breakpoint
ALTER TABLE `release_candidates` ADD `parent_spec_digest` text;--> statement-breakpoint
ALTER TABLE `release_candidates` ADD `requested_alias` text;--> statement-breakpoint
ALTER TABLE `release_candidates` ADD `snapshot_artifact_digest` text;--> statement-breakpoint
ALTER TABLE `release_candidates` ADD `artifact_digests` text DEFAULT '[]' NOT NULL;