CREATE TABLE packages (
  id TEXT PRIMARY KEY NOT NULL,
  ecosystem TEXT NOT NULL CHECK(ecosystem IN ('npm','cargo')),
  name TEXT NOT NULL,
  project_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(username),
  created_at TEXT NOT NULL,
  UNIQUE(ecosystem,name)
);
--> statement-breakpoint
CREATE TABLE package_versions (
  package_id TEXT NOT NULL REFERENCES packages(id),
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  integrity TEXT NOT NULL,
  size INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_via TEXT NOT NULL CHECK(published_via IN ('person','release','import')),
  "commit" TEXT,
  deprecated TEXT,
  yanked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(package_id,version)
);
--> statement-breakpoint
CREATE TABLE package_tags (
  package_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY(package_id,tag),
  FOREIGN KEY(package_id,version) REFERENCES package_versions(package_id,version)
);
--> statement-breakpoint
CREATE TABLE package_keys (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('install','publish')),
  last_used_at TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE package_cache_entries (
  ecosystem TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('doc','file')),
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  abbreviated_sha256 TEXT,
  abbreviated_size INTEGER,
  index_sha256 TEXT,
  index_size INTEGER,
  etag TEXT,
  fetched_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY(ecosystem,kind,key)
);
--> statement-breakpoint
CREATE TABLE package_pins (
  ecosystem TEXT NOT NULL,
  key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  PRIMARY KEY(ecosystem,key,project_id,release_id,reason)
);
