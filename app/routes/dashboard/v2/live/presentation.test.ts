import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appAddress,
  latestError,
  releaseLabel,
  repositoryName,
  runningSubtitle,
} from './presentation.ts';
test('latest error keeps its stack, drops old errors and does not invent an error', () => {
  assert.equal(
    latestError('Error: old\nready\nError: missing column\n  at sync.ts:12\n'),
    'Error: missing column\n  at sync.ts:12',
  );
  assert.equal(latestError('ready\ncompleted 32 jobs'), '');
});

test('release labels prefer source commits without shortening opaque release identities or versions', () => {
  const source = { kind: 'ship' as const, ref: 'main', commit: '9c3e1fa0123456789' };
  assert.equal(releaseLabel('release-uuid', source), '9c3e1fa');
  assert.equal(releaseLabel('v1.122.3'), 'v1.122.3');
  assert.equal(releaseLabel('release-uuid'), 'release-uuid');
  assert.equal(releaseLabel(), 'Unavailable');
});

test('repository names support HTTP, SSH, local and hosted repositories', () => {
  assert.equal(
    repositoryName({ location: 'https://example.test/gabriel/forma.git' }),
    'gabriel/forma',
  );
  assert.equal(repositoryName({ location: 'git@example.test:gabriel/forma.git' }), 'gabriel/forma');
  assert.equal(
    repositoryName({ location: 'ssh://git@example.test/gabriel/forma.git' }),
    'gabriel/forma',
  );
  assert.equal(
    repositoryName({ location: 'https://git@example.test/gabriel/forma.git?token=secret' }),
    'gabriel/forma',
  );
  assert.equal(repositoryName({ path: '/home/gabriel/forma' }), 'forma');
  assert.equal(repositoryName(), undefined);
});

test('Running describes a shared release, and never claims mixed releases have one source', () => {
  const app = {
    appId: 'forma',
    name: 'forma',
    kind: 'web' as const,
    state: 'healthy' as const,
    summary: 'Healthy',
    release: 'uuid',
    source: { kind: 'ship' as const, ref: 'main', commit: 'a1b2c3d0123456789' },
    releasedAt: '2026-11-02T02:28:00',
    address: 'https://forma.local',
  };
  assert.equal(appAddress(app), 'forma.local');
  assert.equal(appAddress({ ...app, address: undefined }), 'no address');
  assert.equal(
    runningSubtitle([app, { ...app, appId: 'jobs' }], 'gabriel/forma'),
    'Release a1b2c3d from gabriel/forma on main, shipped 2:28 AM. Open an app for its health, releases, logs and settings.',
  );
  assert.equal(
    runningSubtitle([app, { ...app, release: 'older' }], 'gabriel/forma'),
    'Open an app for its health, releases, logs and settings.',
  );
  assert.equal(runningSubtitle([]), 'Open an app for its health, releases, logs and settings.');
  assert.equal(
    runningSubtitle([{ ...app, releasedAt: undefined, source: undefined }]),
    'Release uuid. Open an app for its health, releases, logs and settings.',
  );
});

test('project health uses Live states with failure counts and no status for empty projects', async () => {
  const { projectHealth } = await import('./presentation.ts');
  const healthy = { state: 'healthy' as const, summary: 'GET /healthz 200' };
  const failed = { state: 'failing' as const, summary: 'Jobs failing' };
  const stopped = { state: 'stopped' as const, summary: 'Stopped by you' };
  assert.equal(projectHealth([]), undefined);
  assert.deepEqual(projectHealth([healthy]), { kind: 'healthy', label: 'Healthy' });
  assert.deepEqual(projectHealth([healthy, failed, failed]), {
    kind: 'failed',
    label: '2 failing',
  });
  assert.deepEqual(
    projectHealth([{ state: 'warning', summary: '92% of 4 GB for 20 min' }, healthy]),
    { kind: 'attention', label: 'High memory' },
  );
  assert.deepEqual(projectHealth([stopped]), { kind: 'inactive', label: 'Not running' });
  assert.deepEqual(projectHealth([stopped, healthy]), { kind: 'healthy', label: 'Healthy' });
});

test('Live names every project, including folder apps, and keeps Discover provenance', async () => {
  const { projectOrigin } = await import('./presentation.ts');
  const app = {
    appId: 'pantry',
    name: 'pantry',
    kind: 'web' as const,
    state: 'healthy' as const,
    summary: 'Healthy',
  };
  assert.deepEqual(projectOrigin(app, {}), {
    label: 'pantry',
    href: '/dashboard/projects/app%3Apantry',
  });
  assert.deepEqual(projectOrigin({ ...app, project: 'joined' }, { joined: 'recipes' }), {
    label: 'recipes',
    href: '/dashboard/projects/joined',
  });
  assert.deepEqual(projectOrigin({ ...app, fromDiscover: true }, {}), { label: 'From Discover' });
});
