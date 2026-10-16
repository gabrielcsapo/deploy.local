import { initializeScratchWorkspace } from './scratch.ts';
import { requireRepository } from './repositories.ts';
// Fast legacy suite fixtures only; production creation uses queueProject.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, id, now, save, get, event } from './store.ts';
import { git, startRun } from './service.ts';
// Synchronous fixture/bootstrap helper. HTTP clients use the durable repository queue.
// Never call this from a coordinator request or its command transaction.
export function createProject(owner: string, input: any) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) throw new Error('Project name required');
  const projectId = id(),
    repositoryPath = resolve(root, 'repositories', `${projectId}.git`);
  mkdirSync(resolve(root, 'repositories'), { recursive: true });
  let sourcePath = input.sourcePath ? String(input.sourcePath) : null;
  if (sourcePath) {
    if (sourcePath.startsWith('-')) throw new Error('Invalid source');
    const r = spawnSync('git', ['clone', '--bare', '--', sourcePath, repositoryPath], {
      encoding: 'utf8',
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error(r.stderr);
  } else {
    mkdirSync(repositoryPath);
    git(repositoryPath, ['init', '--bare', '--initial-branch=main']);
    const seed = resolve(root, 'seeds', projectId);
    mkdirSync(seed, { recursive: true });
    git(seed, ['init', '--initial-branch=main']);
    git(seed, [
      '-c',
      'user.name=deploy.local',
      '-c',
      'user.email=workspace@deploy.local',
      'commit',
      '--allow-empty',
      '-m',
      'Initialize project',
    ]);
    git(seed, ['push', repositoryPath, 'HEAD:main']);
  }
  git(repositoryPath, ['config', 'http.receivepack', 'true']);
  const row = { id: projectId, name, owner, sourcePath, repositoryPath, createdAt: now() };
  save('project', owner, row);
  return row;
}

export function createTask(owner: string, input: any) {
  if (input.workerId && input.workerId !== 'local') get('worker', owner, input.workerId);
  const p = input.projectId ? requireRepository(owner, input.projectId) : null,
    taskId = id(),
    workspacePath = resolve(root, 'tasks', taskId);
  mkdirSync(resolve(root, 'tasks'), { recursive: true });
  if (p) {
    const ref = input.ref ?? 'HEAD';
    if (
      typeof ref !== 'string' ||
      !ref ||
      ref.length > 250 ||
      ref.startsWith('-') ||
      [...ref].some((character) => character.charCodeAt(0) <= 32)
    )
      throw new Error('Invalid Git revision');
    const commit = git(p.repositoryPath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    git(p.repositoryPath, ['worktree', 'add', '-b', `task/${taskId}`, workspacePath, commit]);
  } else initializeScratchWorkspace(workspacePath);
  const row = {
    id: taskId,
    projectId: p?.id ?? null,
    title: String(input.title || 'New task'),
    status: 'ready',
    revision: 0,
    workspacePath,
    workerId: input.workerId || 'local',
    baseRevision: git(workspacePath, ['rev-parse', 'HEAD']),
    createdAt: now(),
    updatedAt: now(),
  };
  save('task', owner, row);
  event(owner, taskId, null, 'task.created', row);
  if (input.prompt) startRun(owner, taskId, { revision: 0, content: input.prompt });
  return get('task', owner, taskId);
}
