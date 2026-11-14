import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { BackupCatalog } from './backups/catalog.ts';
import { requireBackupAccess } from './backups/port.ts';
import { backupSchedules, homeBackupSchedule } from './backups/schedules.ts';
import { selfUpdateHistory } from './backups/history.ts';
import { homeScope } from './backups/scopes.ts';

test('backup contract is dependency-free, unwired access throws, and catalog has no mutation dispatcher', async () => {
  const contract = readFileSync(new URL('./contracts/backup-provider.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(contract, /\b(?:import|from|function|const|let|class|enum)\b/);
  assert.throws(
    () => requireBackupAccess('test process'),
    /BackupAccess is not wired in test process/,
  );
  const catalog = new BackupCatalog(
    [
      {
        id: 'home-bundle',
        scope: homeScope,
        inventory: async () => [],
        history: async () => ({ lastSucceeded: null, lastFailed: null, unknown: ['no evidence'] }),
      },
      {
        id: 'directory-copy',
        scope: homeScope,
        inventory: async () => {
          throw new Error('drive unavailable');
        },
        history: async () => {
          throw new Error('unreachable');
        },
      },
    ],
    () => [],
  );
  const inventory = await catalog.inventory();
  assert.equal(inventory.length, 2);
  assert.deepEqual(inventory[0].holdings, []);
  assert.deepEqual(inventory[0].history?.unknown, ['no evidence']);
  assert.equal(inventory[1].unavailable, 'Error: drive unavailable');
  for (const operation of ['restore', 'capture', 'start', 'stop'])
    assert.equal(operation in catalog, false);
  assert.throws(() => catalog.source('self-update'), /not wired/);
  assert.throws(
    () => new BackupCatalog([catalog.sources[0], catalog.sources[0]], () => []),
    /Duplicate/,
  );
});

test('schedule interface preserves configured cron, Home startup check, fallbacks and retention without starting timers', () => {
  const defaults = homeBackupSchedule({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.cron, '30 2 * * *');
  assert.equal(defaults.initialCheckMs, 30_000);
  assert.equal(defaults.maxAgeDays, 7);
  assert.equal(defaults.retention, 8);
  const configured = homeBackupSchedule({
    DEPLOY_RECOVERY_PASSPHRASE: 'long enough passphrase',
    DEPLOY_RECOVERY_SCHEDULE: '0 4 * * *',
    DEPLOY_RECOVERY_RETENTION: '3',
    DEPLOY_RECOVERY_MAX_AGE_DAYS: '2',
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.cron, '0 4 * * *');
  assert.equal(configured.retention, 3);
  assert.equal(configured.maxAgeDays, 2);
  assert.equal(
    homeBackupSchedule({
      DEPLOY_RECOVERY_PASSPHRASE: 'short',
      DEPLOY_RECOVERY_RETENTION: '-1',
      DEPLOY_RECOVERY_MAX_AGE_DAYS: '0',
    }).retention,
    8,
  );
  const schedules = backupSchedules({ enabled: true, cron: '12 1 * * *' }, {});
  assert.equal(schedules.find((row) => row.provider === 'directory-copy')?.cron, '12 1 * * *');
  assert.equal(schedules.find((row) => row.provider === 'self-update')?.retention, 6);
  assert.equal(
    schedules.find((row) => row.provider === 'application-data')?.trigger,
    'before-directory-copy',
  );
});

test('self-update history reports the backup step outcome, independently of later activation failure', () => {
  const directory = mkdtempSync('/tmp/backup-catalog-history-');
  try {
    writeFileSync(
      join(directory, 'history.json'),
      JSON.stringify([
        {
          id: 'old',
          state: 'failed',
          steps: [
            {
              id: 'backup',
              state: 'failed',
              finishedAt: '2026-01-01T00:00:00Z',
              detail: 'disk full',
            },
          ],
        },
        {
          id: 'new',
          state: 'failed',
          steps: [
            { id: 'backup', state: 'done', finishedAt: '2026-01-02T00:00:00Z' },
            { id: 'restart', state: 'failed' },
          ],
        },
      ]),
    );
    const result = selfUpdateHistory(directory);
    assert.equal(result.lastSucceeded?.at, '2026-01-02T00:00:00Z');
    assert.equal(result.lastFailed?.error, 'disk full');
    assert.deepEqual(selfUpdateHistory(undefined).lastSucceeded, null);
    writeFileSync(join(directory, 'current.json'), '{invalid');
    assert.throws(() => selfUpdateHistory(directory), SyntaxError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
