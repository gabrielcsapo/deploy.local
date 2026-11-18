import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-worker-update-'));
const { workerUpdate, workerBuild, agentTools } = await import('./worker-update.ts');
const { workerCommand } = await import('../../workspace/protocol.ts');
const { get } = await import('../../workspace/store.ts');
const { computers } = await import('../../workspace/coordination.ts');
const { capabilities } = await import('../../workspace/service.ts');
const tools = ['deploy_checkpoint', 'deploy_commit', 'deploy_application'];

test('version and tool reports independently detect outdated workers', () => {
  const current = { id: 'remote', build: { version: '1.10.0' }, agentTools: tools };
  assert.equal(workerUpdate(current, '1.10.0', tools).state, 'current');
  assert.equal(
    workerUpdate({ ...current, build: { version: '1.9.0' } }, '1.10.0', tools).state,
    'outdated',
  );
  assert.equal(
    workerUpdate({ ...current, build: { version: '1.11.0' } }, '1.10.0', tools).state,
    'current',
  );
  const outdated = workerUpdate({ ...current, agentTools: ['deploy_checkpoint'] }, '1.10.0', tools);
  assert.equal(outdated.state, 'outdated');
  assert.deepEqual(outdated.missingTools, ['deploy_commit', 'deploy_application']);
  assert.match(outdated.reason, /Agents here can't use: deploy_commit, deploy_application/);
  assert.equal(workerUpdate({ ...current, agentTools: [] }, '1.10.0', tools).state, 'outdated');
  assert.equal(
    workerUpdate({ ...current, agentTools: [...tools, 'deploy_future'] }, '1.10.0', tools).state,
    'current',
  );
});

test('semver compares prereleases numerically and ignores build metadata and commit mismatch', () => {
  const check = (version: string, coordinator: string) =>
    workerUpdate(
      { id: 'remote', build: { version, commit: 'abcdef1' }, agentTools: tools },
      coordinator,
      tools,
    ).state;
  assert.equal(check('1.0.0-beta.2', '1.0.0-beta.10'), 'outdated');
  assert.equal(check('1.0.0-beta', '1.0.0'), 'outdated');
  assert.equal(check('1.0.0', '1.0.0-beta'), 'current');
  assert.equal(check('1.0.0+abcdef', '1.0.0+ghijkl'), 'current');
  assert.equal(check('invalid', '1.0.0'), 'unknown');
});

test('legacy and incomplete reports are unknown without inventing missing tool names', () => {
  const unknown = workerUpdate({ id: 'legacy' }, '1.0.0', tools);
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.missingTools, []);
  assert.match(unknown.reason, /newer agent tools/);
  assert.equal(
    workerUpdate({ id: 'remote', build: { version: '1.0.0' } }, '1.0.0', tools).state,
    'unknown',
  );
  assert.equal(workerUpdate({ id: 'remote', agentTools: tools }, '1.0.0', tools).state, 'unknown');
  assert.equal(
    workerUpdate({ id: 'remote', build: { version: '0.9.0' } }, '1.0.0', tools).state,
    'outdated',
  );
});

test('local and managed workers are always current even with old or incomplete reports', () => {
  for (const id of ['local', 'managed-owner']) {
    assert.equal(workerUpdate({ id }, '2.0.0', tools).state, 'current');
    assert.deepEqual(
      workerUpdate({ id, build: { version: '0.1.0' }, agentTools: [] }, '2.0.0', tools)
        .missingTools,
      [],
    );
  }
});

test('registration and heartbeat store sanitized reports; older protocol remains compatible', async () => {
  const owner = 'worker-build-owner';
  const body = {
    workerId: 'remote',
    platform: 'linux',
    codex: true,
    build: { version: workerBuild.version, commit: 'abcdef123456' },
    agentTools,
  };
  workerCommand(owner, '/workers/register', body);
  assert.deepEqual(get('worker', owner, 'remote').build, body.build);
  assert.deepEqual(get('worker', owner, 'remote').agentTools, agentTools);
  assert.equal(computers(owner).find((w) => w.id === 'remote')?.update.state, 'current');
  workerCommand(owner, '/workers/remote/poll', {
    build: { version: '0.0.1', commit: 'not a commit' },
    agentTools: ['deploy_checkpoint', 'deploy_checkpoint', 12, 'bad\ninstruction'],
  });
  assert.deepEqual(get('worker', owner, 'remote').build, { version: '0.0.1' });
  assert.deepEqual(get('worker', owner, 'remote').agentTools, ['deploy_checkpoint']);
  const update = computers(owner).find((w) => w.id === 'remote')!.update;
  assert.equal(update.state, 'outdated');
  assert.ok(update.missingTools.includes('deploy_commit'));
  // /state spreads the capabilities projection; it must preserve update data.
  assert.deepEqual(
    (await capabilities(owner)).workers.find((w) => w.id === 'remote')?.update,
    update,
  );
  workerCommand(owner, '/workers/remote/poll', {});
  assert.deepEqual(get('worker', owner, 'remote').agentTools, ['deploy_checkpoint']);
  workerCommand(owner, '/workers/register', { workerId: 'legacy', platform: 'linux', codex: true });
  assert.equal(computers(owner).find((w) => w.id === 'legacy')?.update.state, 'unknown');
  assert.deepEqual(workerCommand(owner, '/workers/legacy/poll', {}), { run: null });
  // Re-registering an old build must not inherit a previous process's tool report.
  workerCommand(owner, '/workers/register', { workerId: 'remote', platform: 'linux' });
  assert.equal(get('worker', owner, 'remote').agentTools, undefined);
});
