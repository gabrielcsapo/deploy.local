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
