import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changedLine,
  documentLine,
  inlineHtml,
  inlineMarkdown,
  readBlocks,
  reviewMarks,
} from './document-model';

type Fake = {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: Fake[];
  getAttribute?: (name: string) => string | null;
};
const text = (value: string): Fake => ({
  nodeType: 3,
  nodeName: '#text',
  textContent: value,
  childNodes: [],
});
const el = (name: string, children: Fake[], attrs: Record<string, string> = {}): Fake => ({
  nodeType: 1,
  nodeName: name.toUpperCase(),
  textContent: children.map((child) => child.textContent ?? '').join(''),
  childNodes: children,
  getAttribute: (key) => attrs[key] ?? null,
});

test('inline markdown shows as HTML and nothing else runs', () => {
  assert.equal(
    inlineHtml('A **bold** and *quiet* `code` [link](https://x.test) <b>'),
    'A <strong>bold</strong> and <em>quiet</em> <code>code</code> <a href="https://x.test">link</a> &lt;b&gt;',
  );
  assert.doesNotMatch(inlineHtml('[bad](javascript:alert(1))'), /<a/);
});

test('what was typed on the page reads back as blocks', () => {
  const page = el('div', [
    el('p', [text('First '), el('b', [text('bold')]), text('.')]),
    el('h2', [text('What moves')]),
    el('ul', [el('li', [text('One')]), el('li', [el('a', [text('Two')], { href: '/x' })])]),
    el('ol', [el('li', [el('code', [text('pnpm')])])]),
    el('p', [el('br', [])]),
    el('pre', [text('a\nb\n')]),
  ]);
  assert.deepEqual(readBlocks(page), [
    { kind: 'paragraph', text: 'First **bold**.' },
    { kind: 'heading', level: 2, text: 'What moves' },
    { kind: 'bullet', text: 'One' },
    { kind: 'bullet', text: '[Two](/x)' },
    { kind: 'number', text: '`pnpm`' },
    { kind: 'code', text: 'a\nb' },
  ]);
  assert.equal(inlineMarkdown(el('p', [el('i', [text('x')])])), '*x*');
  assert.equal(changedLine(1), '1 block changed on this branch');
  assert.equal(changedLine(2), '2 blocks changed on this branch');
});

test('a document’s line says where it is', () => {
  assert.equal(
    documentLine('deploy.local', 'main', '3 days ago'),
    'deploy.local · Document · on main · changed 3 days ago',
  );
  assert.equal(documentLine('deploy.local', 'new'), 'deploy.local · Document · not on main yet');
  assert.equal(
    documentLine('deploy.local', 'branch', '', 2),
    'deploy.local · Document · 2 blocks changed on this branch',
  );
});

test('a review marks the blocks that differ on each side, and a new document has no Before', () => {
  const main = '# Plan\n\nOne.\n\n- Keep\n\nOld order.\n';
  const proposed = '# Plan\n\nOne.\n\n- Keep\n- Added\n\nNew order.\n';
  const after = reviewMarks(main, proposed, 'after');
  assert.deepEqual(after.marked, [false, false, true, true]);
  assert.equal(after.progress, '2 blocks changed');
  const before = reviewMarks(main, proposed, 'before');
  assert.deepEqual(before.marked, [false, false, true]);
  assert.equal(before.blocks[2].text, 'Old order.');
  const made = reviewMarks(null, proposed, 'before');
  assert.equal(made.isNew, true);
  assert.equal(made.side, 'after');
  assert.deepEqual(made.marked, [false, false, false, false]);
  assert.equal(made.progress, 'new document');
});
