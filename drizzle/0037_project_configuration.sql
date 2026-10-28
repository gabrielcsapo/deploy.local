CREATE TABLE project_applications (
  application TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  project_id TEXT NOT NULL,
  configuration_migrated INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE project_configuration (
  owner TEXT NOT NULL,
  project_id TEXT NOT NULL,
  app TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (owner, project_id, app, key)
);
