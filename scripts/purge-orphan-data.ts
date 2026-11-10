import { openDatabase } from '../server/sqlite.ts';
import { resolve } from 'node:path';
import { purgeOrphanedDeploymentData } from '../server/orphan-data.ts';

const args = process.argv.slice(2);
if (
  args.some((arg) => !['--apply', '--dry-run'].includes(arg)) ||
  (args.includes('--apply') && args.includes('--dry-run'))
) {
  throw new Error(
    'Usage: DEPLOY_DATA_DIR=/path node scripts/purge-orphan-data.ts [--dry-run | --apply]',
  );
}
if (!process.env.DEPLOY_DATA_DIR) throw new Error('DEPLOY_DATA_DIR is required');
const root = resolve(process.env.DEPLOY_DATA_DIR);
const apply = args.includes('--apply');
const db = openDatabase(resolve(root, 'deploy.db'), {
  readonly: !apply,
  fileMustExist: true,
  busyTimeoutMs: 5000,
  foreignKeys: true,
});
try {
  const counts = purgeOrphanedDeploymentData(db, root, { apply });
  console.log(
    JSON.stringify(
      { mode: apply ? 'applied' : 'dry-run; no rows deleted without --apply', ...counts },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
