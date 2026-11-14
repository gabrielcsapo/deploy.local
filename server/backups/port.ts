import type { BackupCatalog } from './catalog.ts';
import type {
  createApplicationProvider,
  createHomeProvider,
  createDirectoryProvider,
  latestVerifiedHomeBundle,
} from './providers.ts';

export interface BackupAccess {
  catalog: BackupCatalog;
  application: ReturnType<typeof createApplicationProvider>;
  home: ReturnType<typeof createHomeProvider>;
  directory: ReturnType<typeof createDirectoryProvider>;
  latestVerifiedHome: typeof latestVerifiedHomeBundle;
}

let access: BackupAccess | undefined;
export function registerBackupAccess(provider: BackupAccess) {
  access = provider;
}
export function requireBackupAccess(processName: string): BackupAccess {
  if (!access) throw new Error(`BackupAccess is not wired in ${processName}`);
  return access;
}
