import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readingPosition, scrollToLatest } from './reading-position.ts';

test('a task left while following or loading reopens at the latest message', () => {
  assert.equal(readingPosition({ scrollTop: 9 }, true).top, null);
  assert.equal(readingPosition(null, false).top, null);
});

test('a reader who scrolled up gets that place and the draft caret back', () => {
  assert.deepEqual(
    readingPosition({ scrollTop: 1200 }, false, { selectionStart: 3, selectionEnd: 5 }),
    { top: 1200, start: 3, end: 5 },
  );
});

test('the workspace restores only a saved offset and otherwise follows the transcript', () => {
  const source = readFileSync(new URL('./projects.client.tsx', import.meta.url), 'utf8');
  assert.match(source, /readingPosition\(\s*transcriptRef\.current,\s*followTranscript\.current,/);
  assert.match(source, /followTranscript\.current = saved\?\.top == null;/);
});

test('opening a task jumps to the latest message instead of animating from the top', () => {
  const calls: unknown[] = [];
  scrollToLatest({
    scrollHeight: 4506,
    scrollTo: (options: unknown) => calls.push(options),
  } as any);
  assert.deepEqual(calls, [{ top: 4506, behavior: 'instant' }]);
  for (const file of ['./workspace.css', './conversation-chrome.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const rule of css.match(/\.pw-transcript\s*\{[^}]*\}/g) ?? [])
      assert.doesNotMatch(rule, /scroll-behavior:\s*smooth/, file);
  }
});
