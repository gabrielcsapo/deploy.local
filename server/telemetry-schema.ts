/** Additive requests.db schema. No raw server/browser event table. */
export const TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS otlp_spans (
 project TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, received INTEGER NOT NULL, span TEXT NOT NULL,
 PRIMARY KEY(project,trace_id,span_id));
CREATE INDEX IF NOT EXISTS otlp_project_received ON otlp_spans(project,received);
CREATE INDEX IF NOT EXISTS otlp_expiry ON otlp_spans(received);
CREATE TABLE IF NOT EXISTS interaction_volume (
 project TEXT NOT NULL, minute INTEGER NOT NULL, healthy INTEGER NOT NULL DEFAULT 0,
 priority INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project,minute));
CREATE INDEX IF NOT EXISTS interaction_volume_expiry ON interaction_volume(minute);
CREATE TABLE IF NOT EXISTS interaction_roots (
 project TEXT NOT NULL,trace_id TEXT NOT NULL,span_id TEXT NOT NULL,name TEXT NOT NULL,milestone TEXT NOT NULL,outcome TEXT NOT NULL,platform TEXT NOT NULL,duration_ms REAL NOT NULL,at INTEGER NOT NULL,start_unix_ms REAL,PRIMARY KEY(project,trace_id));
CREATE INDEX IF NOT EXISTS interaction_expiry ON interaction_roots(at);
CREATE TABLE IF NOT EXISTS interaction_spans (
 project TEXT NOT NULL,trace_id TEXT NOT NULL,span_id TEXT NOT NULL,parent_id TEXT NOT NULL,name TEXT NOT NULL,start_ms REAL NOT NULL,duration_ms REAL NOT NULL,failed INTEGER NOT NULL,PRIMARY KEY(project,trace_id,span_id));
CREATE TRIGGER IF NOT EXISTS interaction_cleanup AFTER DELETE ON interaction_roots BEGIN DELETE FROM interaction_spans WHERE project=old.project AND trace_id=old.trace_id; END;
CREATE TABLE IF NOT EXISTS telemetry_tokens (
 token_hash TEXT PRIMARY KEY, deployment_name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_tokens_deployment ON telemetry_tokens(deployment_name);
CREATE TABLE IF NOT EXISTS telemetry_remote_tokens (
 token_hash TEXT PRIMARY KEY, node_id TEXT NOT NULL, owner TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telemetry_routes (
 deployment_name TEXT NOT NULL, bucket_ms INTEGER NOT NULL, route TEXT NOT NULL,
 source TEXT NOT NULL, count INTEGER NOT NULL, errors_4xx INTEGER NOT NULL,
 errors_5xx INTEGER NOT NULL, histogram TEXT NOT NULL, phases TEXT NOT NULL,
 PRIMARY KEY(deployment_name, bucket_ms, route, source)
);
CREATE INDEX IF NOT EXISTS telemetry_routes_expiry ON telemetry_routes(bucket_ms);
CREATE TABLE IF NOT EXISTS telemetry_client_spans (
 deployment_name TEXT NOT NULL, request_id TEXT NOT NULL, trace_id TEXT NOT NULL,
 timestamp INTEGER NOT NULL, spans TEXT NOT NULL, PRIMARY KEY(deployment_name,request_id,trace_id)
);
CREATE INDEX IF NOT EXISTS telemetry_client_spans_expiry ON telemetry_client_spans(timestamp);
CREATE TABLE IF NOT EXISTS telemetry_navigation (
 deployment_name TEXT NOT NULL, request_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
 route TEXT NOT NULL, start_fetch_ms REAL NOT NULL, headers_ms REAL NOT NULL, commit_ms REAL NOT NULL,
 PRIMARY KEY(deployment_name,request_id)
);
CREATE INDEX IF NOT EXISTS telemetry_navigation_expiry ON telemetry_navigation(timestamp);
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
