import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationDays, mergeEvents, safeResourceUrl } from './model.ts';
import type { ConversationEvent } from '../../../../../shared/v2/contracts.ts';
const reply = (id: string, at: string): ConversationEvent => ({
  kind: 'reply',
  id,
  at,
  agent: 'scout',
  paragraphs: ['Ready'],
});
test('Earlier days fold but every decision remains visible outside its disclosure', () => {
  const days = conversationDays([
    reply('a', '2026-10-26T12:00:00Z'),
    { kind: 'decision', id: 'd', at: '2026-10-26T13:00:00Z', inboxItemId: 'question:q' },
    reply('b', '2026-10-27T12:00:00Z'),
  ]);
  assert.equal(days.length, 2);
  assert.equal(days[0].folded, true);
  assert.equal(days[1].folded, false);
  assert.equal(days[0].pinned[0].id, 'd');
  assert.equal(days.flatMap((day) => day.events).length, 3);
});
test('Stream updates replace work logs and preserve unrelated messages', () => {
  const event: ConversationEvent = {
    kind: 'worklog',
    id: 'work:1',
    at: '2026-10-27T12:00:00Z',
    summary: 'Working',
    live: true,
    steps: [],
  };
  const result = mergeEvents(
    [event, reply('r', '2026-10-27T13:00:00Z')],
    [{ ...event, live: false, summary: 'Worked for 1m' }],
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].kind === 'worklog' && result[0].live, false);
});
test('Attachments cannot execute scripts or navigate protocol-relative URLs', () => {
  for (const value of ['javascript:alert(1)', '//example.com', 'data:text/html,x'])
    assert.equal(safeResourceUrl(value), undefined);
  assert.equal(safeResourceUrl('/api/files/one'), '/api/files/one');
});
