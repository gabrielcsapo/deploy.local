import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../server/kernel/db/index.ts';
import { indexProject } from '../server/features/code-index/index-project.ts';
import { openIndex, readStatus } from '../server/features/code-index/database.ts';

const folder = mkdtempSync(join(tmpdir(), 'deploy-code-benchmark-'));
try {
  const source = resolve(process.argv[2] ?? '.');
  const branch = execFileSync('git', ['-C', source, 'symbolic-ref', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const repositoryPath = join(folder, 'project.git');
  execFileSync('git', ['clone', '--quiet', '--bare', '--shared', source, repositoryPath]);
  const workspace = join(folder, 'workspace.db');
  const database = join(folder, 'code-index.db');
  const catalog = openDatabase(workspace);
  catalog.exec('CREATE TABLE records (kind TEXT, id TEXT, owner TEXT, data TEXT)');
  catalog.prepare('INSERT INTO records VALUES (?,?,?,?)').run(
    'project',
    'benchmark',
    'benchmark',
    JSON.stringify({
      name: 'deploy.local',
      defaultBranch: branch,
      repositoryPath,
    }),
  );
  catalog.close();
  const start = performance.now();
  await indexProject({ database, workspace, project: 'benchmark', owner: 'benchmark' });
  const elapsedMs = Math.round(performance.now() - start);
  const db = openIndex(database);
  const totals = Object.fromEntries(
    ['files', 'symbols', 'exports', 'references'].map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) count FROM code_${table}`).get().count,
    ]),
  );
  const coverage = db
    .prepare('SELECT coverage,COUNT(*) files,SUM(lines) AS lines FROM code_files GROUP BY coverage')
    .all();
  const status = readStatus(db, 'benchmark', 'benchmark');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log(
    JSON.stringify(
      { ...status, elapsedMs, databaseBytes: statSync(database).size, ...totals, coverage },
      null,
      2,
    ),
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
