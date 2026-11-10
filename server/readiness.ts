import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { workerBuild } from './workspace/worker-build.ts';

type Check = 'ok' | string;
type Options = {
  deploy: Database.Database;
  workspace: Database.Database;
  root?: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
};

/** Capture identity and the migration journal once, from this process's release directory. */
export function createReadiness({
  deploy,
  workspace,
  root = process.cwd(),
  env = process.env,
  clock = Date.now,
}: Options) {
  root = realpathSync(root);
  const startedVersion = env.DEPLOY_COORDINATOR_VERSION || '';
  const startedRelease = env.DEPLOY_COORDINATOR_RELEASE || '';
  const releasePath = join(root, '.deploy-release.json');
  const coordinatorPath = join(root, 'coordinator-build.json');
  const identity = () => ({
    revision: existsSync(releasePath) ? JSON.parse(readFileSync(releasePath, 'utf8')).revision : '',
    coordinator: existsSync(coordinatorPath)
      ? JSON.parse(readFileSync(coordinatorPath, 'utf8')).version
      : '',
  });
  let started: { revision: string; coordinator: string } | undefined;
  try {
    started = identity();
  } catch {
    /* Unreadable identity fails closed below. */
  }
  const version = startedVersion || started?.revision || startedRelease || workerBuild.version;
  let expected: { created_at: number; hash: string }[] | undefined;
  try {
    const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
    expected = journal.entries.map((entry: { when: number; tag: string }) => ({
      created_at: entry.when,
      hash: createHash('sha256')
        .update(readFileSync(join(root, 'drizzle', `${entry.tag}.sql`)))
        .digest('hex'),
    }));
  } catch {
    /* A missing journal must never make an unmigrated release ready. */
  }
  let integrity: { at: number; deploy: Check; workspace: Check } | undefined;
  const quickCheck = (database: Database.Database): Check => {
    try {
      const rows = database.pragma('quick_check') as { quick_check: string }[];
      return rows.length === 1 && rows[0].quick_check === 'ok' ? 'ok' : 'integrity check failed';
    } catch {
      return 'integrity check unavailable';
    }
  };
  return () => {
    const now = clock();
    if (!integrity || now - integrity.at >= 60000) {
      integrity = { at: now, deploy: quickCheck(deploy), workspace: quickCheck(workspace) };
    }
    const checks: Record<string, Check> = {
      migrations: 'migration check unavailable',
      deploy: integrity.deploy,
      workspace: integrity.workspace,
      pipelines: 'worker heartbeat missing',
      repositories: 'worker heartbeat missing',
      version: 'release identity changed',
    };
    try {
      const applied = deploy.prepare('SELECT created_at, hash FROM __drizzle_migrations').all() as {
        created_at: number;
        hash: string;
      }[];
      if (expected)
        checks.migrations = expected.every((entry) =>
          applied.some(
            (row) => Number(row.created_at) === entry.created_at && row.hash === entry.hash,
          ),
        )
          ? 'ok'
          : 'migrations pending or changed';
    } catch {
      /* Static reasons only: no SQL, paths or secrets in public responses. */
    }
    try {
      const rows = workspace
        .prepare("SELECT id, heartbeat FROM worker WHERE id IN ('pipelines', 'repositories')")
        .all() as { id: string; heartbeat: string }[];
      for (const row of rows) {
        const age = now - Date.parse(row.heartbeat);
        checks[row.id] =
          Number.isFinite(age) && age >= 0 && age < 30000 ? 'ok' : 'worker heartbeat stale';
      }
    } catch {
      checks.pipelines = checks.repositories = 'worker heartbeat unavailable';
    }
    try {
      const current = identity();
      if (
        started &&
        current.revision === started.revision &&
        current.coordinator === started.coordinator &&
        (env.DEPLOY_COORDINATOR_VERSION || '') === startedVersion &&
        (env.DEPLOY_COORDINATOR_RELEASE || '') === startedRelease &&
        (!started.coordinator || !startedVersion || started.coordinator === startedVersion)
      )
        checks.version = 'ok';
    } catch {
      /* Failed reads also fail readiness. */
    }
    return { ok: Object.values(checks).every((value) => value === 'ok'), version, checks };
  };
}
