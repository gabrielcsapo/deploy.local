import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SelfUpdateRun, SelfUpdateStatus } from '../../../../../shared/v2/contracts';
import {
  failedNotice,
  pageMeta,
  plannedSteps,
  runningNotice,
  selfUpdateView,
  sidebarRow,
  updateSteps,
} from './self-update-presentation';

type Supported = Extract<SelfUpdateStatus, { supported: true }>;
const status = (over: Partial<Supported> = {}): Supported => ({
  supported: true,
  computer: 'SER',
  running: '7f3b2d4aaaa',
  main: '9c41e7fbbbb',
  ahead: 4,
  changes: [],
  estimateMs: 300_000,
  ...over,
});
const run = (over: Partial<SelfUpdateRun> = {}): SelfUpdateRun => ({
  id: 'r',
  from: '7f3b2d4aaaa',
  to: '9c41e7fbbbb',
  state: 'running',
  startedAt: '2026-11-02T20:00:00Z',
  startedBy: 'gabriel',
  steps: [
    {
      id: 'prepare',
      state: 'done',
      detail: 'install, typecheck, build, 281 tests passed · 3 m 12 s',
    },
    { id: 'backup', state: 'running' },
    { id: 'restart', state: 'waiting' },
    { id: 'check', state: 'waiting' },
  ],
  ...over,
});

test('the sidebar shows an update only when main is ahead, one is running, or one failed', () => {
  assert.equal(selfUpdateView({ supported: false, reason: 'x' }), null);
  assert.equal(selfUpdateView(status({ ahead: 0 })), null);
  assert.equal(sidebarRow(selfUpdateView(status())!).label, 'Update available');
  assert.equal(sidebarRow(selfUpdateView(status({ run: run() }))!).label, 'Updating deploy.local');
  const failed = status({ run: run({ state: 'failed', error: 'x' }) });
  assert.equal(sidebarRow(selfUpdateView(failed)!).label, 'Update failed');
  // A failure that a later update replaced is not news.
  assert.equal(
    selfUpdateView(status({ ahead: 0, running: '9c41e7fbbbb', run: run({ state: 'failed' }) })),
    null,
  );
});

test('the page says where SER is and what each step will do', () => {
  assert.equal(pageMeta(selfUpdateView(status())!), 'SER runs 7f3b2d4 · main is 4 changes ahead');
  assert.equal(
    pageMeta(selfUpdateView(status({ run: run() }))!),
    'Updating SER from 7f3b2d4 to 9c41e7f',
  );
  assert.deepEqual(
    plannedSteps(status()).map((s) => [s.text, s.detail]),
    [
      [
        'Prepare the new build',
        'install, typecheck, build and tests · about 5 min · nothing changes yet',
      ],
      ['Back up the databases', 'deploy.db and workspace.db'],
      ['Restart into the new build', 'pages reconnect within a few seconds'],
      ['Check it is healthy', 'if not, SER goes back to 7f3b2d4 on its own'],
    ],
  );
  assert.deepEqual(
    updateSteps(run().steps, status()).map((s) => [s.text, s.icon]),
    [
      ['Prepared the new build', 'check'],
      ['Backing up the databases', 'running'],
      ['Restart into the new build', 'clock'],
      ['Check it is healthy', 'clock'],
    ],
  );
});

test('running and failed notices', () => {
  assert.equal(
    runningNotice(run(), status(), 'gabriel', Date.parse('2026-11-02T20:02:00Z')),
    'You started this 2 min ago. About 3 min left. This page reconnects by itself when SER restarts.',
  );
  assert.equal(
    failedNotice(
      run({
        state: 'failed',
        error: 'The update to 9c41e7f stopped while preparing, before anything changed.',
      }),
      status(),
    ),
    'The update to 9c41e7f stopped while preparing, before anything changed. SER is still running 7f3b2d4.',
  );
  assert.equal(
    failedNotice(run({ state: 'failed', rolledBack: true, error: 'went back' }), status()),
    'went back',
  );
});
