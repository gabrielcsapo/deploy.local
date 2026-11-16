import { cargoRegistry } from './cargo.ts';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldThread, setTimeout as pause } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { db, now, objectPath, packageByName } from './store.ts';
import { NpmCopy, entry, writeCopy } from './cache.ts';
import { usageCache } from './project-index.ts';
import { repositoryGit } from '../workspace/repository-git.ts';
import { workerComputerId } from '../workspace/computer-role-policy.ts';
import { db as workspaceDb, list, save, remove } from '../workspace/store.ts';

export function enrolledPlatforms() {
  const pairs = [{ os: process.platform as string, cpu: process.arch as string }];
  for (const row of workspaceDb
    .prepare("SELECT data FROM records WHERE kind='worker'")
    .all() as any[]) {
    const worker = JSON.parse(row.data);
    if (!worker.revokedAt && worker.platform && (worker.arch || worker.architecture))
      pairs.push({ os: worker.platform, cpu: worker.arch || worker.architecture });
  }
  for (const node of db()
    .prepare('SELECT platform,architecture FROM nodes WHERE revoked_at IS NULL')
    .all() as any[]) {
    if (node.platform && node.architecture)
      pairs.push({ os: node.platform.toLowerCase(), cpu: node.architecture });
  }
  return pairs;
}
export function matchesPlatforms(
  fields: { os?: string[]; cpu?: string[] },
  platforms = enrolledPlatforms(),
) {
  const accepts = (rules: string[] | undefined, value: string) =>
    !rules?.length ||
    (!rules.includes('!' + value) &&
      (!rules.some((r) => !r.startsWith('!')) || rules.includes(value) || rules.includes('any')));
  return platforms.some(({ os, cpu }) => accepts(fields.os, os) && accepts(fields.cpu, cpu));
}
export function queueCopies(owner: string, projectId: string) {
  save('package-warm', owner, { id: projectId, queuedAt: now(), requestId: randomUUID() });
}
export function queueAllCopies() {
  for (const { owner, id } of workspaceDb
    .prepare("SELECT owner,id FROM records WHERE kind='project'")
    .all() as any[])
    queueCopies(owner, id);
}
export type Needed = { name: string; version: string; removedAt?: string; missing?: boolean };
/** Only small, already-indexed records are read by the UI. Repository IO is background work. */
export function copiesStatus(owner: string, copy: NpmCopy) {
  const projects = list('project', owner).map((project) => {
    const row = db()
      .prepare('SELECT checked_at FROM package_project_copies WHERE username=? AND project_id=?')
      .get(owner, project.id) as any;
    // Main's normalized index plus retained release snapshots. Version keys have a
    // final @version; scoped package document pins have only their leading @.
    const requirements = `WITH needed AS (
      SELECT key FROM package_project_requirements WHERE username=? AND project_id=?
      UNION SELECT key FROM package_pins WHERE project_id=?
        AND reason IN ('release','release-installed','self-release')
        AND instr(substr(key,2),'@')>0
    ) `;
    const counts = db()
      .prepare(`${requirements}SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN e.key IS NULL THEN 1 ELSE 0 END),0) missing
      FROM needed r LEFT JOIN package_cache_entries e ON e.ecosystem='npm' AND e.kind='file' AND e.key=r.key`)
      .get(owner, project.id, project.id) as any;
    const removed = db()
      .prepare(
        `${requirements}SELECT r.key,e.removed_at AS removedAt FROM needed r JOIN package_cache_entries e ON e.ecosystem='npm' AND e.kind='file' AND e.key=r.key WHERE e.removed_at IS NOT NULL ORDER BY e.removed_at DESC LIMIT 10`,
      )
      .all(owner, project.id, project.id)
      .map((row: any) => ({
        name: row.key.slice(0, row.key.lastIndexOf('@')),
        version: row.key.slice(row.key.lastIndexOf('@') + 1),
        removedAt: row.removedAt,
      }));
    return {
      id: project.id,
      name: project.name,
      ...counts,
      removed,
      checkedAt: row?.checked_at || null,
    };
  });
  return {
    sources: [
      {
        name: 'npmjs.org',
        reachable: copy.reachable,
        checkedAt: copy.checkedAt,
        downSince: copy.downSince,
        copiesServed: copy.copiesServed,
      },
      {
        name: 'crates.io',
        reachable: cargoRegistry.copy.reachable,
        checkedAt: cargoRegistry.copy.checkedAt,
        downSince: cargoRegistry.copy.downSince,
        copiesServed: cargoRegistry.copy.copiesServed,
      },
    ],
    projects,
    storage: storageStatus(),
  };
}
export function storageStatus() {
  const setting = (key: string, fallback: number) => {
    const row = db().prepare('SELECT value FROM system_settings WHERE key=?').get(key) as any;
    const value = Number(row?.value);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const sum = (pinned: boolean) =>
    (
      db()
        .prepare(`SELECT COALESCE(SUM(size),0) n FROM (
    SELECT area,hash,MAX(size) size FROM (
      SELECT CASE WHEN kind='file' THEN 'file' ELSE 'doc' END area,sha256 hash,size FROM package_cache_entries e ${pinned ? 'WHERE EXISTS(SELECT 1 FROM package_pins p WHERE p.ecosystem=e.ecosystem AND p.key=e.key)' : ''}
      UNION ALL SELECT 'doc',abbreviated_sha256,abbreviated_size FROM package_cache_entries e WHERE abbreviated_sha256 IS NOT NULL ${pinned ? 'AND EXISTS(SELECT 1 FROM package_pins p WHERE p.ecosystem=e.ecosystem AND p.key=e.key)' : ''}
      UNION ALL SELECT 'doc',index_sha256,index_size FROM package_cache_entries e WHERE index_sha256 IS NOT NULL ${pinned ? 'AND EXISTS(SELECT 1 FROM package_pins p WHERE p.ecosystem=e.ecosystem AND p.key=e.key)' : ''}
    ) GROUP BY area,hash)
  `)
        .get() as any
    ).n;
  const bytes = sum(false),
    pinned = sum(true);
  const limit = setting('packages.cache.limitBytes', 20 * 1024 ** 3);
  return {
    bytes,
    pinned,
    limit,
    days: setting('packages.cache.days', 90),
    pressure: bytes > limit * 0.9,
    pinnedOverLimit: pinned > limit,
  };
}
export async function cleanupCopies(clock = Date.now()) {
  for (const row of db()
    .prepare("SELECT DISTINCT release_id FROM package_pins WHERE reason='job'")
    .all() as { release_id: string }[]) {
    const job = workspaceDb
      .prepare(
        "SELECT json_extract(data,'$.status') AS status FROM records WHERE kind='job' AND id=?",
      )
      .get(row.release_id) as any;
    if (!job || ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status))
      finishJobPins(row.release_id);
    await yieldThread();
  }

  const initial = storageStatus();
  const cutoff = new Date(clock - initial.days * 86400000).toISOString();
  let bytes = initial.bytes;
  const candidates = db()
    .prepare('SELECT * FROM package_cache_entries WHERE size>0 ORDER BY last_used_at')
    .all() as any[];
  for (const row of candidates) {
    if (Date.parse(row.last_used_at) > clock - 60000) continue;
    if (row.last_used_at >= cutoff && bytes <= initial.limit * 0.9) break;
    await writeCopy(async () => {
      // Recheck use and pins under a write transaction, and serialize file opening/promotion.
      const changed = db()
        .transaction(() => {
          const eligible = db()
            .prepare(
              `SELECT 1 FROM package_cache_entries e WHERE ecosystem=? AND kind=? AND key=? AND last_used_at=? AND NOT EXISTS(SELECT 1 FROM package_pins p WHERE p.ecosystem=e.ecosystem AND p.key=e.key)`,
            )
            .get(row.ecosystem, row.kind, row.key, row.last_used_at);
          if (!eligible) return false;
          if (row.removed_at)
            db()
              .prepare(
                'UPDATE package_cache_entries SET size=0 WHERE ecosystem=? AND kind=? AND key=?',
              )
              .run(row.ecosystem, row.kind, row.key);
          else
            db()
              .prepare('DELETE FROM package_cache_entries WHERE ecosystem=? AND kind=? AND key=?')
              .run(row.ecosystem, row.kind, row.key);
          return true;
        })
        .immediate();
      if (!changed) return;
      const files =
        row.kind === 'file'
          ? [[row.sha256, row.size]]
          : [
              [row.sha256, row.size],
              [row.abbreviated_sha256, row.abbreviated_size],
              [row.index_sha256, row.index_size],
            ];
      for (const [hash, size] of files) {
        if (!hash) continue;
        const referenced =
          row.kind === 'file'
            ? db()
                .prepare(
                  "SELECT 1 FROM package_cache_entries WHERE kind='file' AND sha256=? AND size>0",
                )
                .get(hash)
            : db()
                .prepare(
                  "SELECT 1 FROM package_cache_entries WHERE kind='doc' AND (sha256=? OR abbreviated_sha256=? OR index_sha256=?) AND size>0",
                )
                .get(hash, hash, hash);
        if (!referenced) {
          await rm(objectPath(row.kind === 'file' ? 'cache' : 'docs', hash), { force: true });
          bytes -= size || 0;
        }
      }
    });
    await yieldThread();
  }
}
export class CopyWarmer {
  private busy = false;
  private nextAttempt = 0;
  readonly copy: NpmCopy;
  constructor(copy: NpmCopy) {
    this.copy = copy;
  }
  async scan(
    owner: string,
    project: any,
    commit?: string,
    releaseId = '',
    reason = 'main',
    warm = true,
  ) {
    if (!project.repositoryPath) return true;
    if (!commit) {
      try {
        commit = (
          await repositoryGit(project.repositoryPath, ['rev-parse', `refs/heads/${project.defaultBranch || 'main'}`], {
            limit: 1024,
            timeout: 5000,
          })
        )
          .toString()
          .trim();
      } catch {
        return true;
      } // A project without its default branch must not block the rest of the queue.
    }
    const needed = new Map<string, Needed>();
    const platforms = enrolledPlatforms();
    for (const file of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']) {
      const index = await usageCache.read(project.repositoryPath, commit, file);
      for (const [name, value] of Object.entries(index)) {
        for (const version of value.versions) {
          while (warm && this.copy.activeRequests && !this.copy.failures) await pause(25);
          const known = value.platforms?.[version];
          if (known && !matchesPlatforms(known, platforms)) continue;
          if (packageByName(name)) continue;
          // Old lockfiles omit platform fields. Read the small prepared metadata index.
          let fields = known;
          if (warm && !this.copy.failures) {
            try {
              const document = await this.copy.document(name);
              if (!fields)
                fields = document ? (await this.copy.index(document, version))[version] : undefined;
            } catch {
              /* Record the missing package even while the source is down. */
            }
          }
          if (fields && !matchesPlatforms(fields, platforms)) continue;
          needed.set(name + '@' + version, { name, version });
        }
        await yieldThread();
      }
    }
    // Replace pins and the normalized index in small batches. Add the new snapshot first;
    // the old pins survive until all of it is present, so collection cannot race a scan.
    const keys = [...needed.keys()];
    const pinKeys = new Set([...keys, ...[...needed.values()].map((value) => value.name)]);
    for (let offset = 0; offset < keys.length; offset += 200) {
      db().transaction(() => {
        const pin = db().prepare("INSERT OR IGNORE INTO package_pins VALUES('npm',?,?,?,?)");
        const requirement = db().prepare(
          'INSERT OR IGNORE INTO package_project_requirements VALUES(?,?,?,?,?)',
        );
        for (const key of keys.slice(offset, offset + 200)) {
          pin.run(key, project.id, releaseId, reason);
          const value = needed.get(key)!;
          pin.run(value.name, project.id, releaseId, reason);
          if (reason === 'main') requirement.run(owner, project.id, key, value.name, value.version);
        }
      })();
      await yieldThread();
    }
    const old = db()
      .prepare('SELECT key FROM package_pins WHERE project_id=? AND release_id=? AND reason=?')
      .all(project.id, releaseId, reason) as { key: string }[];
    for (const row of old)
      if (!pinKeys.has(row.key)) {
        db()
          .prepare(
            'DELETE FROM package_pins WHERE key=? AND project_id=? AND release_id=? AND reason=?',
          )
          .run(row.key, project.id, releaseId, reason);
        if (reason === 'main')
          db()
            .prepare(
              'DELETE FROM package_project_requirements WHERE username=? AND project_id=? AND key=?',
            )
            .run(owner, project.id, row.key);
        await yieldThread();
      }
    if (reason === 'main')
      db()
        .prepare(
          'INSERT INTO package_project_copies VALUES(?,?,?,?) ON CONFLICT(username,project_id) DO UPDATE SET commit_id=excluded.commit_id,checked_at=excluded.checked_at',
        )
        .run(owner, project.id, commit, now());
    if (!warm) return true;
    for (const { name, version } of needed.values()) {
      // One background download at a time, yielding to demand. No retries in this pass.
      if (this.copy.failures || this.copy.activeRequests) return false;
      if (entry('file', name + '@' + version)) continue;
      try {
        await this.copy.tarball(name, name.split('/').pop() + '-' + version + '.tgz');
      } catch {
        if (this.copy.failures) return false;
      }
      await yieldThread();
    }
    return true;
  }
  async tick() {
    if (
      this.busy ||
      Date.now() < this.nextAttempt ||
      !this.copy.reachable ||
      this.copy.activeRequests
    )
      return;
    this.busy = true;
    try {
      const rows = workspaceDb
        .prepare("SELECT owner,id,data FROM records WHERE kind='package-warm' LIMIT 1")
        .all() as any[];
      for (const { owner, id, data } of rows) {
        const project = list('project', owner).find((p) => p.id === id);
        if (!project) {
          remove('package-warm', owner, id);
          continue;
        }
        let complete = await this.scan(owner, project);
        const current = list('v2-project-current', owner).find((p) => p.id === id);
        const releases = list('v2-release', owner);
        const live = releases.find((p) => p.id === current?.releaseId);
        const keep = [
          live,
          releases.find((p) => p.id === live?.previousId),
          ...releases.filter((p) => p.release.projectId === id && p.release.state === 'running'),
        ].filter(Boolean);
        for (const record of keep)
          if (record.release.source?.commit)
            complete =
              (await this.scan(
                owner,
                project,
                record.release.source.commit,
                record.id,
                'release',
              )) && complete;
        const pins = db()
          .prepare(
            "SELECT DISTINCT release_id FROM package_pins WHERE project_id=? AND reason IN ('release','release-installed')",
          )
          .all(id) as any[];
        for (const pin of pins)
          if (!keep.some((r) => r.id === pin.release_id))
            db()
              .prepare(
                "DELETE FROM package_pins WHERE project_id=? AND release_id=? AND reason IN ('release','release-installed')",
              )
              .run(id, pin.release_id);
        if (complete && !this.copy.failures)
          workspaceDb
            .prepare(
              "DELETE FROM records WHERE kind='package-warm' AND owner=? AND id=? AND data=?",
            )
            .run(owner, id, data);
        else this.nextAttempt = Date.now() + 60000;
      }
    } catch {
      this.nextAttempt = Date.now() + 60000;
    } finally {
      this.busy = false;
    }
  }
}

/** Installs pin immediately, before responding. Only the active job receives these pins. */
type InstallPin = { projectId: string; releaseId: string; reason: string };
// A big install asks for hundreds of tarballs, and reading every job for each one would stall
// the server. What's running changes far more slowly than that.
const installPinCache = new Map<string, { at: number; pins: InstallPin[] }>();
function computerInstallPins(owner: string, computerId: string): InstallPin[] {
  const cacheKey = JSON.stringify([owner, computerId]);
  const cached = installPinCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5000) return cached.pins;
  // Concurrent builds share a computer's key, so retain the union for each active
  // release. This is conservative; it cannot evict something a live release needs.
  const pins: InstallPin[] = list('v2-release', owner)
    .filter((r) => r.release?.state === 'running')
    .map((r) => ({ projectId: r.release.projectId, releaseId: r.id, reason: 'release-installed' }));
  if (computerId === 'coordinator') {
    const row = db()
      .prepare("SELECT value FROM system_settings WHERE key='packages.selfUpdateContext'")
      .get() as any;
    const context = row ? JSON.parse(row.value) : null;
    if (context?.owner === owner && context.state === 'running')
      pins.push({ projectId: context.projectId, releaseId: context.to, reason: 'self-release' });
  }
  // A queued job has no computer yet.
  for (const job of list('job', owner).filter(
    (j) =>
      j.status === 'running' && j.workerId && workerComputerId(owner, j.workerId) === computerId,
  )) {
    const projectId = job.pipelineId
      ? list('pipeline-run', owner).find((p) => p.id === job.pipelineId)?.projectId
      : list('task', owner).find((t) => t.id === job.taskId)?.projectId;
    if (projectId) pins.push({ projectId, releaseId: job.id, reason: 'job' });
  }
  installPinCache.set(cacheKey, { at: Date.now(), pins });
  return pins;
}
/** Bookkeeping must never fail an install: a missing pin only risks fetching a file again. */
export function pinComputerInstall(owner: string, computerId: string, key: string) {
  try {
    const pin = db().prepare("INSERT OR IGNORE INTO package_pins VALUES('npm',?,?,?,?)");
    const name = key.slice(0, key.lastIndexOf('@'));
    for (const { projectId, releaseId, reason } of computerInstallPins(owner, computerId)) {
      pin.run(key, projectId, releaseId, reason);
      pin.run(name, projectId, releaseId, reason);
    }
  } catch (error: any) {
    console.error('Could not pin a computer install', {
      type: error instanceof TypeError ? 'TypeError' : 'Error',
    });
  }
}
export function finishJobPins(jobId: string) {
  db().prepare("DELETE FROM package_pins WHERE reason='job' AND release_id=?").run(jobId);
}
