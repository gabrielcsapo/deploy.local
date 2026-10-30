import test from 'node:test';
import assert from 'node:assert/strict';
import { fileMarkdown, fileSize, safeUrl } from './description.ts';

test('only own files and web links survive as URLs', () => {
  assert.equal(safeUrl('/api/v2/pulls/pr1/files/0a1b-2c'), '/api/v2/pulls/pr1/files/0a1b-2c');
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    '/api/v2/tasks',
    'vbscript:x',
  ])
    assert.equal(safeUrl(url), '');
});
test('a dropped file inserts an image or a link, and its size reads plainly', () => {
  const url = '/api/v2/pulls/pr1/files/ab';
  assert.equal(fileMarkdown({ kind: 'image', name: 'flow [1].png', url }), `![flow 1.png](${url})`);
  assert.equal(fileMarkdown({ kind: 'file', name: 'ser.zip', url }), `[ser.zip](${url})`);
  assert.equal(fileSize(900), '900 B');
  assert.equal(fileSize(186_000), '182 KB');
  assert.equal(fileSize(2_200_000), '2.1 MB');
});
