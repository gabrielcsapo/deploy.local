import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { activityMode, taskCardWidth, composerActivityVisible } from './interaction-layout.ts';
import { projectTaskPreview, selectedTaskInProject } from './task-tree.ts';
import { ActivityRail } from './task-activity-rail.client.tsx';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
test('selection cannot expand a project or change its preview, including an older recent', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: String(i) }));
  const groups = [{ id: 'project', tasks }];
  const expanded = Object.freeze({ project: false });
  for (const selected of ['0', '7']) {
    assert.equal(selectedTaskInProject(groups, selected, expanded, {}, false), false);
    assert.equal(expanded.project, false);
    assert.deepEqual(
      projectTaskPreview(tasks, false).map((task) => task.id),
      ['0', '1', '2', '3', '4'],
    );
  }
  assert.equal(selectedTaskInProject(groups, '0', { project: true }, {}, false), true);
  assert.equal(selectedTaskInProject(groups, '7', { project: true }, {}, false), false);
  assert.equal(
    selectedTaskInProject(groups, '7', { project: true }, { project: true }, false),
    true,
  );
  assert.equal(selectedTaskInProject(groups, '7', expanded, {}, true), true);
  const tree = source('task-tree.client.tsx');
  assert.doesNotMatch(tree, /setExpanded\(\(prior\) => \([\s\S]*?selectedGroup/);
  assert.match(tree, /aria-current=\{filled \? 'page' : undefined\}/);
  assert.match(
    tree,
    /selected === task.id && \(recent \? !selectedInProject : selectedInProject\)/,
  );
  assert.match(tree, /inert=\{!isExpanded\}/);
});
test('legacy collapsed mode migrates to closed; a closed rail remains mounted but inaccessible', () => {
  for (const value of ['collapsed', 'closed', '', null, 'invalid'])
    assert.equal(activityMode(value), 'closed');
  assert.equal(activityMode('open'), 'open');
  const html = renderToStaticMarkup(
    createElement(ActivityRail, {
      rail: {
        mode: 'closed',
        width: 400,
        tab: 'activity',
        select() {},
        expanded: false,
        setExpanded() {},
        toggle() {},
        update() {},
        style: {},
      },
      jobs: [],
    }),
  );
  assert.match(html, /data-open="false" inert="" aria-hidden="true"/);
  assert.doesNotMatch(html, /Collapse Activity|pw-activity-strip/);
});
test('card uses available margin at common widths and never reaches into the reading column', () => {
  assert.equal(taskCardWidth(1199), null);
  assert.equal(taskCardWidth(1200), 216);
  assert.equal(taskCardWidth(1324), 260);
  assert.equal(taskCardWidth(1800), 260);
  assert.equal(taskCardWidth(1200, 800), null);
  for (let pane = 1200; pane < 2000; pane += 8)
    assert.ok(taskCardWidth(pane)! + 24 <= (pane - 720) / 2);
});
test('composer status appears only for running/failing work with neither card nor rail visible', () => {
  for (const card of [false, true])
    for (const mode of ['closed', 'open']) {
      assert.equal(composerActivityVisible(card, mode, 1, 0), !card && mode === 'closed');
      assert.equal(composerActivityVisible(card, mode, 0, 1), !card && mode === 'closed');
      assert.equal(composerActivityVisible(card, mode, 0, 0), false);
    }
  const page = source('projects.client.tsx');
  const toolbar = page.slice(
    page.indexOf('<div className="pw-composer-toolbar">'),
    page.indexOf('{active && queueing'),
  );
  assert.match(toolbar, /pw-composer-activity-pill/);
  assert.ok(
    toolbar.indexOf('pw-composer-activity-pill') <
      toolbar.lastIndexOf('<ComposerControls {...composerControls}'),
  );
  assert.doesNotMatch(page, /pw-narrow-activity-chip/);
});
test('conversation and Changes share one persistent title bar, and keyboard navigation skips inert children', () => {
  const page = source('projects.client.tsx');
  assert.equal(page.match(/<WorkspaceTitleBar\s+className="pw-task-titlebar"/g)?.length, 1);
  const review = page.slice(page.indexOf('aria-label="Task inspector"'));
  assert.doesNotMatch(review, /<header className="ds-pane-toolbar">/);
  assert.match(source('task-activity-rail.client.tsx'), /event.key === 'Escape'/);
  assert.match(
    page,
    /const cardVisible = cardWidth !== null && activityRail.mode === 'closed' && !inspector/,
  );
  assert.match(page, /pressed=\{inspector\}/);
  assert.match(source('workspace-navigation.client.tsx'), /!el.closest\('\[inert\]'\)/);
});

test('transcript keeps distance from bottom through reflow and retains an intentional user scroll', async () => {
  const { trackTranscriptLayout } = await import('./transcript-layout.client.ts');
  let resized = () => {};
  let disconnected = false;
  const prior = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  const element = Object.assign(new EventTarget(), {
    clientWidth: 1000,
    clientHeight: 600,
    scrollHeight: 1800,
    scrollTop: 1200,
  });
  try {
    const stop = trackTranscriptLayout(element as unknown as HTMLDivElement);
    element.clientWidth = 700;
    element.scrollHeight = 2100;
    // Browsers can dispatch this before ResizeObserver after text wraps.
    element.dispatchEvent(new Event('scroll'));
    resized();
    assert.equal(element.scrollTop, 1500);
    element.scrollTop = 900;
    element.dispatchEvent(new Event('scroll'));
    element.clientWidth = 1000;
    element.scrollHeight = 1800;
    resized();
    assert.equal(element.scrollTop, 600);
    assert.equal(element.scrollHeight - element.scrollTop - element.clientHeight, 600);
    element.clientHeight = 500;
    resized();
    assert.equal(element.scrollTop, 700);
    stop();
    assert.equal(disconnected, true);
  } finally {
    globalThis.ResizeObserver = prior;
  }
});
