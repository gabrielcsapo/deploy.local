import type { BackupSchedule } from '../contracts/backup-provider.ts';

type DirectorySettings = { enabled: boolean; cron: string };
type Environment = Record<string, string | undefined>;
const positive = (value: number, fallback: number) =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback;

/** Describes the existing owners. Does not create, stop, or reschedule any timer. */
export function backupSchedules(settings: DirectorySettings, env: Environment): BackupSchedule[] {
  return [
    {
      provider: 'directory-copy',
      owner: 'server/maintenance.ts',
      trigger: 'cron',
      enabled: settings.enabled,
      cron: settings.cron,
      retention: 'all in 24h; latest on 7 UTC dates and 4 UTC weeks; newest',
    },
    {
      provider: 'application-data',
      owner: 'server/maintenance.ts',
      trigger: 'before-directory-copy',
      enabled: settings.enabled,
      retention: 'explicit deletion; no pruning in this capture path',
    },
    {
      provider: 'application-data',
      owner: 'app request / release executor',
      trigger: 'manual-or-release',
      enabled: true,
      retention: 'explicit deletion; no pruning in this capture path',
    },
    homeBackupSchedule(env),
    {
      provider: 'workspace-offline',
      owner: 'server/workspace/recovery.ts',
      trigger: 'manual-offline',
      enabled: true,
      retention: 'operator managed',
    },
    {
      provider: 'self-update',
      owner: 'scripts/self-update.mjs',
      trigger: 'before-self-update',
      enabled: true,
      retention: 6,
    },
  ];
}

export function homeBackupSchedule(env: Environment): BackupSchedule {
  return {
    provider: 'home-bundle',
    owner: 'server/recovery-bundle-scheduler.ts',
    trigger: 'cron',
    enabled: !!env.DEPLOY_RECOVERY_PASSPHRASE && env.DEPLOY_RECOVERY_PASSPHRASE.length >= 12,
    cron: env.DEPLOY_RECOVERY_SCHEDULE || '30 2 * * *',
    initialCheckMs: 30_000,
    maxAgeDays: positive(Number(env.DEPLOY_RECOVERY_MAX_AGE_DAYS), 7),
    retention: positive(Number(env.DEPLOY_RECOVERY_RETENTION), 8),
  };
}
