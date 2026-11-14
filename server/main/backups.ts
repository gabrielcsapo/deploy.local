import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BackupCatalog } from '../backups/catalog.ts';
import { registerBackupAccess } from '../backups/port.ts';
import {
  createApplicationProvider,
  createHomeProvider,
  createDirectoryProvider,
  createOfflineWorkspaceProvider,
  createSelfUpdateProvider,
  latestVerifiedHomeBundle,
} from '../backups/providers.ts';
import { backupSchedules } from '../backups/schedules.ts';
import { newestOutcome, selfUpdateHistory } from '../backups/history.ts';
import { legacyApplicationScope, remoteReleaseScope } from '../backups/scopes.ts';
import type {
  BackupHolding,
  BackupInventorySource,
  BackupOutcome,
} from '../contracts/backup-provider.ts';
import { deployDataDirectory } from '../kernel/files/data-directory.ts';
import { getAllDeployments, getBackupSettings, getSqlite } from '../store.ts';
import { getArtifact } from '../content-store.ts';
import { maintenance, readBackupStatus } from '../maintenance.ts';
import { db } from '../workspace/store.ts';

const latest = (values: (string | null | undefined)[], evidence: string): BackupOutcome | null => {
  const at = values
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  return at ? { at, evidence } : null;
};

export function wireBackupCatalog(
  options: { workspaceSnapshots?: readonly string[]; selfUpdateStateDirectory?: string } = {},
) {
  const application = createApplicationProvider();
  const home = createHomeProvider();
  const directory = createDirectoryProvider(maintenance.runBackup);
  const workspace = createOfflineWorkspaceProvider();
  const selfUpdate = createSelfUpdateProvider();
  const applicationHoldings = async (): Promise<BackupHolding[]> => {
    const holdings: BackupHolding[] = [];
    const seen = new Set<string>();
    const add = (
      name: string,
      backup: { filename: string; createdAt?: string; timestamp?: string; volumePaths?: string[] },
    ) => {
      const id = `${name}/${backup.filename}`;
      if (seen.has(id)) return;
      seen.add(id);
      const graph = backup.filename.endsWith('.graph');
      holdings.push({
        id,
        createdAt: backup.createdAt ?? backup.timestamp ?? null,
        location: join(deployDataDirectory(), 'backups', name, backup.filename),
        scope: graph
          ? {
              ...application.scope,
              volumes: 'graph-backup-policy',
              files: (backup.volumePaths ?? []).map((path) => ({ path, selection: 'tree' })),
            }
          : legacyApplicationScope,
        capture: 'recorded',
        verification: 'unverified',
      });
    };
    for (const app of getAllDeployments())
      for (const backup of application.list.run(app.name)) add(app.name, backup);
    // Pre-release captures live in release receipts rather than the backups table.
    const releases = db.prepare("SELECT data FROM records WHERE kind = 'v2-release'").all() as {
      data: string;
    }[];
    for (const row of releases) {
      const release = JSON.parse(row.data);
      if (!Array.isArray(release.backup?.runtime)) continue;
      for (const entry of release.backup.runtime)
        if (entry.name && entry.backup?.filename) add(entry.name, entry.backup);
        else if (entry.name && entry.nodeId && entry.backupId)
          holdings.push({
            id: `${entry.nodeId}/${entry.backupId}`,
            createdAt: release.backup.capturedAt ?? null,
            location: null,
            scope: remoteReleaseScope,
            capture: 'recorded',
            verification: 'unverified',
          });
    }
    // Catalog points use the same graph executor but live outside backups/<app>.
    const catalogPoints = getSqlite()!
      .prepare(
        'SELECT id, artifact_reference, created_at, status FROM catalog_recovery_points WHERE artifact_reference IS NOT NULL',
      )
      .all() as { id: string; artifact_reference: string; created_at: string; status: string }[];
    for (const point of catalogPoints)
      holdings.push({
        id: `catalog:${point.id}`,
        createdAt: point.created_at,
        location: point.artifact_reference,
        scope: null,
        capture: 'recorded',
        verification: point.status === 'verified' ? 'verified' : 'unverified',
      });
    // Profile logical archives cover one component's database, not all app volumes.
    const logicalArchives = getSqlite()!
      .prepare(
        "SELECT id, artifact_path, completed_at, verification FROM component_profile_operations WHERE artifact_path IS NOT NULL AND json_extract(evidence, '$.workflow') = 'logical-backup'",
      )
      .all() as {
      id: string;
      artifact_path: string;
      completed_at: number | null;
      verification: string | null;
    }[];
    for (const archive of logicalArchives)
      holdings.push({
        id: `profile:${archive.id}`,
        createdAt:
          archive.completed_at === null ? null : new Date(archive.completed_at).toISOString(),
        location: archive.artifact_path,
        scope: null,
        capture: 'recorded',
        verification: archive.verification ? 'verified' : 'unverified',
      });
    // Include unregistered archives without inserting metadata or creating directories.
    const root = join(deployDataDirectory(), 'backups');
    if (existsSync(root))
      for (const app of readdirSync(root, { withFileTypes: true })) {
        if (!app.isDirectory()) continue;
        for (const archive of readdirSync(join(root, app.name), { withFileTypes: true })) {
          if (!archive.name.endsWith('.tar.gz') && !archive.name.endsWith('.graph')) continue;
          const id = `${app.name}/${archive.name}`;
          if (seen.has(id)) continue;
          holdings.push({
            id,
            createdAt: null,
            location: join(root, id),
            scope: null,
            capture: 'unknown',
            verification: 'unverified',
          });
        }
      }
    return holdings;
  };
  const sources: BackupInventorySource[] = [
    {
      id: application.id,
      scope: application.scope,
      inventory: applicationHoldings,
      history: async () => {
        const jobs = getSqlite()!
          .prepare(
            "SELECT status, completed_at, error FROM agent_jobs WHERE type = 'backup' AND status IN ('complete', 'failed')",
          )
          .all() as { status: string; completed_at: number | null; error: string | null }[];
        const outcomes = (status: string): BackupOutcome[] =>
          jobs
            .filter((job) => job.status === status)
            .map((job) => ({
              at: job.completed_at === null ? null : new Date(job.completed_at).toISOString(),
              evidence: 'execution-agent backup job',
              ...(job.error ? { error: job.error } : {}),
            }));
        const profileFailures = getSqlite()!
          .prepare(
            "SELECT id, completed_at, output FROM component_profile_operations WHERE status = 'failed' AND json_extract(evidence, '$.workflow') IN ('logical-backup', 'logical-major-upgrade')",
          )
          .all() as { id: string; completed_at: number | null; output: string | null }[];
        const catalogFailures = getSqlite()!
          .prepare(
            "SELECT id, verification FROM catalog_recovery_points WHERE status = 'failed' ORDER BY created_at DESC",
          )
          .all() as { id: string; verification: string | null }[];
        const recorded = latest(
          (await applicationHoldings()).map((row) => row.createdAt),
          'backup rows / pre-release receipts; archive availability not implied',
        );
        return {
          lastSucceeded: newestOutcome([...outcomes('complete'), ...(recorded ? [recorded] : [])]),
          lastFailed: newestOutcome([
            ...outcomes('failed'),
            ...profileFailures.map((row) => ({
              at: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
              evidence: `component profile operation ${row.id}`,
              error: row.output ?? undefined,
            })),
            ...catalogFailures.map((row) => ({
              at: null,
              evidence: `Catalog recovery point ${row.id}; failure time was not recorded`,
              error: row.verification ?? undefined,
            })),
          ]),
          unknown: [
            'Ordinary local capture failures are only in caller errors/logs; no complete attempt history',
            'Catalog failed-point records have no failure timestamp, so their chronology against other failures is unknown',
            'Remote release receipts may retain only a remote backup reference',
            'Tar metadata records data/uploads only; optional agent graph coverage requires archive inspection',
            'Catalog graph and profile logical archives retain their own scope/provenance checks; no scope is inferred from their filenames',
          ],
        };
      },
    },
    {
      id: directory.id,
      scope: directory.scope,
      inventory: async () => {
        const destination = getBackupSettings().destination;
        if (!destination) return [];
        return (await directory.list.run(destination)).map((copy) => ({
          id: copy.name,
          createdAt: copy.startedAt.toISOString(),
          location: copy.path,
          scope: directory.scope,
          capture: copy.complete ? 'complete' : 'incomplete',
          verification: 'unsupported',
        }));
      },
      history: async () => {
        const status = readBackupStatus();
        const destination = getBackupSettings().destination;
        const successes: string[] = [];
        const unknown = [
          'Earlier failed attempts are not persisted; incomplete copies have no failure timestamp',
        ];
        try {
          if (destination)
            for (const copy of await directory.list.run(destination)) {
              if (copy.complete)
                successes.push(
                  JSON.parse(readFileSync(join(copy.path, '.deploy-backup-complete'), 'utf8'))
                    .finishedAt,
                );
            }
        } catch (error) {
          unknown.push(`Completion history unavailable: ${String(error)}`);
        }
        return {
          lastSucceeded: latest(
            [...successes, status.lastSuccess ? status.lastRunAt : null],
            'dated completion markers / current process status; app failures may have been tolerated',
          ),
          lastFailed:
            status.lastSuccess === false
              ? {
                  at: status.lastRunAt,
                  evidence: 'current maintenance process status',
                  error: status.lastError ?? undefined,
                }
              : null,
          unknown,
        };
      },
    },
    {
      id: home.id,
      scope: home.scope,
      inventory: async () =>
        home.list.run().map((row) => {
          const metadata = JSON.parse(row.encryption_metadata);
          return {
            id: row.id,
            createdAt: row.created_at,
            location: metadata.scheduledPath || getArtifact(row.artifact_digest)?.localPath || null,
            scope:
              row.format_version === 2
                ? {
                    ...home.scope,
                    files: home.scope.files.filter(
                      (file) =>
                        file.condition !== 'hosted-package-budget' ||
                        metadata.receipt?.hostedPackages?.included === true,
                    ),
                  }
                : null,
            capture: 'recorded',
            verification: row.verification_status === 'verified' ? 'verified' : 'unverified',
          };
        }),
      history: async () => {
        const rows = home.list.run();
        return {
          lastSucceeded: latest(
            rows.map((row) => row.created_at),
            'bundle creation rows; verification and rehearsal are separate',
          ),
          lastFailed: latest(
            rows.filter((row) => row.rehearsal_status === 'failed').map((row) => row.rehearsed_at),
            'failed rehearsal record',
          ),
          unknown: [
            'Creation/verification failures without a row or timestamp are only in caller errors/logs',
            'Old bundles may predate workspace inclusion; hosted package coverage depends on each receipt',
          ],
        };
      },
    },
    {
      id: workspace.id,
      scope: workspace.scope,
      inventory: async () =>
        Promise.all(
          (options.workspaceSnapshots ?? []).map(async (path) => {
            const manifest = await workspace.verify.run(path);
            return {
              id: path,
              createdAt: manifest.createdAt,
              location: path,
              scope: workspace.scope,
              capture: 'complete',
              verification: 'verified',
            };
          }),
        ),
      history: async () => ({
        lastSucceeded: null,
        lastFailed: null,
        unknown: [
          'Offline snapshots have no registry or attempt history; inventory requires explicit paths',
        ],
      }),
    },
    {
      id: selfUpdate.id,
      scope: selfUpdate.scope,
      inventory: async () => {
        const root = deployDataDirectory();
        if (!existsSync(join(root, 'backups'))) return [];
        return selfUpdate.list.run(root).map((copy) => ({
          id: copy.name,
          createdAt: copy.modifiedAt,
          location: copy.path,
          scope: {
            ...selfUpdate.scope,
            databases: selfUpdate.scope.databases.filter((database) =>
              copy.name.endsWith(database.path === 'deploy.db' ? '-deploy.db' : '-workspace.db'),
            ),
          },
          capture: 'unknown',
          verification: 'unsupported',
        }));
      },
      history: async () => {
        let stateDirectory = options.selfUpdateStateDirectory;
        if (!stateDirectory) {
          const { readReleaseConfig } = await import('../v2/self-update-host.ts');
          const config = readReleaseConfig();
          if (config) stateDirectory = join(dirname(config.current), 'self-update');
        }
        return selfUpdateHistory(stateDirectory);
      },
    },
  ];
  const catalog = new BackupCatalog(sources, () =>
    backupSchedules(getBackupSettings(), process.env),
  );
  registerBackupAccess({
    catalog,
    application,
    home,
    directory,
    latestVerifiedHome: latestVerifiedHomeBundle,
  });
  return catalog;
}
