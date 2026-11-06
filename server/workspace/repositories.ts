import { sshServerInfo } from './ssh-host.ts';
import { isAbsolute, resolve } from 'node:path';
import { db, root, id, now, get, save, event, list } from './store.ts';
import { gitText, repositoryGit } from './repository-git.ts';
import { compileDeployYaml } from '../application-spec.ts';
import {
  projectAtAddress,
  packageRepositoryAddresses,
  repositoryAddress,
  repositoryFolderName,
  reservedRepositoryAddress,
  sameRepositoryAddress,
  uniqueRepositoryAddress,
} from '../../shared/repository-address.ts';

const hasControls = (text: string) => [...text].some((character) => character.charCodeAt(0) < 32);
export function repositorySource(input: unknown) {
  if (input == null || input === '')
    return { kind: 'hosted', location: null, authority: 'deploy.local', syncPolicy: 'none' };
  if (typeof input !== 'string' || input.length > 2048 || hasControls(input))
    throw new Error('Invalid repository source');
  const source = input.trim();
  if (isAbsolute(source))
    return {
      kind: 'local',
      location: resolve(source),
      authority: 'deploy.local',
      syncPolicy: 'manual-fetch',
    };
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(source))
    return {
      kind: 'remote',
      location: source,
      authority: 'deploy.local',
      syncPolicy: 'manual-fetch',
    };
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Use an absolute server path or an HTTP(S)/SSH Git remote');
  }
  if (
    !['https:', 'http:', 'ssh:'].includes(url.protocol) ||
    url.password ||
    (url.protocol !== 'ssh:' && url.username) ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTP(S)/SSH remote without embedded credentials, query parameters or fragments',
    );
  return {
    kind: 'remote',
    location: source,
    authority: 'deploy.local',
    syncPolicy: 'manual-fetch',
  };
}
/**
 * A source given now. Remotes sync both ways; folders, and remotes from before two-way sync
 * (stored as `manual-fetch`), only fetch, so they never push.
 */
function newSource(input: unknown) {
  const source = repositorySource(input);
  return source.kind === 'remote' ? { ...source, syncPolicy: 'both-ways' } : source;
}
export const syncsBothWays = (project: any) => project.source?.syncPolicy === 'both-ways';
const SYNC_INTERVAL = 5 * 60 * 1000;
/** Queue a sync (both ways) or a fetch (fetch only) as the repository's current operation. */
function queueSync(owner: string, project: any) {
  const operation = save('repository-operation', owner, {
    id: id(),
    projectId: project.id,
    kind: syncsBothWays(project) ? 'sync' : 'fetch',
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
  });
  save('project', owner, {
    ...project,
    repositoryOperationId: operation.id,
    updatedAt: now(),
  });
  return operation;
}
const busy = (owner: string, project: any) => {
  const current = project.repositoryOperationId
    ? get('repository-operation', owner, project.repositoryOperationId)
    : null;
  return !!current && ['queued', 'running'].includes(current.status);
};
/** Give a repository that lives only on deploy.local a remote, and sync with it. */
export function addProjectRemote(owner: string, projectId: string, input: any) {
  const project = requireRepository(owner, projectId);
  if (project.sourcePath)
    throw Object.assign(new Error('This repository already has a remote'), {
      status: 409,
    });
  if (busy(owner, project))
    throw Object.assign(new Error('Repository already has an active operation'), { status: 409 });
  const source = newSource(input.sourcePath);
  if (!source.location) throw new Error('Remote required');
  const updated = save('project', owner, {
    ...project,
    sourcePath: source.location,
    source,
    sync: null,
    updatedAt: now(),
  });
  queueSync(owner, updated);
  event(owner, '', null, 'project.updated', { projectId });
  return get('project', owner, projectId);
}
/** Ask for a sync soon, as after a merge to main. */
export function requestSync(owner: string, projectId: string) {
  const project = get('project', owner, projectId);
  if (syncsBothWays(project))
    save('project', owner, {
      ...project,
      syncRequestedAt: now(),
      updatedAt: now(),
    });
}
/**
 * Queue a sync for each two-way repository that is free and due: every five minutes, and soon
 * after a merge asks for one. Fetch-only repositories sync only when someone asks.
 */
export function queueDueSyncs(at = Date.now()) {
  for (const row of db
    .prepare("SELECT owner,data FROM records WHERE kind='project'")
    .all() as any[]) {
    const project = JSON.parse(row.data);
    if (!syncsBothWays(project) || project.repositoryStatus !== 'ready') continue;
    if (busy(row.owner, project)) continue;
    const last = Date.parse(project.sync?.at || '') || 0;
    const requested = Date.parse(project.syncRequestedAt || '') || 0;
    if (at - last >= SYNC_INTERVAL || requested > last) queueSync(row.owner, project);
  }
}
export function queueProject(owner: string, input: any) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) throw new Error('Project name required');
  if (hasControls(name)) throw new Error('Repository name cannot contain control characters');
  const existing = list('project', owner).find(
    (project) => project.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) throw new Error(`Repository "${existing.name}" already exists`);
  assertRepositoryAddress(owner, name);
  const description = input.description == null ? '' : input.description;
  if (typeof description !== 'string' || description.length > 240 || hasControls(description))
    throw new Error('Description must contain at most 240 characters without control characters');
  const source = newSource(input.sourcePath);
  const projectId = id(),
    operationId = id();
  const project = save('project', owner, {
    id: projectId,
    owner,
    name,
    description: description.trim(),
    sourcePath: source.location,
    source,
    repositoryPath: resolve(root, 'repositories', `${projectId}.git`),
    repositoryStatus: 'preparing',
    repositoryOperationId: operationId,
    createdAt: now(),
  });
  save('repository-operation', owner, {
    id: operationId,
    projectId,
    kind: 'prepare',
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
  });
  return project;
}
/** Update display metadata only; Git identity, source and operational state are preserved. */
export function updateProjectSettings(owner: string, projectId: string, input: any) {
  const project = get('project', owner, projectId);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : null;
  if (!name || name.length > 120 || hasControls(name))
    throw new Error('Repository name must contain 1–120 characters without control characters');
  if (description === null || description.length > 240 || hasControls(description))
    throw new Error('Description must contain at most 240 characters without control characters');
  if (!Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 0)
    throw new Error('A valid settings revision is required');
  if (input.settingsRevision !== (project.settingsRevision || 0))
    throw Object.assign(
      new Error('Repository settings changed. Reload the saved values and try again.'),
      { status: 409 },
    );
  if (name !== project.name) assertRepositoryAddress(owner, name, projectId);
  const previous =
    repositoryAddress(project.name) ||
    (packageRepositoryAddresses.has(repositoryFolderName(project.name).toLowerCase())
      ? repositoryFolderName(project.name)
      : null);
  const renamed = previous && !sameRepositoryAddress(name, previous);
  const updated = save('project', owner, {
    ...project,
    name,
    description,
    // Old short addresses keep working for links and remotes made before the rename.
    ...(renamed && {
      previousAddresses: [
        ...new Set([...(project.previousAddresses ?? []), previous.toLowerCase()]),
      ],
    }),
    settingsRevision: input.settingsRevision + 1,
    updatedAt: now(),
  });
  event(owner, '', null, 'project.updated', { projectId });
  return addressedProjects(owner).find((project) => project.id === projectId) ?? updated;
}
/**
 * Standing permission for agents in this project to use the headless task browser without asking
 * each time. Desktop (window) control always asks.
 */
export function updateProjectControlPolicy(owner: string, projectId: string, input: any) {
  const project = get('project', owner, projectId);
  if (typeof input.autoApproveTaskBrowser !== 'boolean')
    throw new Error('autoApproveTaskBrowser must be true or false');
  const updated = save('project', owner, {
    ...project,
    autoApproveTaskBrowser: input.autoApproveTaskBrowser,
    updatedAt: now(),
  });
  event(owner, '', null, 'project.updated', { projectId });
  return updated;
}
export function requireRepository(owner: string, projectId: string) {
  const project = get('project', owner, projectId);
  if (project.repositoryStatus && project.repositoryStatus !== 'ready')
    throw Object.assign(new Error('Repository is not ready; inspect its setup operation'), {
      status: 409,
    });
  return project;
}
export function repositoryCommand(owner: string, projectId: string, action: string) {
  const project = get('project', owner, projectId);
  const current = project.repositoryOperationId
    ? get('repository-operation', owner, project.repositoryOperationId)
    : null;
  if (action === 'cancel') {
    if (!current || !['queued', 'running'].includes(current.status))
      throw Object.assign(new Error('No active repository operation'), { status: 409 });
    const operation = save('repository-operation', owner, {
      ...current,
      cancelRequested: true,
      updatedAt: now(),
      ...(current.status === 'queued' ? { status: 'cancelled', completedAt: now() } : {}),
    });
    if (current.status === 'queued' && current.kind === 'prepare')
      save('project', owner, { ...project, repositoryStatus: 'failed', updatedAt: now() });
    return operation;
  }
  if (current && ['queued', 'running'].includes(current.status))
    throw Object.assign(new Error('Repository already has an active operation'), { status: 409 });
  if (
    action === 'retry' &&
    (!current || !['failed', 'cancelled', 'unknown'].includes(current.status))
  )
    throw Object.assign(new Error('No failed repository operation to retry'), { status: 409 });
  if (current?.gitPid) {
    try {
      process.kill(current.gitPid, 0);
      throw Object.assign(
        new Error('Previous Git process is still alive; resolve it before retrying'),
        { status: 409 },
      );
    } catch (error: any) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  if (action === 'fetch') {
    requireRepository(owner, projectId);
    if (!project.sourcePath) throw new Error('This hosted repository has no upstream source');
  }
  const kind = action === 'retry' ? current.kind : syncsBothWays(project) ? 'sync' : 'fetch';
  // Validate legacy sources before handing them to a Git subprocess.
  repositorySource(project.sourcePath);
  const operation = save('repository-operation', owner, {
    id: id(),
    projectId,
    kind,
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
  });
  save('project', owner, {
    ...project,
    repositoryOperationId: operation.id,
    repositoryStatus: kind === 'prepare' ? 'preparing' : 'ready',
  });
  return operation;
}
export function repositoryOperation(owner: string, projectId: string) {
  const project = get('project', owner, projectId);
  return project.repositoryOperationId
    ? get('repository-operation', owner, project.repositoryOperationId)
    : null;
}
/** Every repository gets its own `deploy.local/<repo>` that no page or other repository uses. */
function assertRepositoryAddress(owner: string, name: string, projectId?: string) {
  const address = repositoryFolderName(name);
  if (reservedRepositoryAddress(address))
    throw new Error(`"${name}" is reserved for a deploy.local page; choose another name`);
  const sharing = list('project', owner).find(
    (project) => project.id !== projectId && sameRepositoryAddress(project.name, address),
  );
  if (sharing) throw new Error(`Repository "${sharing.name}" already uses deploy.local/${address}`);
}
/** Repositories with the short address each one owns (`address: null` when it has none). */
export function addressedProjects(owner: string) {
  const projects = list('project', owner);
  return projects.map((project) => ({
    ...project,
    address: uniqueRepositoryAddress(projects, project),
  }));
}
/** The repository a short address (`deploy.local/<repo>`) names, or null. */
export function repositoryAtAddress(owner: string, segment: string) {
  return projectAtAddress(list('project', owner), segment);
}
/** Selects a repository by id, or by short address for `deploy.local/<repo>.git` clones. */
export function findRepository(owner: string, idOrAddress: string) {
  try {
    return requireRepository(owner, idOrAddress);
  } catch (error: any) {
    const legacy = packageRepositoryAddresses.has(idOrAddress.toLowerCase())
      ? list('project', owner).filter(
          (project) =>
            repositoryFolderName(project.name).toLowerCase() === idOrAddress.toLowerCase(),
        )
      : [];
    const project =
      error?.status === 404 &&
      (repositoryAtAddress(owner, idOrAddress) || (legacy.length === 1 ? legacy[0] : null));
    if (!project) throw error;
    return requireRepository(owner, project.id);
  }
}
/** `https://deploy.local/<repo>` for the repository's page, or its id route without one. */
export function repositoryWebURL(owner: string, project: { id: string; name: string }) {
  const address = uniqueRepositoryAddress(list('project', owner), project);
  return `https://deploy.local/${address ?? `dashboard/repositories/${project.id}`}`;
}
/** `deploy.local/<repo>.git` when the name has a unique short address, else the id route. */
export function repositoryClonePath(owner: string, project: { id: string; name: string }) {
  const address = uniqueRepositoryAddress(list('project', owner), project);
  return address
    ? `/${address}.git`
    : `/api/workspace/git/${project.id}/${repositoryFolderName(project.name)}.git`;
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const applicationCache = new Map<
  string,
  { path: string; refs: string; application: Promise<string | null> }
>();
/** Link seeding needs only the manifest on main, not clone URLs, HEAD, or worker metadata. */
export async function repositoryApplication(owner: string, projectId: string) {
  const project = get('project', owner, projectId);
  if ((project.repositoryStatus || 'ready') !== 'ready') return null;
  // Let Git resolve loose/packed refs and worktrees; main is the deployment branch,
  // even when HEAD or the project's defaultBranch points elsewhere.
  const refs = await gitText(project.repositoryPath, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)',
    'refs/heads/main',
  ]);
  const key = JSON.stringify([owner, projectId]);
  const cached = applicationCache.get(key);
  if (cached && cached.path === project.repositoryPath && cached.refs === refs)
    return cached.application;
  const entry = {
    path: project.repositoryPath,
    refs,
    application: repositoryDeployment(project.repositoryPath, refs).then((deployment) => {
      // A failed Git read can be transient; don't retain it until the next commit.
      if (deployment.error && applicationCache.get(key) === entry) applicationCache.delete(key);
      return deployment.application || null;
    }),
  };
  applicationCache.set(key, entry);
  try {
    return await entry.application;
  } catch (error) {
    if (applicationCache.get(key) === entry) applicationCache.delete(key);
    throw error;
  }
}
export async function repositoryInfo(owner: string, projectId: string) {
  const project = get('project', owner, projectId);
  const service = db.prepare('SELECT heartbeat FROM worker WHERE id=?').get('repositories') as any;
  const base = {
    projectId,
    status: project.repositoryStatus || 'ready',
    source: project.source || repositorySource(project.sourcePath),
    // Ends in the repository name so `git clone` names the folder after it, not the id.
    clonePath: repositoryClonePath(owner, project),
    sshClonePath: `/${uniqueRepositoryAddress(list('project', owner), project) || project.id}.git`,
    sshPort: sshServerInfo().port,
    operation: repositoryOperation(owner, projectId),
    serviceOnline: !!service && Date.now() - Date.parse(service.heartbeat) < 10000,
  };
  if (base.status !== 'ready') return base;
  const [head, tree, refs] = await Promise.all([
    gitText(project.repositoryPath, ['rev-parse', '--verify', 'HEAD']),
    gitText(project.repositoryPath, ['rev-parse', '--verify', 'HEAD^{tree}']),
    gitText(project.repositoryPath, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      'refs/heads',
      'refs/tags',
      'refs/remotes/upstream',
    ]),
  ]);
  return {
    ...base,
    head,
    // A new hosted repository starts with one empty commit; it is empty until code arrives.
    empty: tree === EMPTY_TREE,
    sync: project.sync ?? null,
    deployment: await repositoryDeployment(project.repositoryPath, refs),
    defaultBranch:
      project.defaultBranch ||
      (await gitText(project.repositoryPath, ['symbolic-ref', '--short', 'HEAD'])),
    refs: refs
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, oid] = line.split('\0');
        return { name, oid };
      }),
  };
}

// Capabilities follow the committed main branch, not a worker checkout, HEAD,
// an upstream tracking branch, or a proposed configuration in a pull request.
export async function repositoryDeployment(
  repositoryPath: string,
  refs: string,
): Promise<{
  configured: boolean;
  branch: string;
  commit?: string;
  path?: string;
  pipeline?: boolean;
  application?: string | null;
  error?: string;
}> {
  const main = refs
    .split('\n')
    .find((line) => line.startsWith('refs/heads/main\0'))
    ?.split('\0')[1];
  if (!main) return { configured: false, branch: 'main' };
  const entry = await gitText(repositoryPath, ['ls-tree', main, '--', 'deploy.yaml']);
  if (!/^100(?:644|755) blob /.test(entry))
    return { configured: false, branch: 'main', commit: main };
  const base = { configured: true, branch: 'main', commit: main, path: 'deploy.yaml' };
  try {
    const manifest = await gitText(repositoryPath, ['show', `${main}:deploy.yaml`], {
      limit: 256 * 1024,
    });
    const { spec } = compileDeployYaml(manifest);
    return {
      ...base,
      pipeline: !!spec.pipeline,
      application: spec.pipeline?.deploy?.application || spec.metadata?.name || null,
    };
  } catch {
    // Keep configuration repair reachable; an invalid manifest is not an absent one.
    return {
      ...base,
      pipeline: false,
      error: 'Fix deploy.yaml on main to enable deployment actions.',
    };
  }
}
export function sourcePath(value: string) {
  if (
    value.length > 2048 ||
    value.startsWith('/') ||
    value.split('/').some((p) => p === '..' || p === '.') ||
    hasControls(value)
  )
    throw new Error('Invalid repository path');
  return value.replace(/\/$/, '');
}
export async function resolveCommit(repositoryPath: string, ref: string) {
  if (!ref || ref.length > 250 || ref.startsWith('-') || hasControls(ref) || ref.includes(' '))
    throw new Error('Invalid Git revision');
  return gitText(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}
async function latestCommit(repo: string, commit: string, path: string) {
  const raw = await gitText(repo, [
    'log',
    '-1',
    '--format=%H%x00%an%x00%cI%x00%s',
    commit,
    '--',
    ...(path ? [path] : []),
  ]);
  if (!raw) return null;
  const [oid, author, date, subject] = raw.split('\0');
  return { oid, author, date, subject };
}
const treeMetadataCache = new Map<string, unknown>();
export async function repositoryRead(
  owner: string,
  projectId: string,
  action: string,
  params: URLSearchParams,
) {
  const project = requireRepository(owner, projectId),
    repo = project.repositoryPath;
  const commit = await resolveCommit(repo, params.get('ref') || 'HEAD');
  const path = sourcePath(params.get('path') || '');
  if (action === 'files') {
    const raw = await repositoryGit(repo, ['ls-tree', '-r', '-z', '--name-only', commit], {
      limit: 4 * 1024 * 1024,
    });
    const paths = raw.toString().split('\0').filter(Boolean);
    return { commit, paths: paths.slice(0, 10000), truncated: paths.length > 10000 };
  }
  if (action === 'entry') {
    if (!path) return { commit, path, type: 'tree' };
    const type = await gitText(repo, ['cat-file', '-t', `${commit}:${path}`]);
    if (!['tree', 'blob'].includes(type)) throw new Error('Unsupported repository entry');
    return { commit, path, type };
  }
  if (action === 'tree') {
    const cacheKey = `${repo}\0${commit}\0${path}`;
    const cached = treeMetadataCache.get(cacheKey);
    if (cached) return cached;
    const raw = await repositoryGit(repo, [
      'ls-tree',
      '-l',
      '-z',
      path ? `${commit}:${path}` : commit,
    ]);
    const entries = raw
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [mode, type, oid, bytes] = line.slice(0, tab).trim().split(/\s+/);
        const name = line.slice(tab + 1);
        return {
          mode,
          type,
          oid,
          name,
          path: [path, name].filter(Boolean).join('/'),
          size: type === 'blob' ? Number(bytes) : null,
          lastCommit: null as null | { revision: string; date: string; subject: string },
        };
      });
    // Very large directories retain their full listing; optional history is bounded.
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (cursor < Math.min(entries.length, 200)) {
          const entry = entries[cursor++];
          const history = await gitText(repo, [
            'log',
            '-1',
            '--format=%H%x00%cI%x00%s',
            commit,
            '--',
            entry.path,
          ]);
          if (history) {
            const [revision, date, ...subject] = history.split('\0');
            entry.lastCommit = { revision, date, subject: subject.join('\0') };
          }
        }
      }),
    );
    const [latest, count] = await Promise.all([
      latestCommit(repo, commit, path),
      gitText(repo, ['rev-list', '--count', commit, '--', ...(path ? [path] : [])]),
    ]);
    entries.sort(
      (a, b) =>
        Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name),
    );
    const result = { commit, path, entries, latestCommit: latest, commitCount: Number(count) };
    if (treeMetadataCache.size >= 100)
      treeMetadataCache.delete(treeMetadataCache.keys().next().value!);
    treeMetadataCache.set(cacheKey, result);
    return result;
  }
  if (action === 'blob') {
    if (!path) throw new Error('File path required');
    const object = `${commit}:${path}`;
    if ((await gitText(repo, ['cat-file', '-t', object])) !== 'blob')
      throw new Error('Path is not a file');
    const size = Number(await gitText(repo, ['cat-file', '-s', object]));
    const latest = await latestCommit(repo, commit, path);
    if (size > repositoryPreviewLimit)
      return {
        commit,
        path,
        size,
        latestCommit: latest,
        omitted: 'File exceeds 256 KiB preview limit',
      };
    const content = await repositoryGit(repo, ['cat-file', 'blob', object], {
      limit: repositoryPreviewLimit,
    });
    return { commit, path, size, latestCommit: latest, ...filePreview(content) };
  }
  if (action === 'history') {
    const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 30));
    const raw = await gitText(repo, [
      'log',
      `--max-count=${Math.floor(limit)}`,
      '--format=%H%x00%P%x00%an%x00%aI%x00%s',
      commit,
      '--',
      ...(path ? [path] : []),
    ]);
    return {
      commit,
      commits: raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [oid, parents, author, date, subject] = line.split('\0');
          return { oid, parents: parents.split(' ').filter(Boolean), author, date, subject };
        }),
    };
  }
  if (action === 'diff') {
    const base = params.get('base') ? await resolveCommit(repo, params.get('base')!) : null;
    const patch = await gitText(repo, [
      ...(base
        ? ['diff', '--no-ext-diff', '--no-textconv', base, commit]
        : ['show', '--root', '--format=', '--no-ext-diff', '--no-textconv', commit]),
      '--',
      ...(path ? [path] : []),
    ]);
    return { base, commit, patch };
  }
  throw Object.assign(new Error('Not found'), { status: 404 });
}

export const repositoryPreviewLimit = 256 * 1024;
export function filePreview(content: Buffer) {
  const mimeType = content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : content[0] === 255 && content[1] === 216 && content[2] === 255
      ? 'image/jpeg'
      : /^GIF8[79]a/.test(content.subarray(0, 6).toString())
        ? 'image/gif'
        : content.subarray(0, 4).toString() === 'RIFF' &&
            content.subarray(8, 12).toString() === 'WEBP'
          ? 'image/webp'
          : null;
  if (mimeType)
    return {
      omitted: 'Binary image',
      image: { mimeType, data: content.toString('base64') },
    };
  if (content.includes(0) || !content.equals(Buffer.from(content.toString('utf8'))))
    return { omitted: 'Binary file' };
  return { content: content.toString('utf8') };
}
