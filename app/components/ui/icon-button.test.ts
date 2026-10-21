import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IconButton, CopyButton, IconLink } from './IconButton.tsx';
import { copyPresentation, createCopyFeedback, type CopyFeedback } from './copy-feedback.ts';

// Required at compile time, including when other native button props are supplied.
// @ts-expect-error Icon actions require a label.
const missingLabel: Parameters<typeof IconButton>[0] = { icon: 'close' };
void missingLabel;

test('icon actions require names and expose tooltip, toggle, shortcut and native button semantics', () => {
  assert.throws(
    () => renderToStaticMarkup(createElement(IconButton, { icon: 'close', label: ' ' })),
    /nonempty label/,
  );
  const html = renderToStaticMarkup(
    createElement(IconButton, {
      icon: 'wrap',
      label: 'Wrap output',
      pressed: false,
      shortcut: 'W',
      disabled: true,
    }),
  );
  assert.match(html, /aria-label="Wrap output"/);
  assert.match(html, /title="Wrap output \(W\)"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /type="button"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(IconButton, { icon: 'close', label: 'Close' })),
    /aria-pressed/,
  );
});

test('copy exposes a polite announcement region and starts with a named copy action', () => {
  const html = renderToStaticMarkup(
    createElement(CopyButton, { label: 'Copy command', text: 'swift test' }),
  );
  assert.match(html, /aria-label="Copy command" title="Copy command"/);
  assert.match(html, /role="status" aria-live="polite"><\/span>/);
  assert.doesNotMatch(html, />Copied</);
});

test('copy writes the exact text, swaps to check and announces only after success, then resets after 1.5 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states: CopyFeedback[] = [];
  const writes: string[] = [];
  const feedback = createCopyFeedback(
    (state) => states.push(state),
    async (text) => {
      writes.push(text);
    },
  );
  await feedback.copy('swift test\n');
  assert.deepEqual(writes, ['swift test\n']);
  assert.deepEqual(copyPresentation(states.at(-1)!), { icon: 'check', announcement: 'Copied' });
  t.mock.timers.tick(1499);
  assert.equal(states.at(-1), 'copied');
  t.mock.timers.tick(1);
  assert.deepEqual(copyPresentation(states.at(-1)!), { icon: 'copy', announcement: '' });
  feedback.dispose();
});

test('clipboard denial exposes selection guidance and never claims a successful copy', async () => {
  const states: CopyFeedback[] = [];
  const feedback = createCopyFeedback(
    (state) => states.push(state),
    async () => {
      throw new Error('denied');
    },
  );
  await feedback.copy('command');
  assert.deepEqual(states, ['idle', 'fallback']);
  assert.equal(copyPresentation(states.at(-1)!).icon, 'copy');
  assert.match(copyPresentation(states.at(-1)!).announcement, /Select and copy/);
  feedback.reset();
  assert.equal(states.at(-1), 'idle');
});

test('a late clipboard completion cannot override a later click or an unmounted control', async () => {
  const states: CopyFeedback[] = [];
  const completions: (() => void)[] = [];
  const feedback = createCopyFeedback(
    (state) => states.push(state),
    () => new Promise<void>((resolve) => completions.push(resolve)),
  );
  const first = feedback.copy('first');
  const second = feedback.copy('second');
  completions[0]!();
  await first;
  assert.deepEqual(states, ['idle', 'idle']);
  feedback.dispose();
  completions[1]!();
  await second;
  assert.deepEqual(states, ['idle', 'idle']);
});

test('external and download icon links preserve native link semantics', () => {
  const html = renderToStaticMarkup(
    createElement(IconLink, {
      icon: 'download',
      label: 'Download file',
      href: '/file',
      download: 'file.txt',
    }),
  );
  assert.match(html, /^<a /);
  assert.match(html, /download="file.txt"/);
  assert.match(html, /aria-label="Download file" title="Download file"/);
});

test('compact navigation names the actual return destination', async () => {
  const { CompactTopBar } = await import('./Compact.tsx');
  const html = renderToStaticMarkup(
    createElement(CompactTopBar, { title: 'Changes', onBack() {}, onBackLabel: 'Back to chat' }),
  );
  assert.match(html, /aria-label="Back to chat" title="Back to chat"/);
  assert.doesNotMatch(html, /Back to tasks/);
});

test('copy menu item makes the entire labelled action clickable and keeps copy feedback', () => {
  const html = renderToStaticMarkup(
    createElement(CopyButton, {
      label: 'Copy link to message',
      text: '/dashboard?task=t#message-m',
      menuItem: true,
    }),
  );
  assert.match(html, /<button[^>]*class="ui-copy-menu-item"[^>]*>.*Copy link to message<\/button>/);
  assert.match(html, /aria-live="polite"/);
});

test('single-row phone title keeps its return action, state and utility cluster in one header', async () => {
  const { CompactTopBar } = await import('./Compact.tsx');
  const html = renderToStaticMarkup(
    createElement(CompactTopBar, {
      title: 'Task',
      singleRow: true,
      context: 'Merged',
      onBack() {},
      action: createElement(IconButton, { icon: 'more', label: 'More task actions' }),
    }),
  );
  assert.match(html, /data-single-row/);
  assert.match(html, /Back to tasks/);
  assert.match(html, /Merged/);
  assert.match(html, /More task actions/);
  assert.doesNotMatch(html, /compact-top-actions/);
});
