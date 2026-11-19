import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserAddress,
  browserController,
  elapsed,
  keyAction,
  latestFrame,
  pagePoint,
  queueAction,
  stepRunning,
  taskBrowser,
  type ControlSession,
} from './browser.ts';
import { descriptionSummary, taskPaneFromPath } from './panes.ts';

const session = (extra: Partial<ControlSession> = {}): ControlSession => ({
  id: 's1',
  kind: 'browser',
  status: 'active',
  controlOwner: 'agent',
  generation: 'g1',
  workerId: 'w1',
  createdAt: '2026-11-19T10:00:00.000Z',
  ...extra,
});

test('the pane shows the live browser, else the one that ended last', () => {
  const ended = session({ id: 'old', status: 'stopped', createdAt: '2026-11-19T11:00:00.000Z' });
  const live = session({ id: 'live' });
  const desktop = session({ id: 'mac', kind: 'computer', createdAt: '2026-11-19T12:00:00.000Z' });
  assert.equal(taskBrowser({ sessions: [ended, live, desktop], commands: [] })?.id, 'live');
  assert.equal(taskBrowser({ sessions: [ended, desktop], commands: [] })?.id, 'old');
  assert.equal(taskBrowser(null), undefined);
});

test('who has the browser, from this window', () => {
  assert.equal(browserController(session(), 'me'), 'agent');
  assert.equal(browserController(session({ controlOwner: 'user:me' }), 'me'), 'you');
  assert.equal(
    browserController(session({ controlOwner: 'user:me', status: 'transferring' }), 'me'),
    'taking',
  );
  assert.equal(browserController(session({ status: 'transferring' }), 'me'), 'returning');
  assert.equal(browserController(session({ controlOwner: 'user:phone' }), 'me'), 'elsewhere');
  assert.equal(browserController(session({ status: 'stopped' }), 'me'), 'ended');
});

test('a new picture follows each finished step', () => {
  const commands = [
    { id: 'a', sessionId: 's1', status: 'succeeded', controller: 'agent', createdAt: '' },
    { id: 'b', sessionId: 's1', status: 'running', controller: 'agent', createdAt: '' },
    { id: 'c', sessionId: 's2', status: 'succeeded', controller: 'agent', createdAt: '' },
  ];
  assert.equal(latestFrame({ sessions: [], commands }, 's1'), 'a');
});

test('a click on the shown picture lands on the same spot in the page', () => {
  const box = { left: 100, top: 50, width: 640, height: 400 };
  assert.deepEqual(pagePoint(box, 420, 250), { x: 640, y: 400 });
  assert.deepEqual(pagePoint(box, 90, 40), { x: 0, y: 0 });
  assert.deepEqual(pagePoint(box, 2000, 2000), { x: 1279, y: 799 });
});

test('keys become typed text or a key press', () => {
  assert.deepEqual(keyAction({ key: 'a' }), { type: 'text', text: 'a' });
  assert.deepEqual(keyAction({ key: 'A', shiftKey: true }), { type: 'text', text: 'A' });
  assert.deepEqual(keyAction({ key: 'Enter' }), { type: 'press', key: 'Enter' });
  assert.deepEqual(keyAction({ key: 'a', metaKey: true }), { type: 'press', key: 'Meta+a' });
  assert.deepEqual(keyAction({ key: 'Tab', shiftKey: true }), { type: 'press', key: 'Shift+Tab' });
  assert.equal(keyAction({ key: 'Shift', shiftKey: true }), null);
});

test('an address gets https when it has no scheme; other schemes and credentials are refused', () => {
  assert.equal(browserAddress('tally.local'), 'https://tally.local/');
  assert.equal(browserAddress(' http://tally.local/x '), 'http://tally.local/x');
  assert.equal(browserAddress('file:///etc/passwd'), null);
  assert.equal(browserAddress('https://a:b@tally.local'), null);
  assert.equal(browserAddress(''), null);
});

test('time at the controls reads like a clock', () => {
  const start = '2026-11-19T10:00:00.000Z';
  assert.equal(elapsed(start, Date.parse(start) + 72_000), '1:12');
  assert.equal(elapsed(start, Date.parse(start) + 3_723_000), '1:02:03');
});

test('a task URL names its pane and what fills the main column', () => {
  assert.deepEqual(taskPaneFromPath('/dashboard/tasks/t1'), { pane: null, main: 'chat' });
  assert.deepEqual(taskPaneFromPath('/dashboard/tasks/t1/browser'), {
    pane: 'browser',
    main: 'chat',
  });
  assert.deepEqual(taskPaneFromPath('/dashboard/tasks/t1/checks/'), {
    pane: 'checks',
    main: 'chat',
  });
  assert.deepEqual(taskPaneFromPath('/dashboard/tasks/t1/changes/full'), {
    pane: null,
    main: 'full',
  });
  assert.deepEqual(taskPaneFromPath('/dashboard/tasks/t1/design'), { pane: null, main: 'design' });
});

test('a description row shows its first line as plain text', () => {
  assert.equal(
    descriptionSummary('## Summary\n\nAdds a **Reset** button. See [tally](https://tally.local)'),
    'Summary',
  );
  assert.equal(
    descriptionSummary('\n- Adds a `reset()` to the store'),
    'Adds a reset() to the store',
  );
  assert.equal(descriptionSummary(undefined), '');
});

test('typing while a step runs waits its turn, merged into one step', () => {
  let queue = queueAction([], { type: 'click', x: 1, y: 2 });
  queue = queueAction(queue, { type: 'text', text: 'h' });
  queue = queueAction(queue, { type: 'text', text: 'i' });
  queue = queueAction(queue, { type: 'press', key: 'Enter' });
  assert.deepEqual(queue, [
    { type: 'click', x: 1, y: 2 },
    { type: 'text', text: 'hi' },
    { type: 'press', key: 'Enter' },
  ]);
  assert.deepEqual(
    queueAction([{ type: 'scroll', x: 0, y: 100 }], { type: 'scroll', x: 0, y: 40 }),
    [{ type: 'scroll', x: 0, y: 140 }],
  );
});

test('a step this window sent counts as running until a read shows it finished', () => {
  const state = (status: string) => ({
    sessions: [],
    commands: [{ id: 'c', sessionId: 's', status, controller: 'user:me', createdAt: '' }],
  });
  assert.equal(stepRunning({ sessions: [], commands: [] }, 'c'), true);
  assert.equal(stepRunning(state('queued'), 'c'), true);
  assert.equal(stepRunning(state('succeeded'), 'c'), false);
  assert.equal(stepRunning(state('succeeded'), undefined), false);
});
