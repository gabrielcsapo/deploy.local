import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from './message-content.client';

const render = (content: string) =>
  renderToStaticMarkup(createElement(MessageContent, { content }));

test('conversation documents retain tables, nested lists, tasks, quotes and code structure', () => {
  const html = render(`## Results

| Computer | Result |
| --- | --- |
| Mac | **Passed** |

1. Review
   - Source
   - Tests

- [x] Complete

> Keep the conversation together.

\`\`\`javascript
const result = "passed";
\`\`\`
`);
  assert.match(html, /<h2>Results<\/h2>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Computer<\/th>/);
  assert.match(html, /<td><strong>Passed<\/strong><\/td>/);
  assert.match(html, /<ol>[\s\S]*<ul>/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /aria-label="Copy code"/);
  assert.match(html, /language-javascript/);
  assert.match(html, /hljs-keyword/);
});

test('untrusted messages cannot execute raw HTML or executable URL schemes', () => {
  const html = render(
    '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29)\n\n[safe](https://example.com)',
  );
  assert.doesNotMatch(html, /<script|onerror=|href="javascript:/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
});
