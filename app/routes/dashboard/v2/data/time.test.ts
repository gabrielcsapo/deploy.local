import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTime } from './time.ts';

const now = new Date(2026, 9, 27, 14, 43);
test('Task timestamps use short relative, elapsed and clock forms', () => {
  const at = new Date(2026, 9, 27, 14, 41);
  assert.equal(formatTime(at, 'relative', now), '2 min ago');
  assert.equal(formatTime(new Date(2026, 9, 27, 14, 23), 'elapsed', now), '20 min');
  assert.equal(formatTime(at, 'clock', now), '2:41 PM');
  assert.equal(formatTime(new Date(2026, 9, 26, 23, 59), 'relative', now), 'Yesterday');
  assert.equal(formatTime(new Date(2026, 9, 27, 14, 44), 'relative', now), 'Just now');
  assert.equal(formatTime('invalid', 'relative', now), 'Unavailable');
  assert.equal(formatTime(undefined, 'clock', now), 'Unavailable');
});
test('Calendar labels respect local midnight, year boundaries and daylight saving days', () => {
  assert.equal(formatTime(now, 'day', now), 'Today');
  assert.equal(formatTime(new Date(2026, 9, 26), 'day', now), 'Yesterday');
  assert.equal(formatTime(new Date(2026, 9, 25), 'day', now), 'Sunday');
  assert.equal(formatTime(new Date(2025, 9, 25), 'day', now), 'Oct 25, 2025');
  const newYear = new Date(2027, 0, 1, 0, 1);
  assert.equal(formatTime(new Date(2026, 11, 31, 23, 59), 'day', newYear), 'Yesterday');
  const spring = new Date(2026, 2, 9, 0, 1);
  assert.equal(formatTime(new Date(2026, 2, 8, 0, 1), 'day', spring), 'Yesterday');
});

test('List timestamps use calendar labels with compact local clock times', () => {
  const listNow = new Date(2026, 9, 29, 18, 0);
  assert.equal(formatTime(new Date(2026, 9, 29, 17, 59, 1), 'list', listNow), 'now');
  assert.equal(formatTime(new Date(2026, 9, 29, 17, 59), 'list', listNow), '5:59');
  assert.equal(formatTime(new Date(2026, 9, 29, 7, 2), 'list', listNow), '7:02');
  assert.equal(formatTime(new Date(2026, 9, 29, 0, 2), 'list', listNow), '12:02');
  assert.equal(formatTime(new Date(2026, 9, 28, 23, 59), 'list', listNow), 'Yesterday');
  assert.equal(formatTime(new Date(2026, 9, 26), 'list', listNow), 'Mon');
  assert.equal(formatTime(new Date(2026, 9, 23), 'list', listNow), 'Fri');
  assert.equal(formatTime(new Date(2026, 9, 22), 'list', listNow), '22 Oct');
  assert.equal(formatTime(new Date(2026, 9, 12), 'list', listNow), '12 Oct');
  assert.equal(formatTime('invalid', 'list', listNow), 'Unavailable');
  assert.equal(formatTime(undefined, 'list', listNow), 'Unavailable');
  assert.equal(
    formatTime(new Date(2026, 11, 31, 23, 58), 'list', new Date(2027, 0, 1, 0, 1)),
    'Yesterday',
  );
});

test('Weekly schedule summaries are plural; daily and change schedules retain their copy', async () => {
  const { itemWhen, itemSummary } = await import('../../../../../shared/v2/agents.ts');
  const item = {
    id: 'weekly',
    what: 'Draft release notes',
    where: { projects: ['gym'] },
    when: { every: 'week' as const, day: 5, time: '16:00', timezone: 'America/New_York' },
    brings: 'message' as const,
  };
  assert.equal(itemWhen(item), 'Fridays 16:00');
  assert.equal(
    itemSummary(item, [{ id: 'gym', name: 'home-gym' }]),
    'home-gym · Fridays 16:00 · brings a message',
  );
  assert.equal(
    itemWhen({ ...item, when: { ...item.when, day: 1, time: '08:40' } }),
    'Mondays 08:40',
  );
  assert.equal(
    itemWhen({ ...item, when: { ...item.when, every: 'day', time: '08:00' } }),
    'Every day 08:00',
  );
  assert.equal(itemWhen({ ...item, when: { ...item.when, every: 'change' } }), 'On each change');
});
