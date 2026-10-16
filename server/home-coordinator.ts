import { getSqlite } from './store.ts';

/** Keep historical tables intact, but never reinterpret a portable target as Home. */
export function assertHomeCoordinator(
  database = getSqlite(),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.DEPLOY_SUITCASE === '1') {
    throw new Error(
      'Portable coordinators are retired. Export this target before upgrading; enroll computers as execution nodes.',
    );
  }
  if (!database) throw new Error('Database is unavailable');
  const portable = database
    .prepare("SELECT COUNT(*) AS count FROM sites WHERE kind <> 'home'")
    .get() as { count: number };
  const orphaned = database
    .prepare(`SELECT COUNT(*) AS count FROM app_replicas r
    LEFT JOIN sites s ON s.id = r.site_id WHERE s.id IS NULL`)
    .get() as { count: number };
  if (portable.count || orphaned.count) {
    throw new Error(
      'Portable-site records require an export and migration before this upgrade. Existing data has not been removed.',
    );
  }
}
