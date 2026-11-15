import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Computer, Release } from '../../../shared/v2/contracts.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-updates-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save } = await import('../../workspace/store.ts');
const { followRelease, getUpdates, updateState, UPDATE_INTERVAL_MS } = await import('./updates.ts');
const { restartingHtml, controlRestartingPage } = await import('../../edge/restarting.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const computer: Computer = {
  id: 'bazzite',
  name: 'bazzite',
  online: true,
  workerIds: ['worker'],
  roles: ['take-tasks'],
  supportedRoles: ['take-tasks'],
  version: 'old',
  doing: [],
};
const release: Release = {
  id: 'new',
  projectId: 'deploy-project',
  source: { kind: 'ship', ref: 'main' },
  startedBy: 'owner',
  apps: [{ appId: 'deploy.local', to: 'new' }],
  migrations: [],
  steps: [],
  state: 'live',
};
test('only idle, online computers with known older versions are ready', () => {
  assert.equal(UPDATE_INTERVAL_MS, 600000);
  assert.equal(updateState(computer, release).state, 'ready');
  assert.equal(updateState({ ...computer, version: 'new' }, release).state, 'current');
  assert.equal(updateState({ ...computer, online: false }, release).state, 'offline');
  assert.equal(updateState({ ...computer, version: undefined }, release).state, 'unavailable');
  assert.equal(
    updateState(
      { ...computer, doing: [{ id: 'task', kind: 'task', name: 'Task', state: 'unknown' }] },
      release,
    ).state,
    'waiting',
  );
  assert.equal(updateState({ ...computer, roles: ['coordinator'] }, release).state, 'unavailable');
});
test('installation rechecks idleness after reserving and always releases the reservation', async () => {
  let installs = 0,
    unlocks = 0;
  const input = {
    computer: async () => computer,
    release: async () => release,
    reserve: async () => async () => {
      unlocks++;
    },
    install: async () => {
      installs++;
    },
  };
  assert.equal(await followRelease(input), true);
  assert.equal(installs, 1);
  assert.equal(
    await followRelease({
      ...input,
      computer: async () => ({
        ...computer,
        doing: [{ id: 'job', name: 'Job', kind: 'job', state: 'running' }],
      }),
    }),
    false,
  );
  assert.equal(installs, 1);
  assert.equal(unlocks, 2);
  assert.equal(await followRelease({ ...input, reserve: async () => null }), false);
  assert.equal(
    await followRelease({ ...input, release: async () => ({ ...release, state: 'failed' }) }),
    false,
  );
});
test('update target comes from the current project release; failed Watch is never propagated', async () => {
  save('v2-release', 'owner', { id: release.id, release });
  save('v2-project-current', 'owner', { id: release.projectId, releaseId: release.id });
  assert.equal((await getUpdates('owner', [computer])).latestRelease?.id, 'new');
  assert.equal((await getUpdates('other', [computer])).latestRelease, undefined);
  save('v2-release', 'owner', { id: release.id, release: { ...release, state: 'failed' } });
  assert.equal((await getUpdates('owner', [computer])).latestRelease, undefined);
});
test('Restarting is static, escaped, no-store, and retries without coordinator assets', () => {
  const html = restartingHtml('SER', '7f3b2d4');
  assert.match(html, /Updating SER/);
  assert.match(html, /Your apps keep running/);
  assert.match(html, /deploy status/);
  assert.match(html, /http-equiv="refresh" content="5"/);
  assert.doesNotMatch(html, /<script|src=|https?:/);
  assert.ok(!restartingHtml('<script>', '<img>').includes('<script>'));
  let status = 0;
  let headers: any;
  controlRestartingPage({
    writeHead(code: number, value: unknown) {
      status = code;
      headers = value;
    },
    end() {},
  } as any);
  assert.equal(status, 503);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(headers['Retry-After'], '5');
});
