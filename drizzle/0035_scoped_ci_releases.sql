CREATE TABLE ci_credentials (id text PRIMARY KEY, username text NOT NULL, application text NOT NULL, token_hash text NOT NULL UNIQUE, expires_at integer NOT NULL, revoked_at integer, created_at integer NOT NULL);
--> statement-breakpoint
CREATE TABLE ci_releases (id text PRIMARY KEY, application text NOT NULL, username text NOT NULL, credential_id text NOT NULL, request_key text NOT NULL, source_commit text NOT NULL, source_digest text NOT NULL, source_archive_digest text NOT NULL, predecessor text NOT NULL, baseline_source text NOT NULL, baseline_fingerprint text NOT NULL, runtime_fingerprint text, resume_fingerprint text, baseline_image text NOT NULL, resume_source text, resolved_by text, resolved_at integer, baseline_container text NOT NULL, spec_digest text NOT NULL, status text NOT NULL, boot_id text NOT NULL, owner_pid integer, owner_thread integer, owner_active integer NOT NULL DEFAULT 0, container_id text, image_digest text, failure text, created_at integer NOT NULL, updated_at integer NOT NULL, UNIQUE(application,request_key));
--> statement-breakpoint
CREATE UNIQUE INDEX ci_one_active_release ON ci_releases(application) WHERE status IN ('accepted','building','starting','interrupted','failed');
--> statement-breakpoint
CREATE TABLE ci_mutations (id text PRIMARY KEY, application text NOT NULL, pid integer NOT NULL, thread_id integer NOT NULL, created_at integer NOT NULL);
--> statement-breakpoint
CREATE INDEX ci_mutations_application ON ci_mutations(application);
