import { getSqlite } from './store.ts';

/**
 * Resolve the one site permitted to execute writerSite jobs for an application.
 *
 * Shared/site-local graphs use Home as the durable side-effect authority. A Follows-one-site graph
 * follows the explicitly recorded volume writer. While a handoff is in progress, the source keeps
 * authority until the durable transfer commits. Missing evidence returns null and therefore blocks
 * writer-only work; callers must never infer authority from the machine they happen to run on.
 */
export function applicationWriterSiteId(appId: string): string | null {
  const sqlite = getSqlite();
  if (!sqlite || !appId) return null;

  const transfer = sqlite
    .prepare(
      `SELECT source_site_id
         FROM volume_authority_transfers
        WHERE app_id = ?
          AND state IN ('requested', 'source-capturing', 'snapshot-ready',
                        'target-restoring', 'target-ready')
        ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(appId) as { source_site_id: string } | undefined;
  if (transfer) return transfer.source_site_id;

  const followsOneSite = sqlite
    .prepare(
      `SELECT site_id
         FROM app_replicas
        WHERE app_id = ? AND removed_at IS NULL AND data_mode = 'follows-one-site-writer'
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(appId) as { site_id: string } | undefined;
  if (followsOneSite) return followsOneSite.site_id;

  const fleet = sqlite
    .prepare('SELECT home_site_id FROM fleets ORDER BY created_at LIMIT 1')
    .get() as { home_site_id: string } | undefined;
  return fleet?.home_site_id || null;
}
