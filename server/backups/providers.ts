import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCoordinatorApplicationBackup,
  restoreCoordinatorApplicationBackup,
} from '../application-backups.ts';
import { getBackups, getSqlite } from '../store.ts';
import { createRecoveryBundle, recoveryWork } from '../recovery-bundle.ts';
import { listBackupCopies } from '../rsync-backup.ts';
import {
  snapshotWorkspace,
  verifyWorkspaceSnapshot,
  restoreWorkspace,
} from '../workspace/recovery.ts';
import type { BackupProvider } from '../contracts/backup-provider.ts';
import {
  applicationScope,
  directoryScope,
  homeScope,
  workspaceScope,
  selfUpdateScope,
} from './scopes.ts';

const unsupported = (reason: string) => ({ supported: false as const, reason });
const operation = <A extends unknown[], R>(run: (...args: A) => R) => ({
  supported: true as const,
  run,
});

export function homeBundleRecords() {
  return getSqlite()!
    .prepare('SELECT * FROM fleet_recovery_bundles ORDER BY created_at DESC')
    .all() as Array<Record<string, any>>;
}

export function latestVerifiedHomeBundle() {
  return getSqlite()!
    .prepare(
      `SELECT verified_at, rehearsal_status
         FROM fleet_recovery_bundles
        WHERE verification_status = 'verified' ORDER BY verified_at DESC LIMIT 1`,
    )
    .get() as { verified_at: string | null; rehearsal_status: string | null } | undefined;
}

export function createApplicationProvider() {
  return {
    id: 'application-data' as const,
    scope: applicationScope,
    execution: 'coordinator-local' as const,
    capture: operation(createCoordinatorApplicationBackup),
    list: operation(getBackups),
    // The executor verifies during graph capture/restore. There is no non-mutating legacy verifier.
    verify: unsupported(
      'No standalone app-data verifier; use the existing guarded restore-copy test',
    ),
    restore: operation(restoreCoordinatorApplicationBackup),
  } satisfies BackupProvider<
    Parameters<typeof createCoordinatorApplicationBackup>,
    ReturnType<typeof createCoordinatorApplicationBackup>,
    Parameters<typeof getBackups>,
    ReturnType<typeof getBackups>,
    never[],
    never,
    Parameters<typeof restoreCoordinatorApplicationBackup>,
    ReturnType<typeof restoreCoordinatorApplicationBackup>
  >;
}

export function createDirectoryProvider(
  runBackup: () => Promise<{ success: boolean; durationMs: number; error?: string }>,
) {
  return {
    id: 'directory-copy' as const,
    scope: directoryScope,
    execution: 'control' as const,
    capture: operation(runBackup),
    list: operation(listBackupCopies),
    verify: unsupported(
      'Completion markers are not whole-tree verification; no existing standalone verifier',
    ),
    restore: unsupported('Offline only: scripts/restore-backup.mjs with the server stopped'),
  } satisfies BackupProvider<
    [],
    ReturnType<typeof runBackup>,
    Parameters<typeof listBackupCopies>,
    ReturnType<typeof listBackupCopies>,
    never[],
    never,
    never[],
    never
  >;
}

export function createHomeProvider() {
  return {
    id: 'home-bundle' as const,
    scope: homeScope,
    execution: 'control-and-recovery-worker' as const,
    capture: operation(createRecoveryBundle),
    list: operation(homeBundleRecords),
    verify: operation(
      (input: Parameters<typeof import('../recovery-bundle.ts').verifyRecoveryBundle>[0]) =>
        recoveryWork('verify', input),
    ),
    restore: operation(
      (input: Parameters<typeof import('../recovery-bundle.ts').restoreRecoveryBundle>[0]) =>
        recoveryWork('restore', input),
    ),
  } satisfies BackupProvider<
    Parameters<typeof createRecoveryBundle>,
    ReturnType<typeof createRecoveryBundle>,
    [],
    ReturnType<typeof homeBundleRecords>,
    [Parameters<typeof import('../recovery-bundle.ts').verifyRecoveryBundle>[0]],
    Promise<unknown>,
    [Parameters<typeof import('../recovery-bundle.ts').restoreRecoveryBundle>[0]],
    Promise<unknown>
  >;
}

/** Never installed as a restore capability in the online catalog. */
export function createOfflineWorkspaceProvider() {
  return {
    id: 'workspace-offline' as const,
    scope: workspaceScope,
    execution: 'offline-command' as const,
    capture: operation(snapshotWorkspace),
    list: unsupported('No managed snapshot directory; supply snapshot paths explicitly'),
    verify: operation(verifyWorkspaceSnapshot),
    restore: operation(restoreWorkspace),
  } satisfies BackupProvider<
    Parameters<typeof snapshotWorkspace>,
    ReturnType<typeof snapshotWorkspace>,
    never[],
    never,
    Parameters<typeof verifyWorkspaceSnapshot>,
    ReturnType<typeof verifyWorkspaceSnapshot>,
    Parameters<typeof restoreWorkspace>,
    ReturnType<typeof restoreWorkspace>
  >;
}

export function selfUpdateCopies(dataDirectory: string) {
  const directory = join(dataDirectory, 'backups');
  return readdirSync(directory)
    .filter((name) => /^self-update-[0-9a-f]{7}-(deploy|workspace)\.db$/.test(name))
    .map((name) => ({
      name,
      path: join(directory, name),
      modifiedAt: statSync(join(directory, name)).mtime.toISOString(),
    }));
}

export function createSelfUpdateProvider() {
  return {
    id: 'self-update' as const,
    scope: selfUpdateScope,
    execution: 'self-update-process' as const,
    capture: operation(async (dataDirectory: string, revision: string) => {
      const { backupSelfUpdateDatabases } = await import('../../scripts/self-update.mjs');
      return backupSelfUpdateDatabases(dataDirectory, revision);
    }),
    list: operation(selfUpdateCopies),
    verify: unsupported('No existing standalone self-update copy verifier'),
    restore: unsupported('No self-update data restore command; operator database recovery only'),
  } satisfies BackupProvider<
    [string, string],
    Promise<void>,
    [string],
    ReturnType<typeof selfUpdateCopies>,
    never[],
    never,
    never[],
    never
  >;
}
