import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxItem } from '../../../../../shared/v2/contracts.ts';
import { QuestionDecision } from './QuestionDecision.tsx';

const item: InboxItem = {
  id: 'question:q',
  kind: 'question',
  from: 'custom-id',
  fromName: 'Release notes writer',
  projectName: 'home-gym',
  taskId: 'task/id',
  title: 'Should I publish?',
  text: 'Should I publish?',
  createdAt: '2026-11-03T12:00:00Z',
  state: 'waiting',
  context: {
    text: '# Draft release notes\n\n- **Verified** the app.\n\n<script>alert(1)</script>',
    messageId: 'm',
    createdAt: '2026-11-03T11:59:00Z',
  },
  actions: [
    { id: 'option:0', label: 'Do not publish', primary: true },
    { id: 'answer', label: 'Answer' },
    { id: 'dismiss', label: 'Dismiss' },
  ],
};
function render(note = '', pending = false, decision = item) {
  return renderToStaticMarkup(
    createElement(QuestionDecision, {
      item: decision,
      name: decision.fromName!,
      note,
      pending,
      setNote() {},
      choose() {},
    }),
  );
}
test('a question renders its identity once, safe markdown, task link, then answer controls', () => {
  const html = render();
  assert.equal(html.split('Should I publish?').length - 1, 1);
  assert.match(html, /Release notes writer/);
  assert.doesNotMatch(html, /custom-id/);
  assert.match(html, /home-gym · /);
  assert.match(html, /<h1>Draft release notes<\/h1>/);
  assert.match(html, /<strong>Verified<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="\/dashboard\/tasks\/task%2Fid"/);
  assert(html.indexOf('Draft release notes') < html.indexOf('Do not publish'));
  assert(html.indexOf('Do not publish') < html.indexOf('Your answer'));
  assert(html.indexOf('Dismiss') < html.indexOf('>Answer</button>'));
  assert.doesNotMatch(html, /Scroll to read more/);
});
test('Answer requires non-whitespace text and remains disabled while saving', () => {
  for (const [note, pending, disabled] of [
    ['', false, true],
    [' \n ', false, true],
    ['Ready', false, false],
    ['Ready', true, true],
  ] as const) {
    const button = render(note, pending).match(/<button[^>]*>Answer<\/button>/)?.[0];
    assert(button);
    assert.equal(button.includes('disabled'), disabled);
  }
  const html = render('', false, { ...item, context: null });
  assert.doesNotMatch(html, /<article/);
  assert.match(html, /Open the task/);
});
