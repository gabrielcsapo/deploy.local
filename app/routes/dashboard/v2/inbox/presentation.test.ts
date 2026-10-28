import test from 'node:test';
import assert from 'node:assert/strict';
import { answerDetails } from './presentation.ts';
import type { InboxItem } from '../../../../../shared/v2/contracts.ts';
const now = new Date(2026, 9, 28, 16);
const item = (
  on: NonNullable<InboxItem['answer']>['on'],
  at = new Date(2026, 9, 28, 14, 33).toISOString(),
): InboxItem => ({
  id: 'x',
  kind: 'rollback',
  title: 'Rollback',
  text: '',
  from: 'warden',
  createdAt: at,
  actions: [],
  state: 'answered',
  answer: { actionId: 'rollback', by: 'gabriel', on, at },
});
test('answer provenance uses short local clocks and the real client', () => {
  for (const [on, platform] of [
    ['web', 'on the web'],
    ['iphone', 'on iPhone'],
    ['desktop', 'on this Mac'],
    ['cli', 'in the terminal'],
  ] as const)
    assert.equal(answerDetails(item(on), now), `you answered at 2:33 PM ${platform}`);
  const menu = item('desktop');
  menu.answer!.surface = 'menu-bar';
  assert.equal(answerDetails(menu, now), 'you answered at 2:33 PM from the menu bar');
  assert.match(
    answerDetails(item('web', new Date(2026, 9, 27, 14, 33).toISOString()), now),
    /yesterday at 2:33 PM/,
  );
  assert.match(
    answerDetails(item('web', new Date(2025, 9, 1, 14, 33).toISOString()), now),
    /Oct 1, 2025/,
  );
});
