import { posix } from 'node:path';
import { db as workspace } from '../workspace/store.ts';
import { gitText } from '../workspace/repository-git.ts';
import { db, packageByName } from './store.ts';
/** Only evidence for the current PR head is shown. A bumped version alone is not a promise. */
export async function mergingPackages(owner: string, project: any, pull: any) {
  if (!pull || pull.status !== 'open' || project.owner !== owner) return [];
  const head = await gitText(project.repositoryPath, [
    'rev-parse',
    `refs/heads/${pull.sourceBranch}`,
  ]);
  const row = workspace
    .prepare(
      "SELECT data FROM records WHERE kind='pipeline-run' AND owner=? AND json_extract(data,'$.pullId')=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(owner, pull.id) as any;
  if (!row) return [];
  const run = JSON.parse(row.data);
  if (
    run.commit !== head ||
    run.status !== 'succeeded' ||
    run.packages?.status !== 'succeeded' ||
    !run.packages.checkOnly ||
    run.stopRequested
  )
    return [];
  const spec = run.specification;
  if (
    !spec.on.includes('push') ||
    !(spec.branches.length ? spec.branches : [project.defaultBranch || 'main']).includes(
      pull.targetBranch,
    )
  )
    return [];
  if (spec.paths) {
    const base = await gitText(project.repositoryPath, [
      'merge-base',
      `refs/heads/${pull.targetBranch}`,
      head,
    ]);
    const changed = await gitText(
      project.repositoryPath,
      ['diff', '--name-only', '--no-renames', '-z', base, head, '--'],
      { limit: 65536 },
    );
    if (
      !changed
        .split('\0')
        .some(
          (file) => file && spec.paths.some((pattern: string) => posix.matchesGlob(file, pattern)),
        )
    )
      return [];
  }
  // Re-read only checked versions: a concurrent publication invalidates the promise immediately.
  return run.packages.items
    .filter((item: any) => {
      if (item.status !== 'checked') return false;
      const pkg = packageByName(item.name);
      return (
        !pkg ||
        (pkg.project_id === project.id &&
          !db()
            .prepare('SELECT 1 FROM package_versions WHERE package_id=? AND version=?')
            .get(pkg.id, item.version))
      );
    })
    .map((item: any) => ({
      name: item.name,
      version: item.version,
      previousVersion: item.previousVersion,
    }));
}
