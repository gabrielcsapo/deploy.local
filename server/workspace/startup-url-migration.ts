import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from '../kernel/db/sqlite.ts';
import { migrateManagedGitCheckouts, rewriteManagedGitUrl } from './git-url-migration.ts';

export function migrateCoordinatorUrls(db: Database, root: string) {
  // Once per data folder: the walk reads every managed checkout, and every process that opens
  // the store would otherwise repeat it. Checkouts made after the cut already use the new address.
  const done = resolve(root, '.git-addresses-migrated');
  if (existsSync(done)) return;
  const mark = () => {
    try {
      writeFileSync(done, new Date().toISOString() + '\n');
    } catch {
      // No data folder to mark (a test, a read-only volume): the next start checks again.
    }
  };
  const origins = ['https://deploy.local'];
  for (const origin of [
    process.env.DEPLOY_COORDINATOR_URL,
    process.env.DEPLOY_MANAGED_WORKER_ORIGIN,
  ])
    if (origin) origins.push(new URL(origin).origin);
  // The workspace bootstrap gate serializes this with other server/worker startups.
  const failed: string[] = [];
  try {
    migrateManagedGitCheckouts(root, origins, failed);
  } catch (error) {
    failed.push(String(error));
  }
  if (failed.length)
    console.error(
      `[git addresses] ${failed.length} checkout(s) not rewritten yet:`,
      failed.slice(0, 5),
    );
  const candidates = db.prepare("SELECT data FROM records WHERE kind='project'").all() as {
    data: string;
  }[];
  if (
    !candidates.some(({ data }) => {
      const source = JSON.parse(data).sourcePath;
      return typeof source === 'string' && rewriteManagedGitUrl(source, origins) !== source;
    })
  ) {
    if (!failed.length) mark();
    return;
  }
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
  if (!failed.length) mark();
}
