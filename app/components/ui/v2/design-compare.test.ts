import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignCompare } from './DesignCompare.tsx';
import {
  afterAt,
  compareKey,
  compareMode,
  compareModeKey,
  savedCompareMode,
  saveCompareMode,
  subscribeCompareMode,
} from './design-compare.ts';

test('drag reveals After on the right, clamps captured drags outside the image, and scales to its bounds', () => {
  assert.equal(afterAt(100, 100, 720), 100);
  assert.equal(afterAt(820, 100, 720), 0);
  assert.equal(afterAt(388, 100, 720), 60);
  assert.equal(afterAt(244, 100, 360), 60);
  assert.equal(afterAt(-100, 100, 720), 100);
  assert.equal(afterAt(1000, 100, 720), 0);
  assert.equal(afterAt(100, 100, 0), 50);
});

test('keyboard moves the divider in 1% steps and reaches both extremes', () => {
  assert.equal(compareKey(50, 'ArrowLeft'), 51);
  assert.equal(compareKey(50, 'ArrowRight'), 49);
  assert.equal(compareKey(50, 'ArrowUp'), 51);
  assert.equal(compareKey(50, 'ArrowDown'), 49);
  assert.equal(compareKey(100, 'ArrowLeft'), 100);
  assert.equal(compareKey(0, 'ArrowRight'), 0);
  assert.equal(compareKey(50, 'Home'), 0);
  assert.equal(compareKey(50, 'End'), 100);
  assert.equal(compareKey(50, 'Tab'), undefined);
});

test('new or unknown preferences start in Slider; the saved onion mode is restored', () => {
  assert.equal(compareMode(null), 'slider');
  assert.equal(compareMode('old-mode'), 'slider');
  assert.equal(compareMode('onion'), 'onion');
});

test('a mode change persists and notifies every review, including with unavailable storage', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  let blocked = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blocked) throw new Error('Storage unavailable');
        values.set(key, value);
      },
    },
  });
  let updates = 0;
  const first = subscribeCompareMode(() => updates++);
  const second = subscribeCompareMode(() => updates++);
  try {
    assert.equal(savedCompareMode(), 'slider');
    saveCompareMode('onion');
    assert.equal(values.get(compareModeKey), 'onion');
    assert.equal(savedCompareMode(), 'onion');
    assert.equal(updates, 2);
    blocked = true;
    saveCompareMode('slider');
    assert.equal(savedCompareMode(), 'slider');
    assert.equal(updates, 4);
    blocked = false;
    saveCompareMode('slider');
    first();
    second();
    saveCompareMode('slider');
    assert.equal(updates, 6);
  } finally {
    first();
    second();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('comparison exposes its adjustable value and aligned versions', () => {
  const html = renderToStaticMarkup(
    createElement(DesignCompare, { before: 'old-render', after: 'new-render' }),
  );
  assert.match(html, /old-render/);
  assert.match(html, /new-render/);
  assert.match(html, /role="slider"/);
  assert.match(html, /aria-label="Compare"/);
  assert.match(html, /aria-valuetext="50% After"/);
  assert.match(html, /Before · main/);
  assert.match(html, /After · this branch/);
});

test('added and removed boards render only the existing version, without compare controls', () => {
  const added = renderToStaticMarkup(
    createElement(DesignCompare, { added: true, before: 'old-render', after: 'new-render' }),
  );
  assert.match(added, /New board/);
  assert.match(added, /After only · no previous version/);
  assert.match(added, /new-render/);
  assert.doesNotMatch(added, /old-render|Comparison mode|role="slider"|After opacity/);
  const removed = renderToStaticMarkup(
    createElement(DesignCompare, { removed: true, before: 'old-render', after: 'new-render' }),
  );
  assert.match(removed, /Removed/);
  assert.match(removed, /old-render/);
  assert.doesNotMatch(removed, /new-render|Comparison mode|role="slider"|After opacity/);
});
