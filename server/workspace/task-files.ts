import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { get, list } from './store.ts';
import { managedWorkerRoot } from './managed-worker.ts';
import { repositoryGit } from './repository-git.ts';
import { filePreview, repositoryPreviewLimit, sourcePath } from './repositories.ts';

// Workspace reads stay on this machine: the local and managed workers' workspaces are readable here.
// The managed worker keeps a task's files under its own root, not the coordinator's workspacePath.
let managedWorkspaceDirectory = (workerId: string, taskId: string) =>
  resolve(managedWorkerRoot(workerId), 'tasks', taskId);
/** Tests point managed workspaces at a temporary directory. */
export function useManagedWorkspaceDirectory(resolver: typeof managedWorkspaceDirectory) {
  managedWorkspaceDirectory = resolver;
}
export async function taskFiles(
  owner: string,
  taskId: string,
  content: boolean,
  params: URLSearchParams,
) {
  const task = get('task', owner, taskId);
  const path = sourcePath(params.get('path') || '');
  if (path.split('/').includes('.git')) throw new Error('Invalid workspace path');
  // The account's managed worker runs on this machine, so its workspaces are readable here;
  // other computers only upload review records.
  const managed = list('managed-worker', owner).some((worker) => worker.id === task.workerId);
  const onThisMachine = !task.workerId || task.workerId === 'local' || managed;
  if (!onThisMachine) {
    let computer = task.workerId;
    try {
      computer = get('worker', owner, task.workerId).name || computer;
    } catch {
      /* Keep the recorded identity. */
    }
    return { path, entries: [], omitted: `Files are on ${computer}; open Changes to review them` };
  }
  const workspace = managed
    ? managedWorkspaceDirectory(task.workerId, task.id)
    : task.workspacePath;
  if (!workspace || (task.workspaceStatus && task.workspaceStatus !== 'ready'))
    return { path, entries: [], omitted: `Workspace ${task.workspaceStatus || 'unavailable'}` };
  let root: string;
  try {
    root = await realpath(workspace);
  } catch {
    return { path, entries: [], omitted: 'This task’s workspace is no longer on this computer' };
  }
  const target = resolve(root, path);
  // Refuse symlinks, including intermediate directories, rather than following them out of the workspace.
  let current = root;
  for (const part of path.split('/').filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Workspace symlinks cannot be previewed');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Invalid workspace path');
  const changes = new Map<string, string>();
  const raw = (
    await repositoryGit(root, [
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      task.baseRevision,
      '--',
    ])
  )
    .toString()
    .split('\0');
  for (let i = 0; i + 1 < raw.length; i += 2)
    changes.set(raw[i + 1], raw[i] === 'A' ? 'Added' : raw[i] === 'D' ? 'Deleted' : 'Modified');
  const untracked = await repositoryGit(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const name of untracked.toString().split('\0').filter(Boolean)) changes.set(name, 'Added');
  if (content) {
    if (!path) throw new Error('File path required');
    if (changes.get(path) === 'Deleted')
      return { path, omitted: 'Deleted in this task', change: 'Deleted' };
    if (!(await lstat(target)).isFile()) throw new Error('Path is not a file');
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Path is not a file');
      if (stat.size > repositoryPreviewLimit)
        return {
          path,
          size: stat.size,
          change: changes.get(path),
          omitted: 'File exceeds 256 KiB preview limit',
        };
      // Bound the read even if the agent grows the file between stat and read.
      const buffer = Buffer.alloc(repositoryPreviewLimit + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return {
        path,
        size: bytesRead,
        change: changes.get(path),
        ...(bytesRead > repositoryPreviewLimit
          ? { omitted: 'File exceeds 256 KiB preview limit' }
          : filePreview(buffer.subarray(0, bytesRead))),
      };
    } finally {
      await handle.close();
    }
  }
  const entries = new Map<
    string,
    { name: string; path: string; type: string; size: number | null; change?: string }
  >();
  const directory = await readdir(target, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT' && [...changes.keys()].some((name) => name.startsWith(path + '/')))
      return [];
    throw error;
  });
  for (const entry of directory) {
    if (entry.name === '.git') continue;
    const name = [path, entry.name].filter(Boolean).join('/');
    entries.set(name, {
      name: entry.name,
      path: name,
      type: entry.isDirectory() ? 'tree' : 'blob',
      size: entry.isFile() ? (await lstat(resolve(root, name))).size : null,
      change: changes.get(name),
    });
  }
  // Keep deleted paths discoverable, including a deleted directory's children.
  for (const [name, change] of changes) {
    const prefix = path ? path + '/' : '';
    if (!name.startsWith(prefix)) continue;
    const child = name.slice(prefix.length).split('/')[0];
    const childPath = prefix + child;
    if (!entries.has(childPath))
      entries.set(childPath, {
        name: child,
        path: childPath,
        type: childPath === name ? 'blob' : 'tree',
        size: null,
        change,
      });
  }
  return {
    path,
    entries: [...entries.values()].sort(
      (a, b) =>
        Number(b.type === 'tree') - Number(a.type === 'tree') || a.name.localeCompare(b.name),
    ),
  };
}
