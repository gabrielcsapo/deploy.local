import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxItem } from '../../shared/v2/contracts.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-inbox-producers-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, list } = await import('../workspace/store.ts');
const { createInboxItem, registerInboxAction, answerInbox, syncInbox, withdrawInboxItems } =
  await import('./inbox.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const owner = 'gabriel';
function decision(id: string): InboxItem {
  return {
    id,
    kind: 'other',
    from: 'warden',
    projectId: 'gym',
    title: 'Continue?',
    text: 'Review work',
    createdAt: new Date().toISOString(),
    state: 'waiting',
    actions: ['execute', 'keep', 'dismiss', 'not-now'].map((id) => ({ id, label: id })),
  };
}

test('one native store, private context, missing handlers leave decisions waiting', () => {
  const item = createInboxItem(owner, decision('missing'), { secret: 'private' });
  assert.deepEqual(createInboxItem(owner, { ...item, title: 'Changed' }, {}), item);
  assert.throws(() => answerInbox(owner, item.id, { actionId: 'execute', on: 'web' }), {
    status: 501,
  });
  assert.equal(syncInbox(owner).find((i) => i.id === item.id)!.state, 'waiting');
  assert.equal(list('v2-inbox-answer', owner).length, 0);
  assert.equal(list('v2-inbox-produced', owner).length, 0);
  assert.equal(list('v2-inbox-native', owner).length, 1);
  assert(!JSON.stringify(syncInbox(owner)).includes('secret'));
  assert(
    !JSON.stringify(db.prepare("SELECT payload FROM events WHERE type='v2.inbox'").all()).includes(
      'secret',
    ),
  );
});

test('keep, dismiss and Not now need no handler and remain first-answer-wins', () => {
  for (const actionId of ['keep', 'dismiss', 'not-now']) {
    const item = createInboxItem(owner, decision(actionId), {});
    const answer = answerInbox(owner, item.id, { actionId, on: 'desktop' });
    assert.equal(answer.state, 'answered');
    assert.equal(answer.answer?.actionId, actionId);
    assert.deepEqual(createInboxItem(owner, item, { changed: true }), answer);
    assert.throws(() => answerInbox(owner, item.id, { actionId, on: 'cli' }), { status: 409 });
  }
});

test('unregister does not remove a newer handler; handler failures save no answer', () => {
  const item = createInboxItem(owner, decision('registered'), { token: 'private' });
  const old = registerInboxAction('other', () => assert.fail('old handler'));
  let calls = 0;
  const unregister = registerInboxAction('other', (who, current, body, context) => {
    assert.equal(who, owner);
    assert.equal(current.id, item.id);
    assert.equal(body.actionId, 'execute');
    assert.equal(context.token, 'private');
    calls++;
    throw new Error('Cannot enqueue');
  });
  old();
  assert.throws(
    () => answerInbox(owner, item.id, { actionId: 'execute', on: 'web' }),
    /Cannot enqueue/,
  );
  assert.equal(calls, 1);
  assert.equal(syncInbox(owner).find((i) => i.id === item.id)!.state, 'waiting');
  unregister();
  assert.throws(() => answerInbox(owner, item.id, { actionId: 'execute', on: 'web' }), {
    status: 501,
  });
  withdrawInboxItems(owner, 'gym', 'other');
  assert.equal(syncInbox(owner).find((i) => i.id === item.id)!.state, 'withdrawn');
  assert.throws(() => answerInbox(owner, item.id, { actionId: 'keep', on: 'web' }), {
    status: 409,
  });
});
