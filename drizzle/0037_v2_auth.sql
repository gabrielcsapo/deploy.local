CREATE TABLE v2_auth_grants (
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  owner TEXT NOT NULL,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (kind, hash)
);
--> statement-breakpoint
CREATE TABLE v2_passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_v2_passkeys_username ON v2_passkeys(username);
--> statement-breakpoint
CREATE TABLE v2_devices (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE v2_account_preferences (
  username TEXT PRIMARY KEY NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  data TEXT NOT NULL
);
