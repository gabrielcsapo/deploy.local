/** Additive requests.db schema. No raw server/browser event table. */
export const TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_tokens (
 token_hash TEXT PRIMARY KEY, deployment_name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_tokens_deployment ON telemetry_tokens(deployment_name);
CREATE TABLE IF NOT EXISTS telemetry_routes (
 deployment_name TEXT NOT NULL, bucket_ms INTEGER NOT NULL, route TEXT NOT NULL,
 source TEXT NOT NULL, count INTEGER NOT NULL, errors_4xx INTEGER NOT NULL,
 errors_5xx INTEGER NOT NULL, histogram TEXT NOT NULL, phases TEXT NOT NULL,
 PRIMARY KEY(deployment_name, bucket_ms, route, source)
);
CREATE INDEX IF NOT EXISTS telemetry_routes_expiry ON telemetry_routes(bucket_ms);
CREATE TABLE IF NOT EXISTS telemetry_pages (
 deployment_name TEXT NOT NULL, bucket_ms INTEGER NOT NULL, route TEXT NOT NULL,
 metrics TEXT NOT NULL, hit INTEGER NOT NULL, inflight INTEGER NOT NULL, miss INTEGER NOT NULL,
 PRIMARY KEY(deployment_name, bucket_ms, route)
);
CREATE INDEX IF NOT EXISTS telemetry_pages_expiry ON telemetry_pages(bucket_ms);
CREATE TABLE IF NOT EXISTS telemetry_errors (
 deployment_name TEXT NOT NULL, fingerprint TEXT NOT NULL, count INTEGER NOT NULL,
 first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, route TEXT NOT NULL,
 location TEXT NOT NULL, build TEXT, name TEXT NOT NULL, message TEXT NOT NULL, stack TEXT NOT NULL,
 PRIMARY KEY(deployment_name, fingerprint)
);
CREATE INDEX IF NOT EXISTS telemetry_errors_recent ON telemetry_errors(deployment_name,last_seen DESC);
CREATE INDEX IF NOT EXISTS telemetry_errors_expiry ON telemetry_errors(last_seen);
CREATE TABLE IF NOT EXISTS telemetry_releases (
 deployment_name TEXT NOT NULL, release_id TEXT NOT NULL, released_at INTEGER NOT NULL,
 baseline TEXT NOT NULL, observed TEXT NOT NULL, comparison TEXT, finalized INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(deployment_name,release_id)
);
CREATE INDEX IF NOT EXISTS telemetry_releases_recent ON telemetry_releases(deployment_name,released_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_releases_expiry ON telemetry_releases(released_at);
`;
