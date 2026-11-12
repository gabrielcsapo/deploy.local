import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChipSelect } from './ChipSelect.tsx';
import { choiceIndex, choiceKey, choicePosition } from './chip-select.ts';

const options = [
  { value: '', label: 'Any level' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
  { value: 'extra', label: 'Extra' },
];
const closed = { open: false, active: -1 };
const opened = { open: true, active: 1 };

test('Enter, Space and arrows open at the current value without committing', () => {
  for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) {
    assert.deepEqual(choiceKey(closed, key, options, 'warn'), {
      open: true,
      active: 2,
      handled: true,
    });
  }
  assert.deepEqual(choiceKey(closed, 'Tab', options, 'warn'), { ...closed, handled: false });
  assert.equal(choiceIndex(options, 'missing'), 0);
  assert.equal(choiceIndex([], ''), -1);
});

test('arrows wrap, Home and End reach the boundaries without selecting', () => {
  const down = choiceKey(opened, 'ArrowDown', options, 'info');
  assert.equal(down.active, 2);
  assert.equal(down.selected, undefined);
  assert.equal(choiceKey({ open: true, active: 4 }, 'ArrowDown', options, '').active, 0);
  assert.equal(choiceKey({ open: true, active: 0 }, 'ArrowUp', options, '').active, 4);
  assert.equal(choiceKey(opened, 'Home', options, '').active, 0);
  assert.equal(choiceKey(opened, 'End', options, '').active, 4);
});

test('first-letter search ignores case, cycles matches and leaves unmatched keys alone', () => {
  const first = choiceKey(opened, 'E', options, 'info');
  assert.equal(first.active, 3);
  const second = choiceKey(first, 'e', options, 'info');
  assert.equal(second.active, 4);
  assert.equal(choiceKey(second, 'e', options, 'info').active, 3);
  assert.equal(choiceKey(opened, 'z', options, 'info').active, 1);
  assert.equal(choiceKey(opened, 'Shift', options, 'info').handled, false);
});

test('Enter and Space commit the active option, including an empty value', () => {
  for (const key of ['Enter', ' ']) {
    assert.deepEqual(choiceKey({ open: true, active: 0 }, key, options, 'info'), {
      open: false,
      active: 0,
      handled: true,
      selected: '',
      restoreFocus: true,
    });
    assert.equal(choiceKey(opened, key, options, '').selected, 'info');
  }
});

test('Escape cancels and restores focus; Tab closes without consuming navigation', () => {
  for (const key of ['Escape', 'Tab']) {
    const result = choiceKey(opened, key, options, 'warn');
    assert.equal(result.open, false);
    assert.equal(result.restoreFocus, true);
    assert.equal(result.selected, undefined);
    assert.equal(result.handled, key === 'Escape');
  }
});

test('disabled and empty choices never open or commit', () => {
  for (const key of ['Enter', ' ', 'ArrowDown', 'Home', 'e']) {
    assert.deepEqual(choiceKey(closed, key, options, '', true), { ...closed, handled: false });
    assert.deepEqual(choiceKey(closed, key, [], ''), { ...closed, handled: false });
    assert.equal(choiceKey(opened, key, options, '', true).selected, undefined);
  }
});

test('menu fits at the right edge at 700px and flips above a dialog trigger', () => {
  const position = choicePosition(
    { left: 650, top: 500, bottom: 528, width: 50 },
    { width: 260, height: 300 },
    { left: 0, top: 0, width: 700, height: 600 },
  );
  assert.deepEqual(position, { left: 440, top: 200, width: 260, maxHeight: 500 });
});

test('long menus scroll within the available space and respect a zoomed viewport', () => {
  const viewport = { left: 100, top: 50, width: 390, height: 500 };
  const position = choicePosition(
    { left: 90, top: 200, bottom: 228, width: 100 },
    { width: 900, height: 4000 },
    viewport,
  );
  assert.deepEqual(position, { left: 100, top: 228, width: 390, maxHeight: 322 });
  const below = choicePosition(
    { left: 10, top: 10, bottom: 38, width: 200 },
    { width: 80, height: 100 },
    { left: 0, top: 0, width: 700, height: 600 },
  );
  assert.deepEqual(below, { left: 10, top: 38, width: 200, maxHeight: 562 });
});

test('markup exposes a labelled button, listbox and selected option using the existing classes', () => {
  const html = renderToStaticMarkup(
    createElement(ChipSelect, {
      label: 'Level',
      value: 'warn',
      options,
      onChange() {},
    }),
  );
  assert.match(
    html,
    /type="button" class="dl-chip" aria-label="Level" aria-haspopup="listbox" aria-expanded="false"/,
  );
  assert.match(
    html,
    /popover="auto" class="dl-menu dl-choice-menu" role="listbox" aria-label="Level"/,
  );
  assert.match(html, /role="option" aria-selected="true" class="dl-menu-item on"[^>]*>warn/);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.doesNotMatch(html, /<select/);
});

test('secondary trigger matches the numeric board button, without a chevron; disabled is native', () => {
  const html = renderToStaticMarkup(
    createElement(ChipSelect, {
      label: 'Keep earlier releases',
      value: '5',
      options: [{ value: '5', label: '5' }],
      variant: 'secondary',
      disabled: true,
      onChange() {},
    }),
  );
  assert.match(html, /class="dl-btn secondary"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /<span>5<\/span>/);
  assert.doesNotMatch(html, /<svg/);
});
