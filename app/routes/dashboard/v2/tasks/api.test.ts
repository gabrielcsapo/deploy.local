import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePull, parsePatch, shipProject } from './api.ts';

test('Ship sends only a user-triggered source request and returns the project release', async () => {
  let calls = 0;
  const release = { id: '9c3e1fa', projectId: 'home gym', steps: [] };
  const request = (async (path, init) => {
    calls++;
    assert.equal(path, '/api/v2/projects/home%20gym/releases');
    assert.equal(init?.method, 'POST');
    // The release-plan API also takes the ref at the top level; choices are omitted when unset.
    assert.deepEqual(JSON.parse(String(init?.body)), {
      source: { kind: 'ship', ref: 'refs/deploy/tasks/one' },
      ref: 'refs/deploy/tasks/one',
    });
    return Response.json({ release });
  }) as typeof fetch;
  assert.deepEqual(await shipProject(request, 'home gym', 'refs/deploy/tasks/one'), release);
  assert.equal(calls, 1);
});
test('Ship feature detection reports 404 without a fallback or retry', async () => {
  let calls = 0;
  await assert.rejects(
    shipProject(
      (async () => {
        calls++;
        return new Response('', { status: 404 });
      }) as typeof fetch,
      'p',
      'main',
    ),
    { message: 'Shipping needs the new release engine on this coordinator' },
  );
  assert.equal(calls, 1);
});
test('Ship preserves auth and server failures and rejects an absent release', async () => {
  for (const status of [401, 403, 409, 500])
    await assert.rejects(
      shipProject(
        (async () => Response.json({ error: 'Denied' }, { status })) as typeof fetch,
        'p',
        'main',
      ),
      { message: 'Denied' },
    );
  await assert.rejects(
    shipProject((async () => Response.json({})) as typeof fetch, 'p', 'main'),
    /no release/,
  );
});
test('Merge pins the reviewed PR revision and both commits to the existing route', async () => {
  const pull = {
    id: 'pr',
    number: 18,
    title: 'Fix',
    status: 'open',
    revision: 4,
    sourceBranch: 'fix',
    targetBranch: 'main',
    taskIds: ['task'],
  };
  await mergePull(
    (async (path, init) => {
      assert.equal(path, '/api/workspace/projects/p/pulls/pr/merge');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.revision, 4);
      assert.equal(body.baseCommit, 'a');
      assert.equal(body.headCommit, 'b');
      assert.ok(body.operationId);
      return Response.json({});
    }) as typeof fetch,
    'p',
    pull,
    { patch: '', baseCommit: 'a', headCommit: 'b' },
  );
  assert.throws(() => mergePull(fetch, 'p', pull, { patch: '' }), /current changes/);
});
test('Diff preserves changed-file names, counts, hunks and independent line numbers', () => {
  const files = parsePatch(
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,2 @@\n same\n-old\n+new\ndiff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ',
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.deepEqual(files[0].lines.at(-1), { kind: 'add', new: 3, text: 'new' });
  assert.match(files[1].lines[0].text, /Binary files/);
});

test('Release events update live steps only for this project, without starting another release', async () => {
  const { updateTaskFromEvents } = await import('./api.ts');
  const view = {
    task: { id: 't' },
    project: { id: 'p' },
    events: [],
    releases: [],
  } as unknown as import('./types.ts').TaskView;
  const release = {
    id: 'r',
    projectId: 'p',
    state: 'running',
    steps: [{ name: 'prepare', state: 'running' }],
  } as import('../../../../../shared/v2/contracts.ts').Release;
  const started = updateTaskFromEvents(view, [{ type: 'release', release }]);
  const done = updateTaskFromEvents(started, [
    {
      type: 'release',
      release: { ...release, state: 'live', steps: [{ name: 'prepare', state: 'done' }] },
    },
    { type: 'release', release: { ...release, id: 'other', projectId: 'elsewhere' } },
  ]);
  assert.equal(done.releases.length, 1);
  assert.equal(done.releases[0].state, 'live');
  assert.equal(done.releases[0].steps[0].state, 'done');
  const event = {
    kind: 'reply',
    id: 'message',
    at: '',
    agent: 'scout',
    paragraphs: ['Done'],
  } as const;
  const other = updateTaskFromEvents(done, [
    { type: 'conversation', taskId: 'other', event: { ...event, paragraphs: ['Done'] } },
  ]);
  assert.equal(other.events.length, 0);
});

test('PR checks read jobs only from the latest run of the displayed commit', async () => {
  const { readPullChecks } = await import('./api.ts');
  const paths: string[] = [];
  const request = (async (path) => {
    paths.push(String(path));
    return Response.json(
      String(path).endsWith('/pulls/pr')
        ? {
            checks: [
              { id: 'old-green', commit: 'old' },
              { id: 'current', commit: 'head' },
            ],
          }
        : { jobs: [{ id: 'test', name: 'Tests', status: 'failed', output: 'One failed' }] },
    );
  }) as typeof fetch;
  const checks = await readPullChecks(request, 'p', 'pr', 'head');
  assert.equal(paths[1], '/api/workspace/projects/p/pipelines/current');
  assert.equal(checks[0].status, 'failed');
  assert.equal(checks[0].headCommit, 'head');
  paths.length = 0;
  assert.deepEqual(await readPullChecks(request, 'p', 'pr', 'unbuilt'), []);
  assert.equal(paths.length, 1);
});
