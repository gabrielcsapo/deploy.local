import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Entry = {
  path: string;
  mode: number;
  type: 'file' | 'directory' | 'symlink';
  bytes?: number;
  sha256?: string;
  target?: string;
};
type Manifest = {
  format: 'deploy.local/workspace-recovery/v1';
  source: string;
  createdAt: string;
  entries: Entry[];
};
const manifestName = 'workspace-recovery.json';
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
async function canonicalDestination(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalDestination(parent), relative(parent, absolute));
  }
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function inventory(root: string, skipDatabase = false): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function walk(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        key = relative(root, path);
      if (
        key === manifestName ||
        (skipDatabase && ['workspace.db', 'workspace.db-wal', 'workspace.db-shm'].includes(key))
      )
        continue;
      const info = await lstat(path),
        mode = info.mode & 0o777;
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target))
          throw new Error(`Absolute symlink requires separate migration: ${key}`);
        if (!inside(root, resolve(dirname(path), target)))
          throw new Error(`External symlink is outside the recovery boundary: ${key}`);
        try {
          if (!inside(root, await realpath(path)))
            throw new Error(`Symlink chain leaves the recovery boundary: ${key}`);
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
        entries.push({ path: key, mode, type: 'symlink', target });
      } else if (info.isDirectory()) {
        entries.push({ path: key, mode, type: 'directory' });
        await walk(path);
      } else if (info.isFile()) {
        entries.push({
          path: key,
          mode,
          type: 'file',
          bytes: info.size,
          sha256: await digest(path),
        });
      } else throw new Error(`Unsupported recovery file: ${key}`);
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function databaseEvidence(root: string) {
  const result: Record<string, string> = {};
  for (const name of ['workspace.db', 'workspace.db-wal']) {
    try {
      result[name] = await digest(join(root, name));
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return JSON.stringify(result);
}
function validateIdle(database: Database.Database) {
  for (const row of database.prepare('SELECT kind, data FROM records').all() as {
    kind: string;
    data: string;
  }[]) {
    const value = JSON.parse(row.data);
    if (
      ['run', 'check', 'job', 'repository-operation', 'pipeline-run'].includes(row.kind) &&
      ['queued', 'waiting', 'preparing', 'starting', 'running', 'cancelling', 'unknown'].includes(
        value.status,
      )
    )
      throw new Error(`Resolve pending ${row.kind} ${value.id} before offline recovery`);
    if (
      row.kind === 'pipeline-run' &&
      value.deployment &&
      !['succeeded', 'failed', 'cancelled'].includes(value.deployment.status)
    )
      throw new Error('Resolve pending deployment before offline recovery');
  }
  for (const row of database.prepare('SELECT pid FROM worker').all() as { pid: number | null }[]) {
    if (!row.pid) continue;
    try {
      process.kill(row.pid, 0);
    } catch (error: any) {
      if (error.code === 'ESRCH') continue;
      throw error;
    }
    throw new Error('Stop workspace workers before offline recovery');
  }
}
async function copyEntries(source: string, target: string, entries: Entry[]) {
  for (const entry of entries) {
    const path = join(target, entry.path);
    if (entry.type === 'directory') await mkdir(path, { recursive: true, mode: entry.mode });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (entry.type === 'symlink') await symlink(entry.target!, path);
      else {
        await copyFile(join(source, entry.path), path);
        await chmod(path, entry.mode);
      }
    }
  }
}
async function flushTree(root: string) {
  const entries = await inventory(root);
  for (const path of [
    ...entries.filter((e) => e.type === 'file').map((e) => join(root, e.path)),
    join(root, manifestName),
  ]) {
    let file;
    try {
      file = await open(path, 'r');
      await file.sync();
    } catch (error: any) {
      if (path !== join(root, manifestName) || error.code !== 'ENOENT') throw error;
    } finally {
      await file?.close();
    }
  }
  for (const path of [
    ...entries
      .filter((e) => e.type === 'directory')
      .map((e) => join(root, e.path))
      .reverse(),
    root,
  ]) {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
async function publish(stage: string, destination: string) {
  await flushTree(stage);
  await rename(stage, destination);
  const parent = await open(dirname(destination), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
async function newStage(destination: string) {
  try {
    await lstat(destination);
    throw new Error('Recovery destination must not exist');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  return mkdtemp(join(dirname(destination), '.workspace-recovery-'));
}
export async function snapshotWorkspace(sourcePath: string, destinationPath: string) {
  const source = await realpath(sourcePath),
    destination = await canonicalDestination(destinationPath);
  if (inside(source, destination)) throw new Error('Backup must be outside the workspace');
  try {
    await lstat(join(source, manifestName));
    throw new Error('Reserved recovery manifest exists in workspace');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await newStage(destination);
  let database: Database.Database | undefined;
  try {
    database = new Database(join(source, 'workspace.db'), { readonly: true, fileMustExist: true });
    validateIdle(database);
    const beforeDatabase = await databaseEvidence(source);
    const before = await inventory(source, true);
    await database.backup(join(stage, 'workspace.db'));
    const snapshotDb = new Database(join(stage, 'workspace.db'));
    try {
      snapshotDb.pragma('journal_mode = DELETE');
    } finally {
      snapshotDb.close();
    }
    await chmod(join(stage, 'workspace.db'), 0o600);
    await copyEntries(source, stage, before);
    if (JSON.stringify(before) !== JSON.stringify(await inventory(stage, true)))
      throw new Error('Copied workspace differs from the source inventory');
    if (
      JSON.stringify(before) !== JSON.stringify(await inventory(source, true)) ||
      beforeDatabase !== (await databaseEvidence(source))
    )
      throw new Error(
        'Workspace changed during backup; stop the coordinator and workers, then retry',
      );
    const manifest: Manifest = {
      format: 'deploy.local/workspace-recovery/v1',
      source,
      createdAt: new Date().toISOString(),
      entries: await inventory(stage),
    };
    await writeFile(join(stage, manifestName), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await verifyWorkspaceSnapshot(stage);
    await publish(stage, destination);
    return { path: destination, files: manifest.entries.length, createdAt: manifest.createdAt };
  } finally {
    database?.close();
    await rm(stage, { recursive: true, force: true });
  }
}
export async function verifyWorkspaceSnapshot(snapshotPath: string): Promise<Manifest> {
  const snapshot = await realpath(snapshotPath);
  const manifest = JSON.parse(await readFile(join(snapshot, manifestName), 'utf8')) as Manifest;
  if (
    manifest.format !== 'deploy.local/workspace-recovery/v1' ||
    !isAbsolute(manifest.source) ||
    !Array.isArray(manifest.entries)
  )
    throw new Error('Invalid workspace recovery manifest');
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !entry.path ||
      isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') ||
      paths.has(entry.path)
    )
      throw new Error('Invalid recovery entry path');
    paths.add(entry.path);
    if (
      entry.type === 'symlink' &&
      (!entry.target ||
        !inside(manifest.source, resolve(manifest.source, dirname(entry.path), entry.target)))
    )
      throw new Error('External recovery symlink');
  }
  const actual = await inventory(snapshot);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.entries))
    throw new Error('Workspace recovery content verification failed');
  const database = new Database(join(snapshot, 'workspace.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error('Workspace database integrity check failed');
  } finally {
    database.close();
  }
  return manifest;
}
export async function restoreWorkspace(snapshotPath: string, destinationPath: string) {
  const snapshot = await realpath(snapshotPath),
    destination = await canonicalDestination(destinationPath);
  const manifest = await verifyWorkspaceSnapshot(snapshot);
  if (destination !== manifest.source)
    throw new Error(
      'Restore requires the original workspace path; relocating worktrees is a separate migration',
    );
  const stage = await newStage(destination);
  try {
    await copyEntries(snapshot, stage, manifest.entries);
    if (JSON.stringify(await inventory(stage)) !== JSON.stringify(manifest.entries))
      throw new Error('Restored workspace verification failed');
    const database = new Database(join(stage, 'workspace.db'));
    try {
      database.exec(
        "DELETE FROM worker; DELETE FROM records WHERE kind IN ('worker','worker-inventory','worker-credential')",
      );
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      database.close();
    }
    await publish(stage, destination);
    return { path: destination, workersRequireEnrollment: true };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, destination] = process.argv.slice(2);
  try {
    if (command === 'verify' && source && !destination)
      console.log(
        JSON.stringify({
          verified: true,
          files: (await verifyWorkspaceSnapshot(source)).entries.length,
        }),
      );
    else if (command === 'snapshot' && source && destination)
      console.log(JSON.stringify(await snapshotWorkspace(source, destination)));
    else if (command === 'restore' && source && destination)
      console.log(JSON.stringify(await restoreWorkspace(source, destination)));
    else
      throw new Error(
        'Usage: node server/workspace/recovery.ts snapshot|restore <source> <destination> OR verify <snapshot>',
      );
  } catch (error: any) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
