import test from 'node:test';
import assert from 'node:assert/strict';
import { allCopiesLocal } from './presentation.ts';
import type { BackupsResponse } from '../../../../../../shared/v2/contracts.ts';
const data = (destinations: string[]): BackupsResponse => ({
  backups: [],
  restores: [],
  schedules: destinations.map((destination) => ({
    name: destination,
    enabled: true,
    destination,
    schedule: '0 3 * * *',
    contents: 'Data',
  })),
});
test('off-site warning requires every known destination to be a local path', () => {
  assert.equal(allCopiesLocal(data(['/mnt/backup', 'C:\\Backups'])), true);
  assert.equal(allCopiesLocal(data(['/mnt/backup', 'user@remote:/backups'])), false);
  assert.equal(allCopiesLocal(data(['/mnt/backup', 's3://backup'])), false);
  assert.equal(allCopiesLocal(data([])), false);
  assert.equal(allCopiesLocal(data(['Unknown'])), false);
});
