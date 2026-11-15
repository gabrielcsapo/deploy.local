import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'checkpoint-metadata-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, list, get, save, listCheckpointMetadata, checkpointInfo } =
  await import('../../workspace/store.ts');
const { taskSnapshot } = await import('../../v2/tasks.ts');
const { publishHead } = await import('./checkpoint-publish.ts');
test.after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('old-only database: task metadata is indexed, owner scoped, and never parses bodies', (t) => {
  const snapshot = {
    files: [
      { path: 'large.txt', content: 'BODY_SENTINEL' + 'x'.repeat(1024 * 1024), executable: true },
    ],
    excluded: ['excluded.txt'],
    digest: 'content-digest',
    base: { commit: 'a'.repeat(40) },
    deleted: ['removed.txt'],
  };
  const insert = db.prepare("INSERT INTO records VALUES('checkpoint',?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      insert.run(
        String(i),
        'owner',
        JSON.stringify({
          id: String(i),
          taskId: 'task-' + i,
          runId: 'run',
          createdAt: '2026-01-01T12:00:00Z',
          snapshot,
          title: 'Keep the title',
          summary: 'Keep the summary',
        }),
      );
    }
    insert.run('foreign', 'other', JSON.stringify({ id: 'foreign', taskId: 'task-0', snapshot }));
  })();
  save('task', 'owner', { id: 'task-0', title: 'Task', status: 'ready' });
  save('run', 'owner', {
    id: 'run',
    taskId: 'task-0',
    status: 'succeeded',
    createdAt: '2026-01-01T11:00:00Z',
  });
  const parse = JSON.parse;
  let parsedBytes = 0;
  JSON.parse = (text, ...args) => {
    assert.ok(!text.includes('BODY_SENTINEL'), 'metadata read parsed a snapshot body');
    parsedBytes += Buffer.byteLength(text);
    return Reflect.apply(parse, JSON, [text, ...args]);
  };
  try {
    const rows = listCheckpointMetadata('owner', 'task-0');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Keep the title');
    assert.equal(rows[0].snapshot, undefined);
    assert.deepEqual(checkpointInfo(rows[0]), checkpointInfo({ snapshot }));
    assert.equal(taskSnapshot('owner', 'task-0').checkpoints.length, 1);
    assert.equal(publishHead('owner', 'task-0').checkpointId, null); // exclusions still block
    assert.equal(listCheckpointMetadata('owner').length, 100);
  } finally {
    JSON.parse = parse;
  }
  assert.deepEqual(get('checkpoint', 'owner', '0').snapshot, snapshot);
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind='checkpoint' AND owner=? AND json_extract(data,'$.taskId')=?",
    )
    .all('owner', 'task-0');
  assert.match(JSON.stringify(plan), /record_checkpoint_task/);
  const median = (fn: () => unknown) => {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      fn();
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[2];
  };
  const before = median(() => list('checkpoint', 'owner').filter((row) => row.taskId === 'task-0'));
  const after = median(() => listCheckpointMetadata('owner', 'task-0'));
  const beforeJsonBytes = (
    db
      .prepare(
        "SELECT sum(length(CAST(data AS BLOB))) AS n FROM records WHERE kind='checkpoint' AND owner='owner'",
      )
      .get() as { n: number }
  ).n;
  const afterJsonBytes = listCheckpointMetadata('owner', 'task-0').reduce(
    (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)),
    0,
  );
  t.diagnostic(
    JSON.stringify({
      checkpoints: 100,
      snapshotMiB: 1,
      beforeMs: before,
      afterMs: after,
      beforeJsonBytes,
      afterJsonBytes,
      parsedBytes,
    }),
  );
});
