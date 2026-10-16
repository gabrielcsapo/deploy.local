// Offline migration rehearsal only. A new, empty destination is mandatory.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const [snapshotInput, destinationInput] = process.argv.slice(2);
if (!snapshotInput || !destinationInput)
  throw new Error(
    'Usage: node --import tsx scripts/workspace/rehearse-groffee.ts SNAPSHOT NEW_DESTINATION',
  );
const snapshot = resolve(snapshotInput),
  destination = resolve(destinationInput);
if (
  existsSync(destination) ||
  destination.startsWith(snapshot + '/') ||
  snapshot.startsWith(destination + '/')
)
  throw new Error('Destination must be new and separate from the snapshot');
const report = JSON.parse(readFileSync(resolve(snapshot, 'snapshot-report.json'), 'utf8'));
const legacy = new Database(resolve(snapshot, 'groffee.sqlite'), {
  readonly: true,
  fileMustExist: true,
});
const rows = (table: string): any[] => legacy.prepare(`SELECT * FROM "${table}"`).all();
const repositories = rows('repositories'),
  issues = rows('issues'),
  pulls = rows('pull_requests'),
  objects = rows('lfs_objects');
if (
  report.repositories.length !== repositories.length ||
  report.lfsObjects !== new Set(objects.map((o) => o.oid)).size
)
  throw new Error('Snapshot lacks verified repositories or LFS objects');
if (report.unmappedPermissionRows || report.numberCollisions)
  throw new Error('Permission or numbering mapping requires review');
mkdirSync(destination, { recursive: true, mode: 0o700 });
process.env.DEPLOY_DATA_DIR = destination;
const { root, save, db } = await import('../../server/workspace/store.ts');
const { gitText } = await import('../../server/workspace/repository-git.ts');
const { lfsPath } = await import('../../server/workspace/repository-lfs.ts');
const users = new Map(rows('users').map((u) => [u.id, u.username]));
const time = (value: number) => new Date(value < 1e12 ? value * 1000 : value).toISOString();
const owners = new Map(repositories.map((r) => [r.id, users.get(r.owner_id)]));
const evidence: any = {
  status: 'running',
  sourceSnapshot: snapshot,
  cutoverReady: false,
  archiveSnapshotComplete: report.status === 'verified',
  projects: 0,
  issues: 0,
  pulls: 0,
  comments: 0,
  lfsObjects: 0,
  exclusions: [
    'account credentials and sessions',
    'active legacy pipeline execution',
    'live service cutover',
  ],
};
try {
  for (const repository of repositories) {
    if (!/^[a-f0-9-]{36}$/.test(repository.id)) throw new Error('Unsupported legacy repository ID');
    const owner = owners.get(repository.id);
    if (!owner) throw new Error('Repository owner mapping missing');
    const repositoryPath = resolve(root, 'repositories', repository.id + '.git');
    mkdirSync(dirname(repositoryPath), { recursive: true, mode: 0o700 });
    cpSync(resolve(snapshot, 'repositories', repository.id + '.git'), repositoryPath, {
      recursive: true,
    });
    const refs = await gitText(repositoryPath, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ]);
    const recorded = report.repositories.find((r: any) => r.id === repository.id);
    if (createHash('sha256').update(refs).digest('hex') !== recorded.refsDigest)
      throw new Error('Copied repository refs differ from snapshot');
    await gitText(repositoryPath, ['config', 'deploy.projectId', repository.id]);
    await gitText(repositoryPath, ['config', 'http.receivepack', 'true']);
    await gitText(repositoryPath, ['config', 'core.hooksPath', '/dev/null']);
    save('project', owner, {
      id: repository.id,
      owner,
      name: repository.name,
      repositoryPath,
      sourcePath: null,
      source: { kind: 'hosted', authority: 'deploy.local', syncPolicy: 'none' },
      repositoryStatus: 'ready',
      defaultBranch: repository.default_branch,
      head: await gitText(repositoryPath, ['rev-parse', 'HEAD']),
      createdAt: time(repository.created_at),
      updatedAt: time(repository.updated_at),
      legacy: {
        system: 'groffee',
        id: repository.id,
        description: repository.description,
        isPublic: repository.is_public,
        isArchived: repository.is_archived,
      },
    });
    evidence.projects++;
  }
  for (const [kind, records] of [
    ['issue', issues],
    ['pull-request', pulls],
  ] as const) {
    for (const row of records) {
      const owner = owners.get(row.repo_id);
      if (!owner || !users.has(row.author_id))
        throw new Error('Collaboration identity mapping missing');
      save(kind, owner, {
        id: row.id,
        projectId: row.repo_id,
        number: row.number,
        title: row.title,
        body: row.body || '',
        author: users.get(row.author_id),
        status: row.status,
        revision: row.revision || 0,
        taskIds: [],
        createdAt: time(row.created_at),
        updatedAt: time(row.updated_at),
        ...(kind === 'pull-request'
          ? {
              sourceBranch: row.source_branch,
              targetBranch: row.target_branch,
              issueIds: [],
              ...(row.merged_at ? { mergedAt: time(row.merged_at) } : {}),
            }
          : {}),
        legacy: { system: 'groffee', record: row },
      });
      evidence[kind === 'issue' ? 'issues' : 'pulls']++;
    }
  }
  for (const row of rows('comments')) {
    const parent = row.issue_id
      ? issues.find((r) => r.id === row.issue_id)
      : pulls.find((r) => r.id === row.pull_request_id);
    if (!parent || !users.has(row.author_id)) throw new Error('Comment reference mapping missing');
    save('project-comment', owners.get(parent.repo_id)!, {
      id: row.id,
      projectId: parent.repo_id,
      parentId: parent.id,
      parentKind: row.issue_id ? 'issue' : 'pull-request',
      author: users.get(row.author_id),
      body: row.body,
      createdAt: time(row.created_at),
      legacy: { system: 'groffee', record: row },
    });
    evidence.comments++;
  }
  for (const object of objects) {
    const path = lfsPath(object.repo_id, object.oid);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    copyFileSync(
      resolve(snapshot, 'lfs-objects', object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid),
      path,
    );
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (hash.digest('hex') !== object.oid || size !== object.size)
      throw new Error('Copied LFS bytes differ from snapshot');
    save('lfs-object', owners.get(object.repo_id)!, {
      id: object.repo_id + ':' + object.oid,
      projectId: object.repo_id,
      oid: object.oid,
      size,
      createdAt: time(object.created_at),
    });
    evidence.lfsObjects++;
  }
  // Preserve non-executable historical context without adopting old pipeline configuration.
  for (const table of [
    'pipelines',
    'pipeline_runs',
    'pipeline_jobs',
    'pipeline_steps',
    'pipeline_artifacts',
    'diff_comments',
    'edit_history',
  ])
    for (const row of rows(table)) save('legacy-groffee-' + table, 'migration-archive', row);
  evidence.status = 'verified-core-import';
} catch (error: any) {
  evidence.status = 'failed';
  evidence.error = error.message;
  throw error;
} finally {
  writeFileSync(resolve(destination, 'migration-report.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  db.close();
  legacy.close();
  console.log(JSON.stringify(evidence));
}
