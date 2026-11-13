import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'kernel-records-'));
process.env.DEPLOY_DATA_DIR = root;
const workspace = await import('./workspace/store.ts');
const records = await import('./kernel/db/records.ts');
const operations = await import('./kernel/db/operations.ts');
after(() => {
  workspace.db.close();
  rmSync(root, { recursive: true, force: true });
});

test('compatibility functions share one record store, observers and operation replay', () => {
  for (const name of ['save', 'get', 'list', 'remove', 'onRecordChange'] as const)
    assert.equal(workspace[name], records[name]);
  for (const name of ['command', 'commandReplay'] as const)
    assert.equal(workspace[name], operations[name]);
  const changes: any[] = [];
  workspace.onRecordChange(['fixture'], (owner, kind, row, previous) => {
    changes.push({ owner, kind, row, previous });
    workspace.event(owner, '', null, 'record.changed', { row, previous });
  });
  assert.throws(
    () =>
      operations.command('owner', 'rolled-back', () => {
        records.save('fixture', 'owner', { id: 'same', value: 'rollback' });
        assert.equal(
          changes.length,
          1,
          'observers still run synchronously in the caller transaction',
        );
        throw new Error('rollback');
      }),
    /rollback/,
  );
  assert.deepEqual(workspace.events('owner'), []);
  assert.deepEqual(records.list('fixture', 'owner'), []);
  assert.deepEqual(operations.commandReplay('owner', 'rolled-back'), { found: false });
  const result = operations.command(
    'owner',
    'committed',
    () => {
      records.save('fixture', 'owner', { id: 'same', value: 'committed', omitted: undefined });
      return { ok: true };
    },
    'signature',
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    workspace.command('owner', 'committed', () => assert.fail('must replay'), 'signature'),
    result,
  );
  assert.throws(() => workspace.commandReplay('owner', 'committed', 'different'), { status: 409 });
  records.save('fixture', 'other', { id: 'same', value: 'private' });
  records.remove('fixture', 'owner', 'same');
  assert.deepEqual(records.get('fixture', 'other', 'same'), { id: 'same', value: 'private' });
  assert.throws(() => records.get('fixture', 'owner', 'same'), { status: 404 });
  assert.deepEqual(changes[1].row, { id: 'same', value: 'committed' });
  assert.deepEqual(changes.at(-1).previous, { id: 'same', value: 'committed' });
  assert.equal(workspace.events('owner').length, 2);
});

test('feature job adapter retains legacy output through metadata writes and scoped deletion', () => {
  records.save('job', 'owner', { id: 'job', status: 'running', output: 'first' });
  const metadata = records.list('job', 'owner')[0];
  assert.equal(Object.hasOwn(metadata, 'output'), false);
  workspace.db
    .prepare(
      "UPDATE records SET data=json_set(data,'$.output',?) WHERE kind='job' AND owner=? AND id=?",
    )
    .run('legacy replacement', 'owner', 'job');
  records.save('job', 'owner', { ...metadata, status: 'done' });
  assert.equal(records.get('job', 'owner', 'job').output, 'legacy replacement');
  assert.equal(workspace.jobOutput('owner', 'job'), 'legacy replacement');
  records.save('job', 'other', { id: 'job', output: 'private' });
  records.remove('job', 'owner', 'job');
  assert.equal(workspace.jobOutput('owner', 'job'), '');
  assert.equal(records.get('job', 'other', 'job').output, 'private');
});
