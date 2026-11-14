import type { Database } from '../kernel/db/sqlite.ts';
import { migrateManagedGitCheckouts, rewriteManagedGitUrl } from './git-url-migration.ts';

export function migrateCoordinatorUrls(db: Database, root: string) {
  const origins = ['https://deploy.local'];
  for (const origin of [
    process.env.DEPLOY_COORDINATOR_URL,
    process.env.DEPLOY_MANAGED_WORKER_ORIGIN,
  ])
    if (origin) origins.push(new URL(origin).origin);
  // The workspace bootstrap gate serializes this with other server/worker startups.
  migrateManagedGitCheckouts(root, origins);
  const candidates = db.prepare("SELECT data FROM records WHERE kind='project'").all() as {
    data: string;
  }[];
  if (
    !candidates.some(({ data }) => {
      const source = JSON.parse(data).sourcePath;
      return typeof source === 'string' && rewriteManagedGitUrl(source, origins) !== source;
    })
  )
    return;
  db.transaction(() => {
    const rows = db.prepare("SELECT owner,id,data FROM records WHERE kind='project'").all() as {
      owner: string;
      id: string;
      data: string;
    }[];
    const update = db.prepare(
      "UPDATE records SET data=? WHERE kind='project' AND owner=? AND id=?",
    );
    for (const row of rows) {
      const project = JSON.parse(row.data);
      if (typeof project.sourcePath !== 'string') continue;
      const sourcePath = rewriteManagedGitUrl(project.sourcePath, origins);
      if (sourcePath !== project.sourcePath)
        update.run(JSON.stringify({ ...project, sourcePath }), row.owner, row.id);
    }
  }).immediate();
}
