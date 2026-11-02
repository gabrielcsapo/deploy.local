import test from 'node:test';
import assert from 'node:assert/strict';
import { fileSize, repositoryTime, sourceLines } from './code.ts';
test('source line count handles empty files, CRLF and trailing newlines', () => {
  assert.deepEqual(sourceLines(''), []);
  assert.deepEqual(sourceLines('one\r\n\r\nthree\r\n'), ['one', '', 'three']);
  assert.deepEqual(sourceLines('\n'), ['']);
  assert.deepEqual(sourceLines('one\n\n'), ['one', '']);
  assert.equal(fileSize(1434), '1.4 KB');
  assert.equal(fileSize(0), '0 B');
});
test('repository dates use full relative units and expose absent dates', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(repositoryTime('2026-11-02T06:00:00Z', now), '6 hours ago');
  assert.equal(repositoryTime('2026-11-01T12:00:00Z', now), '1 day ago');
  assert.equal(repositoryTime('2026-10-12T12:00:00Z', now), '3 weeks ago');
  assert.equal(repositoryTime('bad', now), 'Unavailable');
});
test('source highlighting keeps Markdown fences and HTML inside the file', async () => {
  const { sourceMarkdown } = await import('./code.ts');
  assert.equal(
    sourceMarkdown('example.ts', '<script>\n```\n</script>\n'),
    '````typescript\n<script>\n```\n</script>\n````',
  );
  assert.equal(sourceMarkdown('binary.unknown', 'hello'), '```text\nhello\n```');
});
