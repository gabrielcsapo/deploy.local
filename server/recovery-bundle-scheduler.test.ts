import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  runScheduledRecoveryBoundary,
  type ScheduledRecoveryDependencies,
} from './recovery-bundle-scheduler.ts';

test('scheduled recovery creates, independently verifies, rehearses, then applies retention', async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'deploy-recovery-scheduler-'));
  const calls: string[] = [];
  const dependencies: ScheduledRecoveryDependencies = {
    now: () => new Date('2026-08-08T12:30:00.000Z'),
    async create(input) {
      calls.push(`create:${input.outputPath}`);
      return { id: 'recovery-scheduled' };
    },
    verify(input) {
      calls.push(`verify:${input.bundleId}:${input.bundlePath}`);
    },
    rehearse(input) {
      calls.push(`rehearse:${input.bundleId}:${input.bundlePath}`);
    },
    retain(bundleId, outputPath, keep) {
      calls.push(`retain:${bundleId}:${keep}:${outputPath}`);
    },
  };

  const result = await runScheduledRecoveryBoundary({
    passphrase: 'a sufficiently long recovery passphrase',
    outputDirectory,
    retention: 5,
    dependencies,
  });

  assert.equal(result.bundleId, 'recovery-scheduled');
  assert.match(result.outputPath, /home-recovery-2026-08-08T12-30-00-000Z\.json$/);
  assert.deepEqual(
    calls.map((call) => call.split(':')[0]),
    ['create', 'verify', 'rehearse', 'retain'],
  );
  assert.match(calls[3], /retain:recovery-scheduled:5:/);
  rmSync(outputDirectory, { recursive: true, force: true });
});

test('scheduled recovery refuses an unsafe passphrase before writing', async () => {
  await assert.rejects(
    runScheduledRecoveryBoundary({ passphrase: 'too-short' }),
    /at least 12 characters/,
  );
});
