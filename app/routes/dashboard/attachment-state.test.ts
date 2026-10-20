import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentChips, restoreAttachmentDraft, type Attachment } from './attachment-state.ts';
const image: Attachment = {
  id: 'a',
  taskId: 'task',
  kind: 'image',
  mimeType: 'image/png',
  size: 10,
  name: 'screen.png',
  source: 'user',
  createdAt: '2026-10-20T00:00:00Z',
};
test('composer chips add once, preserve other chips and remove by attachment id', () => {
  const a = attachmentChips([], { add: image });
  assert.deepEqual(attachmentChips(a, { add: image }), a);
  const b = attachmentChips(a, { add: { ...image, id: 'b' } });
  assert.deepEqual(
    attachmentChips(b, { remove: 'a' }).map((a) => a.id),
    ['b'],
  );
  assert.equal(a.length, 1);
});
test('drafts restore uploaded ids and discard malformed stored values', () => {
  assert.deepEqual(restoreAttachmentDraft(JSON.stringify([image])), [image]);
  for (const raw of [null, '{}', '{bad', '[null,{}]'])
    assert.deepEqual(restoreAttachmentDraft(raw), []);
});
