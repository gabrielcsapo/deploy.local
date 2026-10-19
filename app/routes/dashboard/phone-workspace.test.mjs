import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  cascade,
  fixture,
  legacyFiles,
  phoneFile,
  values,
} from '../../../scripts/mobile-web-cascade.mjs';

const orders = [
  [...legacyFiles, phoneFile],
  [phoneFile, ...legacyFiles],
  [phoneFile, ...legacyFiles.toReversed()],
  [...legacyFiles.toReversed(), phoneFile],
];
const states = [
  'has-surface',
  'has-surface has-application',
  'has-task-list',
  'is-task-flow is-composing',
  'is-task-flow',
  'is-task-flow has-inspector',
  'has-repository',
];
function expectStyle(element, width, files, expected) {
  const result = values(element, width, files);
  for (const [property, value] of Object.entries(expected))
    assert.equal(
      result[property],
      value,
      `${[...element.classes].join('.')} at ${width}: ${property} (last sheet: ${files.at(-1)})`,
    );
}

test('phone grids and all in-flow direct children survive reversed stylesheet order at 375–639 px', () => {
  for (const width of [375, 390, 430, 639])
    for (const files of orders)
      for (const state of states) {
        const f = fixture(state);
        expectStyle(f.root, width, files, {
          display: 'grid',
          'grid-template-columns': 'minmax(0, 1fr)',
          'grid-template-rows': 'auto auto minmax(0, 1fr) auto',
          width: '100%',
        });
        for (const element of f.root.children)
          assert.equal(
            values(element, width, files)['grid-column'],
            '1 / -1',
            `${state}: ${[...element.classes].join('.')} at ${width}, last ${files.at(-1)}`,
          );
        expectStyle(f.rail, width, files, { display: 'none' });
        expectStyle(f.resizer, width, files, { display: 'none' });
        expectStyle(f.tabs, width, files, {
          display: state.includes('is-task-flow') ? 'none' : 'grid',
          'grid-template-columns': 'repeat(4, minmax(0, 1fr))',
          'grid-row': '4',
          width: '100%',
        });
        expectStyle(f.chat, width, files, {
          display: state.includes('has-') ? 'none' : 'flex',
          'grid-row': '3',
        });
        expectStyle(f.review, width, files, {
          display: state.includes('has-inspector') ? 'flex' : 'none',
        });
        if (f.tasks) expectStyle(f.tasks, width, files, { display: 'flex', 'grid-row': '3' });
        if (f.surface) {
          expectStyle(f.surface, width, files, {
            display: 'flex',
            'grid-row': state.includes('has-application') ? '1 / 4' : '3',
            width: '100%',
          });
          expectStyle(f.sections, width, files, {
            display: state.includes('has-application') ? 'none' : 'flex',
          });
          if (!state.includes('has-application'))
            expectStyle(f.sections, width, files, {
              position: 'static',
              'flex-direction': 'row',
              'grid-row': '2',
            });
        }
        if (f.repository) {
          expectStyle(f.repository, width, files, {
            display: 'grid',
            'grid-row': '2 / 4',
            'grid-template-columns': 'minmax(0, 1fr)',
          });
          expectStyle(f.repoNav, width, files, {
            display: 'flex',
            'flex-direction': 'row',
            'grid-column': '1 / -1',
            'grid-row': '1',
          });
          expectStyle(f.repoWork, width, files, { 'grid-column': '1 / -1', 'grid-row': '2' });
        }
      }
});

test('phone title, horizontal chips, resource rows, notices and composer keep their contracts', () => {
  for (const width of [375, 390, 430])
    for (const files of orders) {
      const f = fixture('has-surface');
      expectStyle(f.title, width, files, {
        'white-space': 'nowrap',
        'text-overflow': 'ellipsis',
        overflow: 'hidden',
      });
      expectStyle(f.sectionLinks, width, files, {
        display: 'flex',
        'flex-direction': 'row',
        'flex-wrap': 'nowrap',
        overflow: 'auto',
      });
      expectStyle(f.sectionLink, width, files, { width: 'auto', flex: 'none' });
      expectStyle(f.resource, width, files, { display: 'grid', width: '100%', 'min-width': '0' });
      expectStyle(f.notice, width, files, { display: 'block', flex: '0 0 auto', width: '100%' });
      expectStyle(f.desktopNotice, width, files, { display: 'none' });
      expectStyle(f.location, width, files, { display: 'none' });
      expectStyle(f.tabLabel, width, files, { 'white-space': 'nowrap', overflow: 'hidden' });
      const task = fixture('is-task-flow');
      expectStyle(task.chat, width, files, {
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'hidden',
      });
      expectStyle(task.transcript, width, files, {
        flex: '1 1 0',
        'min-height': '0',
        overflow: 'auto',
      });
      expectStyle(task.compose, width, files, {
        flex: '0 0 auto',
        'padding-bottom': 'env(safe-area-inset-bottom)',
      });
      expectStyle(task.textarea, width, files, { 'grid-column': '1 / -1', 'grid-row': '1' });
      expectStyle(task.pickers, width, files, {
        display: 'flex',
        'grid-column': '1 / -1',
        'grid-row': '2',
      });
      expectStyle(task.toolbar, width, files, { 'grid-column': '1', 'grid-row': '3' });
      expectStyle(task.send, width, files, { 'grid-column': '2', 'grid-row': '3' });
      const app = fixture('has-surface has-application');
      expectStyle(app.chips, width, files, {
        display: 'flex',
        'flex-wrap': 'nowrap',
        overflow: 'auto',
      });
      expectStyle(app.deployment, width, files, { 'grid-template-columns': 'minmax(0, 1fr)' });
    }
});

test('project drawer and scrim remain overlays instead of creating implicit grid tracks', () => {
  for (const files of orders) {
    const f = fixture('is-task-flow is-composing show-sidebar');
    expectStyle(f.projects, 390, files, {
      display: 'flex',
      position: 'absolute',
      'flex-direction': 'column',
      'grid-column': '1 / -1',
      'grid-row': '1 / -1',
      left: '0',
      top: '0',
    });
    expectStyle(f.scrim, 390, files, {
      display: 'block',
      position: 'absolute',
      inset: '0',
      'grid-row': '1 / -1',
    });
  }
});

test('data-phone is inert at desktop widths, including exactly 640 px', () => {
  for (const width of [640, 760, 1280])
    for (const state of states) {
      const phone = fixture(state);
      const previous = fixture(state, false);
      for (const key of Object.keys(phone))
        assert.deepEqual(values(phone[key], width), values(previous[key], width));
      for (const item of cascade(phone.root, width, [...legacyFiles, phoneFile]).values())
        assert.notEqual(item.rule.file, phoneFile);
      assert.equal(values(phone.tabs, width).display, 'none');
    }
});

test('shell opts into the CSS scope and abbreviated tab preserves the full accessible name', () => {
  const shell = readFileSync(new URL('./projects.client.tsx', import.meta.url), 'utf8');
  const rail = readFileSync(new URL('./workspace-rail.client.tsx', import.meta.url), 'utf8');
  assert.match(shell, /data-phone=""/);
  const tabs = rail.slice(
    rail.indexOf('<nav className="workspace-tabs'),
    rail.indexOf('</nav>', rail.indexOf('<nav className="workspace-tabs')),
  );
  assert.match(tabs, /aria-label=\{link.label\}/);
  assert.match(tabs, /link.label === 'Repositories' \? 'Repos' : link.label/);
});
