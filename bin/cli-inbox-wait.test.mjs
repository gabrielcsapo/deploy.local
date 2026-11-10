import assert from 'node:assert/strict';
import test from 'node:test';
import { waitInbox } from './cli-v2.mjs';

const design = {
  id: 'design:p1:design-build-check:b03c6c0b',
  title: 'A task that builds an approved design is checked against it',
  state: 'waiting',
  actions: [{ id: 'approve', label: 'Approve design' }],
};
const merge = { id: 'merge:18', title: 'Merge PR #18', state: 'waiting', actions: [] };

/** An inbox whose item is answered after a number of reads of the waiting list. */
function inbox(answerAfter, items = [design, merge]) {
  let reads = 0;
  return async (path) => {
    const answered = reads >= answerAfter;
    if (path.includes('state=waiting')) {
      reads++;
      return { items: answered ? items.filter((item) => item !== design) : items };
    }
    return {
      items: answered
        ? [
            {
              ...design,
              state: 'answered',
              answer: { actionId: 'approve', by: 'alice', on: 'web' },
            },
          ]
        : [],
    };
  };
}
const clock = () => {
  let time = 0;
  return { now: () => time, sleep: async (ms) => void (time += ms) };
};

test('inbox wait returns the answer once the owner decides, found by ID or by title words', async () => {
  const byId = await waitInbox(inbox(2), design.id, { json: true }, clock());
  assert.equal(byId.item.answer.actionId, 'approve');
  const byTitle = await waitInbox(inbox(1), 'approved design is checked', { json: true }, clock());
  assert.equal(byTitle.item.id, design.id);
});

test('inbox wait gives up when the time runs out, and says what is still waiting', async () => {
  const result = await waitInbox(inbox(1000), design.id, { seconds: 10, json: true }, clock());
  assert.equal(result.waiting.id, design.id);
  assert.equal(result.item, undefined);
});

test('inbox wait refuses a name that is missing or matches more than one item', async () => {
  await assert.rejects(() => waitInbox(inbox(0), '', { json: true }, clock()), /Name the item/);
  await assert.rejects(
    () => waitInbox(inbox(1000), 'no such thing', { json: true }, clock()),
    /Nothing in the inbox matches/,
  );
  const twins = [design, { ...merge, title: 'A task that builds something else' }];
  await assert.rejects(
    () => waitInbox(inbox(1000, twins), 'a task that builds', { json: true }, clock()),
    /More than one item matches/,
  );
});
