import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { putArtifactFile } from './content-store.ts';
import { getFleetOverview } from './fleet-handler.ts';
import { getSqlite } from './store.ts';

const SENSITIVE_KEY =
  /(?:password|password.?verifier|verifier|hash|secret|token|credential|private.?key|authorization|cookie|value)$/i;

function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redact(child, childKey),
    ]),
  );
}

export async function createSupportBundle(input: {
  outputPath: string;
  createdBy: string;
}): Promise<{ artifactDigest: string; path: string }> {
  const sqlite = getSqlite()!;
  const revisions = sqlite
    .prepare(
      `SELECT deployment_name, digest, parent_digest, api_version, source,
              manifest_format, normalized_spec, created_by, created_at
         FROM application_spec_revisions ORDER BY deployment_name, created_at`,
    )
    .all();
  const recentEvents = sqlite
    .prepare(
      `SELECT id, fleet_id, origin_site_id, origin_sequence, app_id,
              authority_epoch, generation, actor, operation, schema_version,
              payload, artifact_digests, parent_event_id, created_at,
              applied_at, rejection_reason
         FROM fleet_events ORDER BY created_at DESC LIMIT 500`,
    )
    .all() as Array<Record<string, unknown>>;
  const diagnostics = {
    kind: 'deploy.local/SupportBundle',
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
    deployLocalVersion: process.env.npm_package_version || 'source',
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    topology: getFleetOverview(),
    revisions,
    recentEvents: recentEvents.map((event) => ({
      ...event,
      payload: redact(JSON.parse(String(event.payload || '{}'))),
      artifact_digests: JSON.parse(String(event.artifact_digests || '[]')),
    })),
    database: {
      integrity: sqlite.pragma('integrity_check'),
      foreignKeys: sqlite.pragma('foreign_key_check'),
      migrationCount: (
        sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as {
          count: number;
        }
      ).count,
    },
  };
  const redacted = redact(diagnostics);
  const encoded = Buffer.from(`${JSON.stringify(redacted, null, 2)}\n`);
  const output = resolve(input.outputPath);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, encoded, { mode: 0o600, flag: 'wx' });
  const artifact = await putArtifactFile(output, {
    type: 'support-bundle',
    mediaType: 'application/vnd.deploy.support+json',
    retentionClass: 'temporary',
  });
  return {
    artifactDigest: artifact.digest,
    path: output,
  };
}

export function verifySupportBundleRedaction(bundle: unknown, forbiddenValues: string[]): void {
  const encoded = JSON.stringify(bundle);
  for (const forbidden of forbiddenValues.filter(Boolean)) {
    if (encoded.includes(forbidden)) {
      const fingerprint = createHash('sha256').update(forbidden).digest('hex').slice(0, 12);
      throw new Error(
        `Support bundle contains forbidden sensitive value fingerprint ${fingerprint}`,
      );
    }
  }
}
