import assert from 'node:assert/strict';
import test from 'node:test';
import { runInbox } from './cli-v2.mjs';
const item = {
  id: 'design:tally:branch:commit',
  state: 'waiting',
  title: 'Header',
  from: 'Designer',
  text: 'Review',
  actions: [
    { id: 'approve', label: 'Approve' },
    { id: 'update', label: 'Ask to update' },
  ],
};
test('CLI directs unresolved designs to review and leaves choices to the review', async () => {
  const writes = [];
  const api = async (path, options) => {
    if (options) {
      writes.push(path);
      return { item };
    }
    if (path.includes('/design/reviews')) return { proposals: [{ id: item.id, stale: true }] };
    return { items: [item] };
  };
  await assert.rejects(
    () => runInbox(api, [item.id, 'approve'], { yes: true }, async () => ''),
    /Resolve the conflicting screens in the review/,
  );
  assert.equal(writes.length, 0);
  await runInbox(api, [item.id, 'update'], { yes: true }, async () => '');
  assert.equal(writes.length, 1);
});
test('CLI approvals continue when choices are resolved or the older coordinator lacks summaries', async () => {
  for (const old of [false, true]) {
    let writes = 0;
    const api = async (path, options) => {
      if (options) {
        writes++;
        return { item };
      }
      if (path.includes('/design/reviews')) {
        if (old) throw Object.assign(new Error('Not found'), { status: 404 });
        return { proposals: [{ id: item.id, stale: false }] };
      }
      return { items: [item] };
    };
    await runInbox(api, [item.id, 'approve'], { yes: true }, async () => '');
    assert.equal(writes, 1);
  }
});
