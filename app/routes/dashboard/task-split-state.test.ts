import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityRail } from './task-activity-rail.client';
import {
  listenForSplitEscape,
  restoreSplitFocus,
  splitPreference,
  selectedSplitTab,
  selectSplitTab,
  toggledSplitTab,
  controlRevealId,
  type SplitTab,
} from './task-split-state';
import { taskRisks } from './task-risk';
import { RiskNotice } from './task-risk.client';

test('legacy Activity migrates with bounded device width; explicit per-task closure survives reload', () => {
  let state = splitPreference(null, { mode: 'open', width: 555 });
  assert.equal(selectedSplitTab(state, 'one'), 'activity');
  assert.equal(state.width, 555);
  state = selectSplitTab(state, 'one', null);
  state = selectSplitTab(state, 'two', 'computer', 999);
  const restored = splitPreference(JSON.parse(JSON.stringify(state)), { mode: 'open' });
  assert.equal(selectedSplitTab(restored, 'one'), null);
  assert.equal(selectedSplitTab(restored, 'two'), 'computer');
  assert.equal(restored.width, 720);
  assert.equal(splitPreference(null, { mode: 'collapsed', width: 1 }).migratedTab, null);
  assert.equal(splitPreference(null, { mode: 'closed', width: 1 }).width, 320);
  assert.equal(splitPreference({ tabs: { one: 'bad' }, width: 'bad' }).tabs.one, null);
});
test('all three toggles switch the same host, press only the matching tab and close on repeat', () => {
  for (const tab of ['computer', 'changes', 'activity'] as SplitTab[]) {
    assert.equal(toggledSplitTab(null, tab), tab);
    assert.equal(toggledSplitTab(tab, tab), null);
    const html = renderToStaticMarkup(
      createElement(ActivityRail, {
        rail: {
          mode: 'open',
          tab,
          width: 400,
          expanded: false,
          select() {},
          update() {},
          toggle() {},
          setExpanded() {},
          style: {},
        },
        jobs: [],
      }),
    );
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
    assert.ok(html.includes(`id="split-tab-${tab}" role="tab" aria-selected="true"`));
    assert.equal(html.includes('Expand Changes'), tab === 'changes');
    for (const next of ['computer', 'changes', 'activity'] as SplitTab[])
      if (next !== tab) assert.equal(toggledSplitTab(tab, next), next);
  }
});
test('only new requests and live sessions can trigger Computer reveal', () => {
  assert.equal(controlRevealId({ sessions: [] }), '');
  for (const status of ['stopped', 'suspended'])
    assert.equal(controlRevealId({ sessions: [{ id: 'old', status }] }), '');
  assert.equal(controlRevealId({ sessions: [{ id: 'new', status: 'active' }] }), 'new');
  assert.equal(
    controlRevealId({ sessions: [], requests: [{ id: 'request', status: 'pending' }] }),
    'request',
  );
});
test('risk chips require online, ready roles and screen input permission', () => {
  const computer = {
    id: 'one',
    online: true,
    workerIds: ['worker'],
    roles: { deploy: { state: 'ready' }, computer: { state: 'ready' } },
  };
  const input = [{ id: 'input', state: 'on' }];
  assert.deepEqual(
    taskRisks(computer, input).map((r) => r.label),
    ['Can deploy', 'Screen access'],
  );
  assert.deepEqual(
    taskRisks(computer).map((r) => r.label),
    ['Can deploy'],
  );
  assert.deepEqual(taskRisks({ ...computer, online: false }, input), []);
  assert.deepEqual(taskRisks(undefined, input), []);
  for (const state of ['off', 'paused', 'needs-setup'])
    assert.deepEqual(
      taskRisks({ ...computer, roles: { deploy: { state }, computer: { state } } }, input),
      [],
    );
  assert.equal(taskRisks(computer, [{ id: 'input', state: 'needs-approval' }]).length, 1);
});
test('notice is absent without access and remains absent on a dismissed device', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const risks = taskRisks({
    id: 'one',
    online: true,
    workerIds: [],
    roles: { deploy: { state: 'ready' } },
  });
  let dismissed = false;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => (dismissed ? 'true' : null) },
  });
  try {
    assert.equal(renderToStaticMarkup(createElement(RiskNotice, { risks: [] })), '');
    assert.match(
      renderToStaticMarkup(createElement(RiskNotice, { risks })),
      /Don&#x27;t show again/,
    );
    dismissed = true;
    assert.equal(renderToStaticMarkup(createElement(RiskNotice, { risks })), '');
  } finally {
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('Escape closes once, respects a nested viewer, cleans up and returns focus without scrolling', () => {
  const target = new EventTarget();
  let closed = 0;
  const cleanup = listenForSplitEscape(target, () => closed++);
  function escape(prevented = false) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value: 'Escape' });
    if (prevented) event.preventDefault();
    target.dispatchEvent(event);
    return event;
  }
  assert.equal(escape().defaultPrevented, true);
  assert.equal(closed, 1);
  escape(true);
  assert.equal(closed, 1);
  cleanup();
  escape();
  assert.equal(closed, 1);
  let options: FocusOptions | undefined;
  restoreSplitFocus({
    isConnected: true,
    focus: (value) => {
      options = value;
    },
  });
  assert.deepEqual(options, { preventScroll: true });
  restoreSplitFocus({ isConnected: false, focus: () => assert.fail('detached opener focused') });
});
