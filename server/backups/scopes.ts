import type { BackupScope } from '../contracts/backup-provider.ts';

export const applicationScope: BackupScope = {
  boundary: 'application',
  databases: [],
  files: [],
  volumes: 'application-format',
  excluded: [
    'backup.policy=exclude',
    'deploy.db',
    'requests.db',
    'workspace/**',
    'secrets/**',
    'identities/**',
    'certs/**',
  ],
};
export const legacyApplicationScope: BackupScope = {
  ...applicationScope,
  volumes: 'legacy-data-uploads',
  excluded: applicationScope.excluded.filter((rule) => rule !== 'backup.policy=exclude'),
  files: [
    { path: 'data', selection: 'tree' },
    { path: 'uploads', selection: 'tree' },
  ],
};
export const directoryScope: BackupScope = {
  boundary: 'data-directory',
  databases: ['deploy.db', 'requests.db', 'workspace/workspace.db'].map((path) => ({
    path,
    tables: 'all',
    storedAs: `${path}.snapshot`,
  })),
  files: [{ path: '.', selection: 'tree' }],
  volumes: 'in-tree-only',
  excluded: [
    '.deploy-backup-destination',
    '.deploy-backup-complete',
    ...['deploy.db', 'requests.db', 'workspace/workspace.db'].flatMap((file) => [
      file,
      `${file}-wal`,
      `${file}-shm`,
      `${file}.snapshot.tmp`,
    ]),
    'edge.sock',
    'supervisor.sock',
    'coordinator-updates/switch.sock',
    'packages/cache/',
    'packages/tmp/',
  ],
};
export const homeScope: BackupScope = {
  boundary: 'home',
  databases: ['deploy.db', 'requests.db', 'workspace/workspace.db'].map((path) => ({
    path,
    tables: 'all',
    storedAs: path,
  })),
  files: [
    { path: 'workspace', selection: 'referenced-checkpoint-blobs' },
    { path: 'blobs/sha256', selection: 'revision-artifacts' },
    { path: 'ssh_host_ed25519_key', selection: 'file', condition: 'if-present' },
    ...['identities', 'secrets', 'certs', 'certificates', 'project-releases/journals'].map(
      (path) => ({ path, selection: 'tree' as const, condition: 'if-present' as const }),
    ),
    { path: 'packages/hosted', selection: 'tree', condition: 'hosted-package-budget' },
  ],
  volumes: 'none',
  excluded: [
    '**/*.tmp',
    'workspace/repositories/**',
    'workspace/tasks/**',
    'workspace/attachments/**',
    'workspace/screenshots/**',
    'volumes/**',
    'unreferenced-blobs',
    'packages/cache',
    'packages/tmp',
  ],
};
export const workspaceScope: BackupScope = {
  boundary: 'workspace',
  databases: [{ path: 'workspace.db', tables: 'all', storedAs: 'workspace.db' }],
  files: [{ path: '.', selection: 'tree' }],
  volumes: 'none',
  excluded: ['workspace.db-wal', 'workspace.db-shm', 'workspace-recovery.json'],
};
export const selfUpdateScope: BackupScope = {
  boundary: 'databases',
  databases: [
    { path: 'deploy.db', tables: 'all', storedAs: 'self-update-<sha7>-deploy.db' },
    { path: 'workspace/workspace.db', tables: 'all', storedAs: 'self-update-<sha7>-workspace.db' },
  ],
  files: [],
  volumes: 'none',
  excluded: ['requests.db'],
};

export const remoteReleaseScope: BackupScope = {
  ...applicationScope,
  volumes: 'in-tree-only',
  excluded: applicationScope.excluded.filter((rule) => rule !== 'backup.policy=exclude'),
  files: [{ path: '.', selection: 'tree' }],
};
