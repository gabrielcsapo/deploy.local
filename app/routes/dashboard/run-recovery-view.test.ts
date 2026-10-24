import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { recoveryBlocksComposer, runRecovery } from './run-recovery.ts';
import { RunRecoveryNotice } from './run-recovery.client.tsx';
import { runDuration } from './task-activity-summary.ts';
import { taskStatus } from './task-tree.ts';

const unknown = {
  id: 'run-1',
  status: 'unknown',
  createdAt: '2026-10-24T02:41:13.470Z',
  updatedAt: '2026-10-24T02:54:59.899Z',
  error: 'Remote worker restarted; previous process must be reconciled',
};
const view = (state: string, canMarkStopped: boolean, detail = 'bazzite is offline.') => ({
  state,
  title: 'Interrupted — the computer restarted during this run',
  detail,
  canMarkStopped,
  stopRequested: false,
});

test('an interrupted run shows why, how long it worked, and blocks the composer', () => {
  const recovery = runRecovery([{ ...unknown, recoveryView: view('waiting-for-computer', true) }]);
  assert.equal(recovery?.runId, 'run-1');
  assert.equal(recoveryBlocksComposer(recovery), true);
  // The run stopped being observed at the restart; its duration does not keep growing.
  assert.equal(runDuration(unknown, Date.parse('2026-10-24T05:00:00Z')), '13m 46s');
  assert.deepEqual(taskStatus('blocked'), { tone: 'attention', label: 'Interrupted' });
  const html = renderToStaticMarkup(
    createElement(RunRecoveryNotice, { recovery: recovery!, markStopped: () => {} }),
  );
  assert.match(html, /Interrupted — the computer restarted during this run/);
  assert.match(html, /bazzite is offline\./);
  assert.match(html, /data-recovery="waiting-for-computer"/);
  assert.match(html, /Mark as stopped…/);
  assert.doesNotMatch(html, /Working|Running/);
});

test('a surviving agent offers no override; a resolved run frees the composer', () => {
  const running = runRecovery([
    { ...unknown, recoveryView: view('process-running', false, 'Stop it on that computer.') },
  ]);
  const html = renderToStaticMarkup(
    createElement(RunRecoveryNotice, { recovery: running!, markStopped: () => {} }),
  );
  assert.match(html, /Stop it on that computer\./);
  assert.doesNotMatch(html, /Mark as stopped/);
  const resolved = runRecovery([
    {
      ...unknown,
      status: 'interrupted',
      recoveryView: view('resolved', false, 'Send a message to continue.'),
    },
  ]);
  assert.equal(resolved?.state, 'resolved');
  assert.equal(recoveryBlocksComposer(resolved), false);
  // Only the latest run speaks for the task.
  assert.equal(
    runRecovery([{ ...unknown, recoveryView: view('resolved', false) }, { id: 'run-2' }]),
    null,
  );
  assert.equal(runRecovery([{ id: 'run-3', status: 'succeeded' }]), null);
});

test('an older coordinator without recovery details still never shows the run as working', () => {
  const recovery = runRecovery([unknown]);
  assert.equal(recovery?.canMarkStopped, false);
  assert.equal(recoveryBlocksComposer(recovery), true);
  assert.match(recovery!.title, /Interrupted/);
});
