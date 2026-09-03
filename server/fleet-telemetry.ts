import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { putArtifactFile } from './content-store.ts';
import { canonicalFleetPayload } from './multisite.ts';
import { buildLogFilePath, getSqlite } from './store.ts';
import { getBackupDir } from './volumes.ts';

export type FleetTelemetryKind = 'activity' | 'build' | 'backup' | 'request-aggregate';

export interface WireFleetTelemetryRecord {
  id: string;
  fleetId: string;
  originSiteId: string;
  originSequence: number;
  kind: FleetTelemetryKind;
  appId: string | null;
  deploymentName: string;
  logicalKey: string;
  observedAt: string;
  payload: Record<string, unknown>;
  artifactDigests: string[];
  createdAt: string;
}

export interface FleetTelemetryArtifact {
  digest: string;
  path: string;
  type: string;
  mediaType: string;
  retentionClass: string;
}

const KINDS = new Set<FleetTelemetryKind>(['activity', 'build', 'backup', 'request-aggregate']);
const ID_PATTERN = /^telemetry_[a-f0-9]{48}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Fleet telemetry payload is invalid');
  }
  return parsed as Record<string, unknown>;
}

function parseDigests(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Fleet telemetry artifact list is invalid');
  }
  return parsed;
}

function wireFromRow(row: Record<string, unknown>): WireFleetTelemetryRecord {
  return {
    id: String(row.id),
    fleetId: String(row.fleet_id),
    originSiteId: String(row.origin_site_id),
    originSequence: Number(row.origin_sequence),
    kind: String(row.kind) as FleetTelemetryKind,
    appId: row.app_id ? String(row.app_id) : null,
    deploymentName: String(row.deployment_name),
    logicalKey: String(row.logical_key),
    observedAt: String(row.observed_at),
    payload: parseObject(row.payload),
    artifactDigests: parseDigests(row.artifact_digests),
    createdAt: String(row.created_at),
  };
}

export function validateFleetTelemetryRecord(
  value: unknown,
  expected: { fleetId: string; originSiteId?: string },
): WireFleetTelemetryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Fleet telemetry record must be an object');
  }
  const record = value as WireFleetTelemetryRecord;
  if (
    !ID_PATTERN.test(record.id) ||
    record.fleetId !== expected.fleetId ||
    (expected.originSiteId && record.originSiteId !== expected.originSiteId) ||
    !Number.isSafeInteger(record.originSequence) ||
    record.originSequence < 1 ||
    !KINDS.has(record.kind) ||
    !record.deploymentName ||
    record.deploymentName.length > 191 ||
    !record.logicalKey ||
    record.logicalKey.length > 512 ||
    !Number.isFinite(Date.parse(record.observedAt)) ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error('Fleet telemetry identity, kind, sequence, or timestamp is invalid');
  }
  record.payload = parseObject(record.payload);
  if (Buffer.byteLength(canonicalFleetPayload(record.payload)) > 2 * 1024 * 1024) {
    throw new Error('Fleet telemetry payload exceeds 2 MiB');
  }
  record.artifactDigests = parseDigests(record.artifactDigests);
  if (record.artifactDigests.some((digest) => !DIGEST_PATTERN.test(digest))) {
    throw new Error('Fleet telemetry contains an invalid artifact digest');
  }
  return record;
}

function recordId(input: {
  fleetId: string;
  originSiteId: string;
  kind: FleetTelemetryKind;
  logicalKey: string;
  payload: Record<string, unknown>;
  artifactDigests: string[];
}): string {
  const hash = createHash('sha256')
    .update(
      canonicalFleetPayload({
        fleetId: input.fleetId,
        originSiteId: input.originSiteId,
        kind: input.kind,
        logicalKey: input.logicalKey,
        payload: input.payload,
        artifactDigests: input.artifactDigests,
      }),
    )
    .digest('hex');
  return `telemetry_${hash.slice(0, 48)}`;
}

function insertLocalRevision(
  input: Omit<WireFleetTelemetryRecord, 'id' | 'originSequence' | 'createdAt'>,
) {
  const sqlite = getSqlite()!;
  const id = recordId(input);
  if (sqlite.prepare('SELECT 1 FROM fleet_telemetry_records WHERE id = ?').get(id)) return;
  const next = Number(
    (
      sqlite
        .prepare(
          'SELECT COALESCE(MAX(origin_sequence), 0) + 1 AS sequence FROM fleet_telemetry_records WHERE origin_site_id = ?',
        )
        .get(input.originSiteId) as { sequence: number }
    ).sequence,
  );
  const createdAt = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO fleet_telemetry_records
        (id, fleet_id, origin_site_id, origin_sequence, kind, app_id,
         deployment_name, logical_key, observed_at, payload, artifact_digests, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.fleetId,
      input.originSiteId,
      next,
      input.kind,
      input.appId,
      input.deploymentName,
      input.logicalKey,
      input.observedAt,
      canonicalFleetPayload(input.payload),
      canonicalFleetPayload(input.artifactDigests),
      createdAt,
    );
}

function deploymentAppId(name: string): string | null {
  const row = getSqlite()!.prepare('SELECT app_id FROM deployments WHERE name = ?').get(name) as
    | { app_id: string | null }
    | undefined;
  return row?.app_id ?? null;
}

/** Capture immutable revisions of the four v1 cross-site operational streams. */
export async function collectLocalFleetTelemetry(input: {
  fleetId: string;
  siteId: string;
}): Promise<{ records: WireFleetTelemetryRecord[]; artifacts: FleetTelemetryArtifact[] }> {
  const sqlite = getSqlite()!;
  const artifacts: FleetTelemetryArtifact[] = [];
  const candidates: Array<Omit<WireFleetTelemetryRecord, 'id' | 'originSequence' | 'createdAt'>> =
    [];
  const histories = sqlite.prepare('SELECT * FROM history ORDER BY id').all() as Array<
    Record<string, unknown>
  >;
  for (const row of histories) {
    const deploymentName = String(row.deployment_name);
    candidates.push({
      fleetId: input.fleetId,
      originSiteId: input.siteId,
      kind: 'activity',
      appId: deploymentAppId(deploymentName),
      deploymentName,
      logicalKey: `history:${row.id}`,
      observedAt: String(row.timestamp),
      payload: {
        action: row.action,
        username: row.username,
        type: row.type,
        port: row.port,
        containerId: row.container_id,
        buildLogId: row.build_log_id,
        durationMs: row.duration_ms,
        source: row.source,
      },
      artifactDigests: [],
    });
  }
  const builds = sqlite
    .prepare("SELECT * FROM build_logs WHERE status <> 'building' ORDER BY id")
    .all() as Array<Record<string, unknown>>;
  for (const row of builds) {
    const deploymentName = String(row.deployment_name);
    let output = String(row.output || '');
    if (!output) {
      const path = buildLogFilePath(Number(row.id));
      if (existsSync(path)) output = readFileSync(path, 'utf8');
    }
    candidates.push({
      fleetId: input.fleetId,
      originSiteId: input.siteId,
      kind: 'build',
      appId: deploymentAppId(deploymentName),
      deploymentName,
      logicalKey: `build:${row.id}`,
      observedAt: String(row.timestamp),
      payload: {
        sourceId: Number(row.id),
        output,
        success: row.success === null ? null : Boolean(row.success),
        duration: row.duration,
        status: row.status,
      },
      artifactDigests: [],
    });
  }
  const backups = sqlite.prepare('SELECT * FROM backups ORDER BY id').all() as Array<
    Record<string, unknown>
  >;
  for (const row of backups) {
    const deploymentName = String(row.deployment_name);
    const path = resolve(getBackupDir(deploymentName), String(row.filename));
    const artifactDigests: string[] = [];
    // Graph recovery points are a manifest plus one archive per resource. They
    // remain site-local until the graph-aware transfer protocol bundles that
    // exact set; never pass a directory to the legacy single-file artifact
    // publisher or mislabel it as a gzip stream.
    if (existsSync(path) && statSync(path).isFile()) {
      const artifact = await putArtifactFile(path, {
        type: 'application-backup',
        mediaType: 'application/gzip',
        retentionClass: 'recovery',
      });
      artifactDigests.push(artifact.digest);
      artifacts.push({
        digest: artifact.digest,
        path: artifact.path,
        type: 'application-backup',
        mediaType: 'application/gzip',
        retentionClass: 'recovery',
      });
    }
    candidates.push({
      fleetId: input.fleetId,
      originSiteId: input.siteId,
      kind: 'backup',
      appId: deploymentAppId(deploymentName),
      deploymentName,
      logicalKey: `backup:${row.id}`,
      observedAt: String(row.created_at),
      payload: {
        filename: row.filename,
        label: row.label,
        sizeBytes: Number(row.size_bytes),
        createdBy: row.created_by,
        volumePaths: JSON.parse(String(row.volume_paths)),
        relatedBuildLogId: row.related_build_log_id,
        auto: Boolean(row.auto),
        contentAvailable: artifactDigests.length > 0,
      },
      artifactDigests,
    });
  }
  const rollups = sqlite
    .prepare('SELECT * FROM request_logs_1m ORDER BY deployment_name, bucket_ms')
    .all() as Array<Record<string, unknown>>;
  for (const row of rollups) {
    const deploymentName = String(row.deployment_name);
    candidates.push({
      fleetId: input.fleetId,
      originSiteId: input.siteId,
      kind: 'request-aggregate',
      appId: deploymentAppId(deploymentName),
      deploymentName,
      logicalKey: `request:${row.bucket_ms}`,
      observedAt: new Date(Number(row.bucket_ms)).toISOString(),
      payload: {
        bucketMs: Number(row.bucket_ms),
        count: Number(row.count),
        errors4xx: Number(row.errors_4xx),
        errors5xx: Number(row.errors_5xx),
        durationSum: Number(row.duration_sum),
        durationMin: Number(row.duration_min),
        durationMax: Number(row.duration_max),
      },
      artifactDigests: [],
    });
  }
  for (const candidate of candidates) insertLocalRevision(candidate);
  return {
    records: listFleetTelemetryAfter(input.fleetId, input.siteId, 0),
    artifacts: [...new Map(artifacts.map((artifact) => [artifact.digest, artifact])).values()],
  };
}

export function listFleetTelemetryAfter(
  fleetId: string,
  originSiteId: string,
  sequence: number,
  limit = 200,
): WireFleetTelemetryRecord[] {
  return (
    getSqlite()!
      .prepare(
        `SELECT * FROM fleet_telemetry_records
          WHERE fleet_id = ? AND origin_site_id = ? AND origin_sequence > ?
          ORDER BY origin_sequence LIMIT ?`,
      )
      .all(fleetId, originSiteId, sequence, limit) as Array<Record<string, unknown>>
  ).map(wireFromRow);
}

export function ingestFleetTelemetryRecords(
  records: WireFleetTelemetryRecord[],
  expected: { fleetId: string; originSiteId?: string },
): { acceptedThrough: number; replayed: number } {
  const sqlite = getSqlite()!;
  const originSiteId = expected.originSiteId || records[0]?.originSiteId || '';
  let acceptedThrough = Number(
    (
      sqlite
        .prepare(
          'SELECT COALESCE(MAX(origin_sequence), 0) AS sequence FROM fleet_telemetry_records WHERE origin_site_id = ?',
        )
        .get(originSiteId) as { sequence: number }
    ).sequence,
  );
  let replayed = 0;
  const transaction = sqlite.transaction(() => {
    for (const value of records) {
      const record = validateFleetTelemetryRecord(value, expected);
      const existing = sqlite
        .prepare(
          'SELECT id FROM fleet_telemetry_records WHERE origin_site_id = ? AND origin_sequence = ?',
        )
        .get(record.originSiteId, record.originSequence) as { id: string } | undefined;
      if (existing) {
        if (existing.id !== record.id) {
          throw new Error('Fleet telemetry sequence conflicts with an accepted record');
        }
        replayed += 1;
        acceptedThrough = Math.max(acceptedThrough, record.originSequence);
        continue;
      }
      if (record.originSequence !== acceptedThrough + 1) {
        throw new Error(`Expected fleet telemetry sequence ${acceptedThrough + 1}`);
      }
      sqlite
        .prepare(
          `INSERT INTO fleet_telemetry_records
            (id, fleet_id, origin_site_id, origin_sequence, kind, app_id,
             deployment_name, logical_key, observed_at, payload, artifact_digests, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.fleetId,
          record.originSiteId,
          record.originSequence,
          record.kind,
          record.appId,
          record.deploymentName,
          record.logicalKey,
          record.observedAt,
          canonicalFleetPayload(record.payload),
          canonicalFleetPayload(record.artifactDigests),
          record.createdAt,
        );
      acceptedThrough = record.originSequence;
    }
  });
  transaction.immediate();
  return { acceptedThrough, replayed };
}

/** Latest revision per site/kind/logical record for admin projections. */
export function listLatestFleetTelemetry(
  deploymentName: string,
  kind?: FleetTelemetryKind,
): WireFleetTelemetryRecord[] {
  const conditions = ['records.deployment_name = ?'];
  const args: unknown[] = [deploymentName];
  if (kind) {
    conditions.push('records.kind = ?');
    args.push(kind);
  }
  return (
    getSqlite()!
      .prepare(
        `SELECT records.* FROM fleet_telemetry_records records
          WHERE ${conditions.join(' AND ')}
            AND records.origin_sequence = (
              SELECT MAX(candidate.origin_sequence)
                FROM fleet_telemetry_records candidate
               WHERE candidate.origin_site_id = records.origin_site_id
                 AND candidate.kind = records.kind
                 AND candidate.logical_key = records.logical_key
            )
          ORDER BY records.observed_at DESC`,
      )
      .all(...args) as Array<Record<string, unknown>>
  ).map(wireFromRow);
}
