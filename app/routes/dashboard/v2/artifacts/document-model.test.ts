import test from 'node:test';
import assert from 'node:assert/strict';
import { changedLine, inlineHtml, inlineMarkdown, readBlocks } from './document-model';

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
