import test from 'node:test';
import assert from 'node:assert/strict';
const { followDeploy, followRollback, printRelease } = await import(
  new URL('../../bin/cli-v2.mjs', import.meta.url).href
);
const steps = ['prepare', 'verify', 'activate', 'watch'].map((name) => ({
  name,
  state: 'done',
  detail: `Real ${name} receipt`,
}));
test('deploy follows the upload-to-release receipt and renders real Verify and Watch steps', async () => {
  const release = {
    id: 'release-1',
    projectId: 'gym',
    state: 'live',
    apps: [],
    migrations: [],
    steps,
  };
  const paths: string[] = [];
  const result = await followDeploy(
    async (path: string) => {
      paths.push(path);
      return { release };
    },
    'home-gym',
    { accepted: true, projectRelease: true, buildLogId: 42 },
    100,
  );
  assert.deepEqual(result, release);
  assert.deepEqual(paths, ['/api/v2/releases/uploads/42']);
  const lines: string[] = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    printRelease(result);
  } finally {
    console.log = log;
  }
  assert(lines.some((line) => line.includes('Verify  done · Real verify receipt')));
  assert(lines.some((line) => line.includes('Watch  done · Real watch receipt')));
});
test('rollback unwraps the real API envelope and polls only its exact receipt', async () => {
  const rollback = { id: 'rollback-1', projectId: 'gym', from: 'new', to: 'old', steps };
  const result = await followRollback(
    async () => ({ rollbacks: [{ ...rollback, id: 'other' }, rollback] }),
    'gym',
    { rollback: { ...rollback, steps: steps.map((step) => ({ ...step, state: 'running' })) } },
    100,
  );
  assert.equal(result.state, 'rolled-back');
  assert.deepEqual(result.steps, steps);
  assert.equal(result.id, 'rollback-1');
});
test('timeouts retain real running steps; failures retain their failed step', async () => {
  const waiting = { id: 'r', state: 'running', steps: [{ name: 'watch', state: 'running' }] };
  assert.deepEqual(
    await followDeploy(async () => ({ release: waiting }), 'gym', { release: waiting }, 0),
    waiting,
  );
  const failed = {
    id: 'r',
    steps: [{ name: 'verify', state: 'failed', detail: 'Copy did not answer' }],
  };
  assert.equal(
    (
      await followRollback(
        async () => {
          throw new Error('must not poll');
        },
        'gym',
        { rollback: failed },
        0,
      )
    ).state,
    'failed',
  );
});
