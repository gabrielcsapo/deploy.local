import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-history-'));
const { db, event, events, recentEvents, cursor } = await import('./store.ts');

test('long task snapshots show latest activity while replay retains all older pages and owner isolation', () => {
  db.transaction(() => {
    for (let i = 0; i < 2500; i++) {
      event('owner', 'task', 'run', 'step', { index: i });
      event('other-owner', 'task', 'run', 'private', { index: i });
      event('owner', 'another-task', 'run', 'unrelated', { index: i });
    }
  })();
  const recent = recentEvents('owner', 'task');
  assert.equal(recent.length, 1000);
  assert.equal(recent[0].payload.index, 1500);
  assert.equal(recent.at(-1)?.payload.index, 2499);
  assert.ok(recent.every((e) => e.type === 'step'));
  let after = 0;
  const history: any[] = [];
  for (;;) {
    const page = events('owner', after, 'task');
    if (!page.length) break;
    history.push(...page);
    after = page.at(-1)!.cursor;
  }
  assert.equal(history.length, 2500);
  assert.equal(new Set(history.map((e) => e.cursor)).size, 2500);
  assert.deepEqual(
    history.map((e) => e.payload.index),
    Array.from({ length: 2500 }, (_, i) => i),
  );
  const watermark = cursor('owner');
  event('owner', 'task', 'run', 'run.succeeded', {});
  assert.equal(events('owner', watermark, 'task')[0].type, 'run.succeeded');
  assert.equal(recentEvents('missing-owner', 'task').length, 0);
});
