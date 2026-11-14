import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'jobs-reservations-'));
process.env.DEPLOY_DATA_DIR = root;
const updates = await import('./v2/update-admission.ts');
const readers = await import('./kernel/computers/reservations.ts');
const { db, save, remove } = await import('./workspace/store.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('old admission writes the exact reservation shape read by existing computer readers', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1794612345678 });
  save('v2-computer-roles', 'alice', { id: 'computer', workerIds: ['one', 'two'] });
  save('v2-computer-roles', 'bob', { id: 'computer', workerIds: ['three'] });
  save('v2-computer-roles', 'alice', { id: 'other', workerIds: ['elsewhere'] });
  assert.equal(
    updates.withUpdateAdmission(() => updates.reserveComputerUpdate('computer', 'job')),
    true,
  );
  const expected = {
    id: 'computer',
    jobId: 'job',
    workers: [
      { owner: 'alice', id: 'one' },
      { owner: 'alice', id: 'two' },
      { owner: 'bob', id: 'three' },
    ],
    at: Date.now(),
  };
  assert.deepEqual(readers.updateReservation('computer'), expected);
  assert.deepEqual(
    db.prepare("SELECT kind,id,owner,data FROM records WHERE kind='v2-update-reservation'").all(),
    [
      {
        kind: 'v2-update-reservation',
        id: 'computer',
        owner: 'system',
        data: JSON.stringify(expected),
      },
    ],
  );
  assert.equal(readers.workerUpdateReserved('bob', 'three'), true);
  assert.equal(readers.workerUpdateReserved('alice', 'three'), false);
  assert.equal(readers.workerUpdateReserved('alice', 'elsewhere'), false);
  t.mock.timers.tick(1);
  assert.equal(updates.reserveComputerUpdate('computer', 'other-job'), false);
  assert.equal(updates.reserveComputerUpdate('computer', 'job'), false);
  assert.deepEqual(readers.updateReservation('computer'), expected);
  updates.releaseComputerUpdate('computer', 'other-job');
  assert.deepEqual(readers.updateReservation('computer'), expected);
  updates.releaseComputerUpdate('computer', 'job');
  assert.equal(readers.updateReservation('computer'), undefined);
  assert.equal(readers.workerUpdateReserved('bob', 'three'), false);
  updates.releaseComputerUpdate('computer', 'job');
});

test('idleness decisions stay with admission, including unknown work and suspended sessions', () => {
  save('v2-computer-roles', 'alice', { id: 'busy', workerIds: ['busy-worker'] });
  for (const kind of ['run', 'job', 'interactive-session']) {
    for (const status of ['queued', 'starting', 'running', 'unknown', 'stopped', 'suspended']) {
      save(kind, 'alice', { id: 'work', workerId: 'busy-worker', status });
      const busy =
        kind === 'interactive-session'
          ? !['stopped', 'suspended'].includes(status)
          : ['starting', 'running', 'unknown'].includes(status);
      assert.equal(updates.reserveComputerUpdate('busy', 'update'), !busy, `${kind}: ${status}`);
      assert.equal(Boolean(readers.updateReservation('busy')), !busy);
      updates.releaseComputerUpdate('busy', 'update');
      remove(kind, 'alice', 'work');
    }
  }
});

test('a legacy durable reservation survives reopening and releases only for its job', () => {
  const legacy = { id: 'legacy', jobId: 'legacy-job', workers: [], at: 123 };
  db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(
    'v2-update-reservation',
    legacy.id,
    'system',
    JSON.stringify(legacy),
  );
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    const updates = await import(${JSON.stringify(new URL('./v2/update-admission.ts', import.meta.url).href)});
    const { db } = await import(${JSON.stringify(new URL('./workspace/store.ts', import.meta.url).href)});
    assert.deepEqual(updates.updateReservation('legacy'), ${JSON.stringify(legacy)});
    assert.equal(updates.reserveComputerUpdate('legacy', 'new-job'), false);
    updates.releaseComputerUpdate('legacy', 'new-job');
    assert.deepEqual(updates.updateReservation('legacy'), ${JSON.stringify(legacy)});
    updates.releaseComputerUpdate('legacy', 'legacy-job');
    db.close();
  `,
  ]);
  assert.equal(readers.updateReservation('legacy'), undefined);
});

test('CI without registration still permits work and tracks only in-process activity', () => {
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    const fence = await import(${JSON.stringify(new URL('./ci-fence.ts', import.meta.url).href)});
    fence.assertCiMutation('unconfigured');
    assert.equal(fence.ciMutationActive('unconfigured'), false);
    await fence.withApplicationMutation('unconfigured', async () => {
      assert.equal(fence.ciMutationActive('unconfigured'), true);
    });
    assert.equal(fence.ciMutationActive('unconfigured'), false);
  `,
  ]);
});

test('the old release path and new writer share the existing reader and durable records', async () => {
  const writer = await import('./kernel/jobs/update-reservation.ts');
  assert.equal(updates.releaseComputerUpdate, writer.releaseComputerUpdate);
  assert.equal(updates.updateReservation, readers.updateReservation);
  assert.equal(updates.workerUpdateReserved, readers.workerUpdateReserved);
  const workers = [{ owner: 'new-owner', id: 'new-worker' }];
  writer.saveComputerUpdateReservation('new-computer', 'new-job', workers);
  const expected = readers.updateReservation('new-computer');
  assert.deepEqual(expected.workers, workers);
  // A legacy process reads the unchanged record without importing the new writer.
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    const { db } = await import(${JSON.stringify(new URL('./workspace/store.ts', import.meta.url).href)});
    const row = db.prepare("SELECT data FROM records WHERE kind='v2-update-reservation' AND owner='system' AND id=?").get('new-computer');
    assert.deepEqual(JSON.parse(row.data), ${JSON.stringify(expected)});
    db.close();
  `,
  ]);
  updates.releaseComputerUpdate('new-computer', 'wrong-job');
  assert.deepEqual(readers.updateReservation('new-computer'), expected);
  updates.releaseComputerUpdate('new-computer', 'new-job');
  assert.equal(readers.updateReservation('new-computer'), undefined);
});

test('kernel writer refuses an unregistered database without opening one', () => {
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    const writer = await import(${JSON.stringify(new URL('./kernel/jobs/update-reservation.ts', import.meta.url).href)});
    for (const action of [
      () => writer.saveComputerUpdateReservation('computer', 'job', []),
      () => writer.releaseComputerUpdate('computer', 'job'),
    ]) assert.throws(action, {message: 'Database not registered: workspace'});
  `,
  ]);
});
