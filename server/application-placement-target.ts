import { arch, platform } from 'node:os';
import { placementTargetFromFacts, type PlacementTargetEvidence } from './application-placement.ts';
import { getSqlite } from './store.ts';

/** Resolve authenticated facts for the exact node/site selected by the local materializer. */
export function resolvePlacementTarget(nodeId: string): PlacementTargetEvidence | null {
  const sqlite = getSqlite()!;
  const node = sqlite
    .prepare(
      `SELECT id, kind, platform, architecture, capabilities, last_seen_at
         FROM nodes WHERE id = ? AND revoked_at IS NULL`,
    )
    .get(nodeId) as
    | {
        id: string;
        kind: string;
        platform: string | null;
        architecture: string | null;
        capabilities: string | null;
        last_seen_at: number | null;
      }
    | undefined;
  if (node) {
    return placementTargetFromFacts({
      nodeId: node.id,
      kind: node.kind,
      platform: node.platform,
      architecture: node.architecture,
      capabilities: node.capabilities,
      observedAt: node.last_seen_at ? new Date(node.last_seen_at).toISOString() : null,
      source: `node:${node.id}:authenticated-heartbeat`,
    });
  }
  const site = sqlite
    .prepare(
      `SELECT id, kind, platform, architecture, capabilities, last_contact_at
         FROM sites
        WHERE id = ? AND credential_status = 'active'
          AND removed_at IS NULL AND revoked_at IS NULL`,
    )
    .get(nodeId) as
    | {
        id: string;
        kind: string;
        platform: string | null;
        architecture: string | null;
        capabilities: string;
        last_contact_at: number | null;
      }
    | undefined;
  if (site) {
    return placementTargetFromFacts({
      nodeId: site.id,
      kind: site.kind,
      platform: site.platform,
      architecture: site.architecture,
      capabilities: site.capabilities,
      observedAt: site.last_contact_at ? new Date(site.last_contact_at).toISOString() : null,
      source: `site:${site.id}:authenticated-presence`,
    });
  }
  // Unit tests and first-start coordinator preparation may run before its row is projected.
  if (nodeId === 'coordinator') {
    return placementTargetFromFacts({
      nodeId,
      kind: 'coordinator',
      platform: platform(),
      architecture: arch(),
      source: 'coordinator:local-runtime',
    });
  }
  return null;
}
