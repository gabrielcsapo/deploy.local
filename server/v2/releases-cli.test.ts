import test from 'node:test';
import assert from 'node:assert/strict';
const { followDeploy, followRelease, followRollback, printRelease, releaseReporter, elapsed } =
  await import(new URL('../../bin/cli-v2.mjs', import.meta.url).href);
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

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 10, 11, 5, 17, 33) + seconds * 1000).toISOString();
function reported(live = false, now = Date.parse(at(443))) {
  let text = '';
  const reporter = releaseReporter({
    write: (chunk: string) => (text += chunk),
    live,
    now: () => now,
  });
  return { reporter, text: () => text };
}

test('deploy shows each step as it finishes and ends once the release is in use', async () => {
  // Forma on 2026-11-11: the old output sat silent for seven minutes, then said "still running".
  const reads = [
    {
      id: '8707edfc-40f2',
      state: 'running',
      steps: [{ name: 'prepare', state: 'running', startedAt: at(0) }],
    },
    {
      id: '8707edfc-40f2',
      state: 'running',
      steps: [
        { name: 'prepare', state: 'done', startedAt: at(0), endedAt: at(4) },
        { name: 'verify', state: 'running', startedAt: at(4) },
      ],
    },
    {
      id: '8707edfc-40f2',
      state: 'running',
      steps: [
        { name: 'prepare', state: 'done', startedAt: at(0), endedAt: at(4) },
        { name: 'verify', state: 'done', startedAt: at(4), endedAt: at(297) },
        { name: 'activate', state: 'done', startedAt: at(297), endedAt: at(443) },
        { name: 'watch', state: 'running', startedAt: at(443) },
      ],
    },
    { id: 'never-read', state: 'live', steps: [] },
  ];
  const r = reported();
  let read = 0;
  const release = await followRelease(
    async () => ({ release: reads[read++] }),
    { id: '8707edfc-40f2', state: 'running', steps: [] },
    60_000,
    { onChange: (value: any) => r.reporter.update(value), untilActivated: true },
  );
  // It stopped at Activate instead of waiting ten minutes for Watch.
  assert.equal(read, 3);
  r.reporter.finish(release, { url: 'https://forma.local', startedAt: Date.parse(at(0)) });
  assert.equal(
    r.text(),
    [
      '  ✓ Prepared release              4.0 s',
      '  ✓ Verified                      4 min 53 s',
      '  ✓ Activated                     2 min 26 s',
      '    deploy.local checks health for 10 minutes after this',
      '',
      '✓ Released 8707edf in 7 min 23 s',
      '  https://forma.local',
      '  Next: deploy logs · deploy rollback',
      '',
    ].join('\n'),
  );
});

test('a terminal shows the running step with its time so far, then replaces it', () => {
  const r = reported(true, Date.parse(at(16)));
  const running = {
    id: 'r',
    state: 'running',
    steps: [{ name: 'verify', state: 'running', startedAt: at(4) }],
  };
  r.reporter.update(running);
  r.reporter.update(running);
  assert.equal(r.text(), '\r\x1b[2K  · Verifying                     12 s');
  r.reporter.update({
    id: 'r',
    state: 'running',
    steps: [{ name: 'verify', state: 'done', startedAt: at(4), endedAt: at(20) }],
  });
  assert.ok(r.text().endsWith('\r\x1b[2K  ✓ Verified                      16 s\n'));
});

test('a release that fails Verify says what failed and that nothing changed', () => {
  const r = reported();
  const failed = {
    id: '7d0bee9b-597e',
    state: 'failed',
    steps: [
      { name: 'prepare', state: 'done', startedAt: at(0), endedAt: at(5) },
      {
        name: 'verify',
        state: 'failed',
        startedAt: at(5),
        endedAt: at(85),
        detail:
          'Creating graph network failed\nall predefined address pools have been fully subnetted\n',
      },
      { name: 'activate', state: 'skipped' },
      { name: 'watch', state: 'skipped' },
    ],
  };
  r.reporter.update(failed);
  r.reporter.finish(failed);
  assert.equal(
    r.text(),
    [
      '  ✓ Prepared release              5.0 s',
      '  ✗ Verify failed: Creating graph network failed',
      '      all predefined address pools have been fully subnetted',
      '',
      '✗ Nothing changed. Every app stayed on its previous release.',
      '  Next: deploy logs --build',
      '',
    ].join('\n'),
  );
});

test('times read as people say them', () => {
  assert.deepEqual([400, 18_900, 41_000, 293_000].map(elapsed), [
    '0.4 s',
    '19 s',
    '41 s',
    '4 min 53 s',
  ]);
});
