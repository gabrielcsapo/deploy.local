import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimAgentExecSession,
  closeAgentExecSession,
  createAgentExecSession,
  pollAgentExecSession,
  writeAgentExecOutput,
} from './agent-exec.ts';

test('bridges an exact graph container, terminal input, resize, output, and exit', async () => {
  const session = createAgentExecSession(
    'node-1',
    'medius',
    100,
    40,
    'deploy-sh-medius-worker-2-a1b2c3d4-instance',
  );
  const claimed = claimAgentExecSession('node-1');
  assert.ok(claimed);
  assert.equal(claimed.deploymentName, 'medius');
  assert.equal(claimed.containerName, 'deploy-sh-medius-worker-2-a1b2c3d4-instance');
  assert.equal(claimed.cols, 100);
  assert.equal(claimed.rows, 40);

  session.write('ls\n');
  session.resize(120, 50);
  const control = pollAgentExecSession(claimed.id, 'node-1');
  assert.deepEqual(control, {
    input: [Buffer.from('ls\n').toString('base64')],
    resize: { cols: 120, rows: 50 },
    kill: false,
  });

  const outputPromise = new Promise<Buffer>((resolvePromise) =>
    session.once('data', resolvePromise),
  );
  assert.equal(
    writeAgentExecOutput(claimed.id, 'node-1', Buffer.from('result\n').toString('base64')),
    true,
  );
  assert.equal((await outputPromise).toString(), 'result\n');

  const exitPromise = new Promise<{ code: number | null }>((resolvePromise) =>
    session.once('exit', resolvePromise),
  );
  assert.equal(closeAgentExecSession(claimed.id, 'node-1', { code: 0 }), true);
  assert.deepEqual(await exitPromise, { code: 0 });
  assert.equal(session.closed, true);
});
