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
test('the conflict line is printed under its own item, not above it', async () => {
  const other = { ...item, id: 'design:tally:other:commit', title: 'Footer' };
  const api = async (path) => {
    if (path.includes('/design/reviews')) return { proposals: [{ id: item.id, stale: true }] };
    return { items: [other, item] };
  };
  const lines = [];
  const log = console.log;
  const tty = process.stdin.isTTY;
  console.log = (...args) => lines.push(...args.join(' ').split('\n'));
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    await runInbox(api, [], {}, async () => '');
  } finally {
    console.log = log;
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  }
  const footer = lines.findIndex((line) => line.startsWith('! Footer'));
  const header = lines.findIndex((line) => line.startsWith('! Header'));
  const conflict = lines.findIndex((line) => line.includes('Resolve the conflicting screens'));
  assert.ok(footer >= 0 && header > footer, lines.join('\n'));
  assert.ok(conflict > header, `conflict line belongs under Header:\n${lines.join('\n')}`);
  assert.equal(lines.filter((line) => line.includes('Resolve the conflicting')).length, 1);
});
