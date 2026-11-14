import test from 'node:test';
import assert from 'node:assert/strict';
import { readStoredText, readStoredUrls } from './stored-urls.ts';

test('records without an old link are returned untouched, without being rebuilt', () => {
  const record = { id: 'a', messages: [{ text: 'hello', at: 1 }], nested: { deep: ['x'] } };
  assert.equal(readStoredUrls(record), record);
  const text = JSON.stringify(record);
  assert.equal(readStoredText(text), text);
});

test('old stored links are converted in text and in assembled values', () => {
  const text = JSON.stringify({
    body: '![shot](/api/workspace/attachments/abc) and /api/v2/attachments/def',
  });
  assert.deepEqual(JSON.parse(readStoredText(text)), {
    body: '![shot](/api/attachments/abc) and /api/conversation-attachments/def',
  });
  assert.deepEqual(readStoredUrls({ ref: 'https://deploy.local/api/v2/attachments/x1' }), {
    ref: 'https://deploy.local/api/conversation-attachments/x1',
  });
  const foreign = { ref: 'https://elsewhere.test/api/v2/attachments/x1' };
  assert.deepEqual(readStoredUrls(foreign), foreign);
});
