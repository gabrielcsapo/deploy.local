import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupOutcome } from '../contracts/backup-provider.ts';

export function newestOutcome(values: BackupOutcome[]): BackupOutcome | null {
  return values.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).at(0) ?? null;
}

/** Read receipts only. Never query systemd or settle a running updater as part of a catalog read. */
export function selfUpdateHistory(directory: string | undefined) {
  const succeeded: BackupOutcome[] = [];
  const failed: BackupOutcome[] = [];
  if (directory) {
    for (const name of ['history.json', 'current.json']) {
      let value;
      try {
        value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const run of Array.isArray(value) ? value : [value]) {
        const step = run.steps?.find((entry: { id: string }) => entry.id === 'backup');
        if (!step || !['done', 'failed'].includes(step.state)) continue;
        const outcome = {
          at: step.finishedAt ?? null,
          evidence: `${join(directory, name)}: ${run.id} backup step`,
          ...(step.state === 'failed' ? { error: step.detail } : {}),
        };
        (step.state === 'done' ? succeeded : failed).push(outcome);
      }
    }
  }
  return {
    lastSucceeded: newestOutcome(succeeded),
    lastFailed: newestOutcome(failed),
    unknown: [
      'Only retained updater receipts are available; copy mtime alone does not prove pair success',
    ],
  };
}
