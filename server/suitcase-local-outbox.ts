import {
  enqueueSuitcaseDatabaseEvent,
  readSuitcaseMembership,
} from '../lib/suitcase-sync-client.ts';
import { getArtifact } from './content-store.ts';
import { buildFleetEventBody } from './multisite.ts';
import { getSqlite } from './store.ts';
import type { WireFleetEvent } from './suitcase-transport.ts';

function parseArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Fleet event artifact list is invalid');
  }
  return parsed;
}

function parsePayload(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Fleet event payload is invalid');
  }
  return parsed as Record<string, unknown>;
}

export function enqueueLocalDatabaseEvents(membershipFile: string): number {
  const membership = readSuitcaseMembership(undefined, membershipFile);
  if (!membership) return 0;
  const rows = getSqlite()!
    .prepare(
      `SELECT * FROM fleet_events
        WHERE fleet_id = ? AND origin_site_id = ? AND origin_sequence > ?
        ORDER BY origin_sequence LIMIT 200`,
    )
    .all(membership.fleetId, membership.siteId, membership.acknowledgedLocalSequence) as Array<
    Record<string, unknown>
  >;
  let queued = 0;
  for (const row of rows) {
    const artifactDigests = parseArray(row.artifact_digests);
    const base = {
      id: String(row.id),
      fleetId: String(row.fleet_id),
      originSiteId: String(row.origin_site_id),
      originSequence: Number(row.origin_sequence),
      appId: row.app_id ? String(row.app_id) : null,
      authorityEpoch: row.authority_epoch === null ? null : Number(row.authority_epoch),
      generation: row.generation === null ? null : Number(row.generation),
      actor: String(row.actor),
      operation: String(row.operation),
      schemaVersion: Number(row.schema_version),
      payload: parsePayload(row.payload),
      artifactDigests,
      parentEventId: row.parent_event_id ? String(row.parent_event_id) : null,
      createdAt: String(row.created_at),
    };
    const event: WireFleetEvent = {
      ...base,
      body: buildFleetEventBody(base),
      authenticatedDigest: String(row.authenticated_digest),
    };
    const artifacts = artifactDigests.map((digest) => {
      const artifact = getArtifact(digest);
      if (!artifact) throw new Error(`Local fleet event artifact ${digest} is unavailable`);
      return {
        digest,
        path: artifact.localPath,
        type: 'fleet-event-artifact',
      };
    });
    if (enqueueSuitcaseDatabaseEvent(event, artifacts, { membershipFile })) queued += 1;
  }
  return queued;
}
