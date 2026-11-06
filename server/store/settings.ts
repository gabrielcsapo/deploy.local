import { getDb } from './connection.ts';
import { systemSettings } from '../schema.ts';
import { eq } from 'drizzle-orm';

// ── System Settings ─────────────────────────────────────────────────────────

export function getSystemSetting(key: string): string | null {
  const db = getDb();
  const row = db.select().from(systemSettings).where(eq(systemSettings.key, key)).get();
  return row?.value ?? null;
}

export function setSystemSetting(key: string, value: string): void {
  const db = getDb();
  db.insert(systemSettings)
    .values({
      key,
      value,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
}

export interface BackupSettings {
  enabled: boolean;
  destination: string;
  cron: string;
}

const BACKUP_SETTINGS_DEFAULTS: BackupSettings = {
  enabled: false,
  destination: '/Volumes/CLOUD/deploy-backup',
  cron: '0 */6 * * *',
};

export function getBackupSettings(): BackupSettings {
  const raw = getSystemSetting('backup_settings');
  if (!raw) return { ...BACKUP_SETTINGS_DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled:
        typeof parsed.enabled === 'boolean' ? parsed.enabled : BACKUP_SETTINGS_DEFAULTS.enabled,
      destination:
        typeof parsed.destination === 'string'
          ? parsed.destination
          : BACKUP_SETTINGS_DEFAULTS.destination,
      cron: typeof parsed.cron === 'string' ? parsed.cron : BACKUP_SETTINGS_DEFAULTS.cron,
    };
  } catch {
    return { ...BACKUP_SETTINGS_DEFAULTS };
  }
}

export function saveBackupSettings(settings: BackupSettings): void {
  setSystemSetting('backup_settings', JSON.stringify(settings));
}
