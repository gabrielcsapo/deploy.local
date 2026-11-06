CREATE TABLE package_computer_keys (
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  computer_id TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY(username,computer_id)
);
--> statement-breakpoint
CREATE TABLE package_project_copies (
  username TEXT NOT NULL,
  project_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(username,project_id)
);
--> statement-breakpoint
CREATE INDEX package_pins_key ON package_pins(ecosystem,key);
--> statement-breakpoint
CREATE TABLE package_project_requirements (
  username TEXT NOT NULL,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY(username,project_id,key)
);
