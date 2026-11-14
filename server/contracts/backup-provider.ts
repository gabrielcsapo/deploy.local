export type BackupProviderId =
  | 'application-data'
  | 'directory-copy'
  | 'home-bundle'
  | 'workspace-offline'
  | 'self-update';

export type BackupScope = {
  boundary: 'application' | 'data-directory' | 'home' | 'workspace' | 'databases';
  databases: readonly { path: string; tables: 'all'; storedAs: string }[];
  files: readonly {
    path: string;
    selection: 'tree' | 'file' | 'referenced-checkpoint-blobs' | 'revision-artifacts';
    condition?: 'if-present' | 'hosted-package-budget';
  }[];
  volumes:
    | 'none'
    | 'legacy-data-uploads'
    | 'graph-backup-policy'
    | 'application-format'
    | 'in-tree-only';
  excluded: readonly string[];
};

export type BackupOperation<Args extends unknown[], Result> =
  | { supported: true; run(...args: Args): Result }
  | { supported: false; reason: string };

export interface BackupProvider<
  C extends unknown[],
  CR,
  L extends unknown[],
  LR,
  V extends unknown[],
  VR,
  R extends unknown[],
  RR,
> {
  id: BackupProviderId;
  scope: BackupScope;
  execution:
    | 'coordinator-local'
    | 'control'
    | 'control-and-recovery-worker'
    | 'offline-command'
    | 'self-update-process';
  capture: BackupOperation<C, CR>;
  list: BackupOperation<L, LR>;
  verify: BackupOperation<V, VR>;
  restore: BackupOperation<R, RR>;
}

export interface BackupHolding {
  id: string;
  createdAt: string | null;
  location: string | null;
  scope: BackupScope | null;
  capture: 'recorded' | 'complete' | 'incomplete' | 'unknown';
  verification: 'verified' | 'unverified' | 'unsupported';
}

export interface BackupOutcome {
  at: string | null;
  evidence: string;
  error?: string;
}

export interface BackupSchedule {
  provider: BackupProviderId;
  owner: string;
  trigger:
    | 'cron'
    | 'before-directory-copy'
    | 'manual-offline'
    | 'before-self-update'
    | 'manual-or-release';
  enabled: boolean;
  cron?: string;
  initialCheckMs?: number;
  maxAgeDays?: number;
  retention: string | number;
}

export interface BackupInventorySource {
  id: BackupProviderId;
  scope: BackupScope;
  inventory(): Promise<BackupHolding[]>;
  history(): Promise<{
    lastSucceeded: BackupOutcome | null;
    lastFailed: BackupOutcome | null;
    unknown: readonly string[];
  }>;
}
