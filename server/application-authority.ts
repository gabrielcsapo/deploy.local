import { getSqlite } from './store.ts';

/** Home runs writer-only jobs at the coordinator or an enrolled worker placement. */
export function applicationWriterSiteId(appId: string, siteId: string): string | null {
  const sqlite = getSqlite();
  if (!sqlite || !appId) return null;

  const home =
    (
      sqlite.prepare('SELECT home_site_id FROM fleets ORDER BY created_at LIMIT 1').get() as
        | { home_site_id: string }
        | undefined
    )?.home_site_id || null;

  if (home && isHomePlacement(sqlite, siteId, home)) return siteId;
  return home;
}

function isHomePlacement(
  sqlite: NonNullable<ReturnType<typeof getSqlite>>,
  siteId: string,
  home: string,
): boolean {
  if (siteId === 'coordinator' || siteId === home) return true;
  return Boolean(
    sqlite.prepare('SELECT 1 FROM nodes WHERE id = ? AND revoked_at IS NULL').get(siteId),
  );
}
