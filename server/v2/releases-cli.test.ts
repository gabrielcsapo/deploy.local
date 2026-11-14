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
  assert.deepEqual(paths, ['/api/releases/uploads/42']);
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

// Advance only the injected clock: these tests simulate minutes without wall-clock waits.
function pollingClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}
const runningRelease = {
  id: 'slow',
  state: 'running',
  steps: [{ name: 'prepare', state: 'running' }],
};
const liveRelease = { ...runningRelease, state: 'live', steps };

test('default release waiting follows past ten minutes, to activation or the final state', async () => {
  for (const untilActivated of [false, true]) {
    const clock = pollingClock();
    const activated = {
      ...runningRelease,
      steps: steps.map((step) => ({ ...step, state: step.name === 'watch' ? 'running' : 'done' })),
    };
    const result = await followRelease(
      async () => ({
        release:
          clock.now() < 660_000 ? runningRelease : clock.now() < 720_000 ? activated : liveRelease,
      }),
      runningRelease,
      undefined,
      { ...clock, untilActivated },
    );
    assert.deepEqual(result, untilActivated ? activated : liveRelease);
    assert.equal(clock.now(), untilActivated ? 660_000 : 720_000);
  }
});

const followCases = [
  {
    name: 'release',
    follow: (api: any, timeout: number | undefined, clock: any) =>
      followRelease(api, runningRelease, timeout, clock),
    running: { release: runningRelease },
    done: { release: liveRelease },
    finalState: 'live',
  },
  {
    name: 'upload receipt',
    follow: (api: any, timeout: number | undefined, clock: any) =>
      followDeploy(api, 'gym', { projectRelease: true, buildLogId: 42 }, timeout, clock),
    running: { release: null },
    done: { release: liveRelease },
    finalState: 'live',
  },
  {
    name: 'legacy build receipt',
    follow: (api: any, timeout: number | undefined, clock: any) =>
      followDeploy(api, 'gym', { buildLogId: 42 }, timeout, clock),
    running: { logs: [{ id: 42, status: 'running' }] },
    done: { logs: [{ id: 42, status: 'complete', success: true }] },
    finalState: 'live',
  },
  {
    name: 'rollback',
    follow: (api: any, timeout: number | undefined, clock: any) =>
      followRollback(api, 'gym', runningRelease, timeout, clock),
    running: { rollbacks: [runningRelease] },
    done: { rollbacks: [{ ...runningRelease, steps }] },
    finalState: 'rolled-back',
  },
];
for (const scenario of followCases) {
  test(`${scenario.name}: default wait lasts past ten minutes`, async () => {
    const clock = pollingClock();
    const result = await scenario.follow(
      async () => (clock.now() < 660_000 ? scenario.running : scenario.done),
      undefined,
      clock,
    );
    assert.equal(result.state, scenario.finalState);
    assert.equal(clock.now(), 660_000);
  });
  test(`${scenario.name}: explicit timeouts still stop, including zero`, async () => {
    for (const timeout of [0, 2500]) {
      const clock = pollingClock();
      const result = await scenario.follow(async () => scenario.running, timeout, clock);
      assert.equal(result.state, 'running');
      assert.equal(clock.now(), timeout);
    }
  });
  test(`${scenario.name}: fetch failures and coordinator restarts are retried`, async () => {
    const clock = pollingClock();
    let calls = 0;
    const result = await scenario.follow(
      async () => {
        calls++;
        if (calls === 1) throw new TypeError('fetch failed');
        if (calls <= 3)
          throw Object.assign(new Error('Restarting'), { status: calls === 2 ? 502 : 503 });
        return scenario.done;
      },
      undefined,
      clock,
    );
    assert.equal(result.state, scenario.finalState);
    assert.equal(calls, 4);
    assert.equal(clock.now(), 3000);
  });
  test(`${scenario.name}: two minutes of consecutive failures give up`, async () => {
    const clock = pollingClock();
    const error = new TypeError('fetch failed');
    await assert.rejects(
      scenario.follow(
        async () => {
          throw error;
        },
        undefined,
        clock,
      ),
      (caught: unknown) => caught === error,
    );
    assert.equal(clock.now(), 120_000);
  });
  test(`${scenario.name}: an explicit timeout also bounds retries`, async () => {
    const clock = pollingClock();
    const result = await scenario.follow(
      async () => {
        throw new TypeError('fetch failed');
      },
      2500,
      clock,
    );
    assert.equal(result.state, 'running');
    assert.equal(clock.now(), 2500);
  });
  test(`${scenario.name}: a successful read resets the consecutive failure window`, async () => {
    const clock = pollingClock();
    const result = await scenario.follow(
      async () => {
        if (clock.now() === 90_000) return scenario.running;
        if (clock.now() >= 180_000) return scenario.done;
        throw new TypeError('fetch failed');
      },
      undefined,
      clock,
    );
    assert.equal(result.state, scenario.finalState);
    assert.equal(clock.now(), 180_000);
  });
  test(`${scenario.name}: authentication errors fail immediately`, async () => {
    const clock = pollingClock();
    await assert.rejects(
      scenario.follow(
        async () => {
          throw Object.assign(new Error('Unauthorized'), { status: 401 });
        },
        undefined,
        clock,
      ),
      /Unauthorized/,
    );
    assert.equal(clock.now(), 0);
  });
}

test('upload and release polling share the explicit timeout', async () => {
  const clock = pollingClock();
  const result = await followDeploy(
    async (path: string) => {
      if (path.includes('/uploads/'))
        return { release: clock.now() < 2000 ? null : runningRelease };
      return { release: runningRelease };
    },
    'gym',
    { projectRelease: true, buildLogId: 42 },
    3500,
    clock,
  );
  assert.deepEqual(result, runningRelease);
  assert.equal(clock.now(), 3500);
});
