import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cron } from 'croner';
import { deployDataPath } from './data-directory.ts';
import {
  createRecoveryBundle,
  rehearseRecoveryBundle,
  verifyRecoveryBundle,
} from './recovery-bundle.ts';
import { getSqlite } from './store.ts';

export interface ScheduledRecoveryDependencies {
  create(input: { outputPath: string; passphrase: string }): Promise<{ id: string }>;
  verify(input: { bundlePath: string; passphrase: string; bundleId: string }): unknown;
  rehearse(input: { bundleId: string; bundlePath: string; passphrase: string }): unknown;
  retain(bundleId: string, outputPath: string, keep: number): void;
  now(): Date;
}

export async function runScheduledRecoveryBoundary(input: {
  passphrase: string;
  outputDirectory?: string;
  retention?: number;
  dependencies?: ScheduledRecoveryDependencies;
}): Promise<{ bundleId: string; outputPath: string }> {
  if (input.passphrase.length < 12) {
    throw new Error('DEPLOY_RECOVERY_PASSPHRASE must contain at least 12 characters');
  }
  const dependencies = input.dependencies ?? productionDependencies();
  const outputDirectory = resolve(input.outputDirectory || deployDataPath('recovery-bundles'));
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const stamp = dependencies.now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const outputPath = resolve(outputDirectory, `home-recovery-${stamp}.json`);
  const created = await dependencies.create({ outputPath, passphrase: input.passphrase });
  dependencies.verify({
    bundlePath: outputPath,
    passphrase: input.passphrase,
    bundleId: created.id,
  });
  dependencies.rehearse({
    bundleId: created.id,
    bundlePath: outputPath,
    passphrase: input.passphrase,
  });
  dependencies.retain(created.id, outputPath, positiveInteger(input.retention, 8));
  return { bundleId: created.id, outputPath };
}

export function startRecoveryBoundaryScheduler(): { stop(): void; configured: boolean } {
  const passphrase = process.env.DEPLOY_RECOVERY_PASSPHRASE;
  if (!passphrase) return { stop() {}, configured: false };
  if (passphrase.length < 12) {
    console.error('Scheduled Home recovery is disabled: DEPLOY_RECOVERY_PASSPHRASE is too short');
    return { stop() {}, configured: false };
  }
  const run = () =>
    runScheduledRecoveryBoundary({
      passphrase,
      outputDirectory: process.env.DEPLOY_RECOVERY_DIRECTORY,
      retention: positiveInteger(Number(process.env.DEPLOY_RECOVERY_RETENTION), 8),
    })
      .then(() => undefined)
      .catch((error) =>
        console.error(
          `Scheduled Home recovery boundary failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  const schedule = process.env.DEPLOY_RECOVERY_SCHEDULE || '30 2 * * *';
  const job = new Cron(schedule, run);
  const initial = setTimeout(() => void ensureFreshScheduledBoundary(run), 30_000);
  initial.unref();
  return {
    configured: true,
    stop() {
      clearTimeout(initial);
      job.stop();
    },
  };
}

function productionDependencies(): ScheduledRecoveryDependencies {
  return {
    create: createRecoveryBundle,
    verify: verifyRecoveryBundle,
    rehearse: rehearseRecoveryBundle,
    now: () => new Date(),
    retain(bundleId, outputPath, keep) {
      const sqlite = getSqlite()!;
      sqlite
        .prepare(
          `UPDATE fleet_recovery_bundles
              SET encryption_metadata = json_set(encryption_metadata, '$.scheduledPath', ?)
            WHERE id = ? AND verification_status = 'verified' AND rehearsal_status = 'passed'`,
        )
        .run(outputPath, bundleId);
      const stale = sqlite
        .prepare(
          `SELECT id, json_extract(encryption_metadata, '$.scheduledPath') AS path
             FROM fleet_recovery_bundles
            WHERE json_extract(encryption_metadata, '$.scheduledPath') IS NOT NULL
            ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
        )
        .all(keep) as Array<{ id: string; path: string }>;
      const removeRecord = sqlite.prepare('DELETE FROM fleet_recovery_bundles WHERE id = ?');
      sqlite.transaction(() => {
        for (const record of stale) {
          const scheduledPath = resolve(record.path);
          if (existsSync(scheduledPath)) rmSync(scheduledPath);
          removeRecord.run(record.id);
        }
      })();
    },
  };
}

function ensureFreshScheduledBoundary(run: () => Promise<unknown>): void {
  const maxAgeDays = positiveInteger(Number(process.env.DEPLOY_RECOVERY_MAX_AGE_DAYS), 7);
  const latest = getSqlite()!
    .prepare(
      `SELECT verified_at, rehearsal_status
         FROM fleet_recovery_bundles
        WHERE verification_status = 'verified' ORDER BY verified_at DESC LIMIT 1`,
    )
    .get() as { verified_at: string | null; rehearsal_status: string | null } | undefined;
  const fresh =
    latest?.rehearsal_status === 'passed' &&
    latest.verified_at &&
    Date.now() - Date.parse(latest.verified_at) <= maxAgeDays * 24 * 60 * 60 * 1000;
  if (!fresh) void run();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
