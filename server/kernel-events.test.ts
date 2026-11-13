import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'kernel-events-'));
process.env.DEPLOY_DATA_DIR = root;
const workspace = await import('./workspace/store.ts');
const kernel = await import('./kernel/events/index.ts');
const { namedDatabase } = await import('./kernel/db/named-store.ts');
const { waitForEvents } = await import('./workspace/event-feed.ts');
after(() => {
  workspace.db.close();
  rmSync(root, { recursive: true, force: true });
});

function externalRead(owner: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { openDatabase } from './server/kernel/db/sqlite.ts';
    import { registerDatabase } from './server/kernel/db/named-store.ts';
    import { events, cursor } from './server/kernel/events/index.ts';
    const db = openDatabase(process.env.EVENT_DATABASE, { readonly: true });
    registerDatabase('workspace', db);
    console.log(JSON.stringify({ events: events(process.env.EVENT_OWNER), cursor: cursor(process.env.EVENT_OWNER) }));
    db.close();
  `,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, EVENT_DATABASE: workspace.db.name, EVENT_OWNER: owner },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('old and kernel paths share the event functions and registered database', () => {
  for (const name of ['event', 'events', 'cursor'] as const)
    assert.equal(workspace[name], kernel[name]);
  assert.equal(namedDatabase('workspace'), workspace.db);
});

test('caller transaction hides appends until commit and rolls back without advancing the cursor', () => {
  const owner = 'transaction';
  workspace.db.transaction(() => {
    kernel.event(owner, 'task', null, 'first', { text: 'committed' });
    assert.deepEqual(externalRead(owner), { events: [], cursor: 0 });
  })();
  const committed = externalRead(owner);
  assert.equal(committed.events.length, 1);
  assert.equal(committed.events[0].payload.text, 'committed');
  assert.equal(committed.cursor, committed.events[0].cursor);
  assert.throws(
    () =>
      workspace.db.transaction(() => {
        kernel.event(owner, 'task', null, 'rollback', {});
        assert.deepEqual(externalRead(owner), committed);
        throw new Error('rollback');
      })(),
    /rollback/,
  );
  assert.deepEqual(externalRead(owner), committed);
  kernel.event(owner, 'task', null, 'next', {});
  assert.ok(kernel.cursor(owner) > committed.cursor);
  assert.deepEqual(
    kernel.events(owner, committed.cursor).map((row) => row.type),
    ['next'],
  );
});

test('a same-process append wakes owner and raw feed waiters through polling', async () => {
  const owner = 'same-process';
  const poller = kernel.createOwnerEventPoller({ head: kernel.cursor, refresh: async () => {} });
  const signal = AbortSignal.timeout(2000);
  const ownerWait = poller.wait(owner, 0, Date.now() + 1000, signal);
  const rawWait = waitForEvents(owner, 0, 'task', 1000, signal);
  workspace.db.transaction(() => kernel.event(owner, 'task', null, 'wake', {}))();
  await ownerWait;
  const page = await rawWait;
  assert.equal(page.events[0].type, 'wake');
  assert.equal(page.cursor, kernel.cursor(owner));
});

test('an independent-process append wakes the same waiters without IPC', async () => {
  const owner = 'external-process';
  const poller = kernel.createOwnerEventPoller({ head: kernel.cursor, refresh: async () => {} });
  const signal = AbortSignal.timeout(3000);
  const ownerWait = poller.wait(owner, 0, Date.now() + 2000, signal);
  const rawWait = waitForEvents(owner, 0, undefined, 2000, signal);
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { db, event } from './server/workspace/store.ts';
    db.transaction(() => event('external-process', 'task', null, 'external', {}))();
    db.close();
  `,
    ],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(result.status, 0, result.stderr);
  await ownerWait;
  const page = await rawWait;
  assert.equal(page.events[0].type, 'external');
  assert.equal(page.cursor, kernel.cursor(owner));
});
