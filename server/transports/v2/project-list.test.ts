import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'v2-project-list-'));
process.env.DEPLOY_DATA_DIR = root;
await import('../../test-ports.ts');
const store = await import('../../store.ts');
const { getRequestsSqlite } = await import('../../requests-db.ts');
const { readProjectList } = await import('./project-list.ts');
after(() => rmSync(root, { recursive: true, force: true }));

test('a live project carries its requests for each of the last 24 hours, oldest first', async () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 10, 17, 15, 20);
  const thisHour = Math.floor(now / HOUR) * HOUR;
  store.saveDeployment({ name: 'web', username: 'owner' });
  store.saveDeployment({ name: 'other', username: 'someone-else' });
  const insert = getRequestsSqlite().prepare(
    'INSERT INTO request_logs_1m(deployment_name, bucket_ms, count) VALUES(?,?,?)',
  );
  insert.run('web', thisHour + 60_000, 4);
  insert.run('web', thisHour + 120_000, 3);
  insert.run('web', thisHour - 23 * HOUR, 5);
  // Older than the window, and another owner's app.
  insert.run('web', thisHour - 24 * HOUR, 99);
  insert.run('other', thisHour, 50);
  const list = await readProjectList('owner', undefined, now);
  assert.deepEqual(
    list.live.map((project) => project.name),
    ['web'],
  );
  assert.deepEqual(list.live[0].traffic, {
    from: thisHour - 23 * HOUR,
    hourly: [5, ...new Array(22).fill(0), 7],
  });
  assert.deepEqual(list.counts, { live: 1, repositories: 0, archived: 0 });
});
