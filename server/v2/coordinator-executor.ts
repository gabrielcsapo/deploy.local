import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import {
  closeSync,
  fsyncSync,
  openSync,
  chmodSync,
  existsSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, open, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

export type CoordinatorManifest = {
  protocol: 1;
  version: string;
  dataCompatibility: 'unchanged';
  entry: string;
  verify: string;
  files: Record<string, string>;
};
export type CoordinatorReceipt = {
  id: string;
  manifest: CoordinatorManifest;
  digest: string;
  entry: string;
  previous: string;
  previousVersion?: string;
  previousId?: string;
  previousCwd?: string;
  state: 'prepared' | 'verified' | 'starting' | 'activated' | 'aborted';
  error?: string;
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function atomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(`${path}.tmp`, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function validPath(path: string) {
  return (
    /^[a-zA-Z0-9_.@/-]+$/.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}
export function readCoordinatorManifest(source: string) {
  const bytes = readFileSync(join(source, 'coordinator-build.json'));
  const manifest = JSON.parse(bytes.toString()) as CoordinatorManifest;
  if (
    manifest.protocol !== 1 ||
    manifest.dataCompatibility !== 'unchanged' ||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(manifest.version) ||
    !manifest.files ||
    !manifest.files[manifest.entry] ||
    !manifest.files[manifest.verify] ||
    Object.entries(manifest.files).some(
      ([path, hash]) => !validPath(path) || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error('Coordinator build needs a verified bundle with unchanged data compatibility.');
  return { manifest, digest: sha(bytes) };
}

/** Lives in the supervisor, outside the coordinator being replaced. No production data restore. */
export class CoordinatorExecutor {
  root: string;
  receipts: string;
  switchBuild: (entry: string, version?: string, id?: string, cwd?: string) => Promise<void>;
  currentEntry: string;
  currentVersion?: string;
  currentId?: string;
  currentCwd = process.cwd();
  busy = false;
  constructor(input: {
    root: string;
    entry: string;
    switchBuild: CoordinatorExecutor['switchBuild'];
  }) {
    mkdirSync(input.root, { recursive: true, mode: 0o700 });
    this.root = join(realpathSync(input.root), 'coordinator-updates');
    this.receipts = join(this.root, 'receipts');
    mkdirSync(this.receipts, { recursive: true, mode: 0o700 });
    this.currentEntry = input.entry;
    this.switchBuild = input.switchBuild;
    const activePath = join(this.root, 'active.json');
    if (existsSync(activePath)) {
      const active = JSON.parse(readFileSync(activePath, 'utf8'));
      this.currentEntry = active.entry;
      this.currentVersion = active.version;
      this.currentId = active.id;
      this.currentCwd = active.cwd || process.cwd();
      if (active.id) {
        const receipt = this.receipt(active.id);
        if (receipt.state === 'aborted') {
          this.currentId = receipt.previousId;
          this.currentCwd = receipt.previousCwd || process.cwd();
          this.currentEntry = receipt.previous;
          this.currentVersion = receipt.previousVersion;
        }
      }
    }
  }
  receipt(id: string): CoordinatorReceipt {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid coordinator release id');
    return JSON.parse(readFileSync(join(this.receipts, `${id}.json`), 'utf8'));
  }
  persist(receipt: CoordinatorReceipt) {
    atomic(join(this.receipts, `${receipt.id}.json`), receipt);
  }
  async prepare(id: string, source: string, digest: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid coordinator release id');
    if (existsSync(join(this.receipts, `${id}.json`))) {
      const prior = this.receipt(id);
      if (prior.digest !== digest) throw new Error('Coordinator release identity conflict');
      return prior;
    }
    const build = readCoordinatorManifest(source);
    if (build.digest !== digest) throw new Error('Coordinator manifest changed after planning');
    const stage = join(this.root, 'builds', id);
    await rm(stage, { recursive: true, force: true });
    for (const [path, hash] of Object.entries(build.manifest.files)) {
      let component = resolve(source);
      for (const segment of path.split('/')) {
        component = join(component, segment);
        if ((await lstat(component)).isSymbolicLink())
          throw new Error('Coordinator builds cannot contain symlinks');
      }
      const bytes = await readFile(component);
      if (sha(bytes) !== hash) throw new Error(`Coordinator checksum mismatch: ${path}`);
      const destination = join(stage, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, bytes, { mode: 0o600, flush: true });
    }
    const manifestBytes = readFileSync(join(source, 'coordinator-build.json'));
    if (sha(manifestBytes) !== digest)
      throw new Error('Coordinator manifest changed during staging');
    writeFileSync(join(stage, 'coordinator-build.json'), manifestBytes, {
      mode: 0o600,
      flush: true,
    });
    const receipt: CoordinatorReceipt = {
      id,
      manifest: build.manifest,
      digest,
      entry: join(stage, build.manifest.entry),
      previous: this.currentEntry,
      previousVersion: this.currentVersion,
      state: 'prepared',
    };
    this.persist(receipt);
    return receipt;
  }
  async verify(id: string) {
    const receipt = this.receipt(id);
    if (receipt.state !== 'prepared') {
      if (receipt.state === 'verified') return receipt;
      throw new Error('Coordinator release is not prepared');
    }
    const copy = join(this.root, 'copies', id);
    await rm(copy, { recursive: true, force: true });
    const source = dirname(this.root);
    const schemas = new Map<string, string>();
    const schema = (path: string) => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return JSON.stringify({
          schema: database
            .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name')
            .all(),
          version: database.prepare('PRAGMA user_version').get(),
        });
      } finally {
        database.close();
      }
    };
    const copyDirectory = async (from: string, to: string) => {
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(from, { withFileTypes: true })) {
        const path = join(from, entry.name),
          target = join(to, entry.name);
        if (path === this.root || entry.isSocket() || /-(wal|shm)$/.test(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error('Coordinator data copy cannot follow symlinks');
        if (entry.isDirectory()) await copyDirectory(path, target);
        else if (entry.isFile()) {
          const handle = await open(path, 'r');
          const headerBytes = Buffer.alloc(16);
          try {
            await handle.read(headerBytes, 0, 16, 0);
          } finally {
            await handle.close();
          }
          const header = headerBytes.toString();
          if (header === 'SQLite format 3\0') {
            const database = new DatabaseSync(path, { readOnly: true });
            try {
              await backup(database, target);
            } finally {
              database.close();
            }
            schemas.set(target, schema(target));
          } else await copyFile(path, target);
          chmodSync(target, 0o600);
        } else throw new Error('Unsupported coordinator data file');
      }
    };
    await copyDirectory(source, copy);
    const stage = join(this.root, 'builds', id);
    // Permission mode denies networking, subprocesses, addons and reads outside the private copy.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--permission',
          `--allow-fs-read=${stage}`,
          `--allow-fs-read=${copy}`,
          `--allow-fs-write=${copy}`,
          join(stage, receipt.manifest.verify),
        ],
        {
          cwd: copy,
          env: {
            PATH: process.env.PATH,
            DEPLOY_DATA_DIR: copy,
            DEPLOY_VERIFY_COPY: '1',
            DEPLOY_VERSION: receipt.manifest.version,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let error = '';
      child.stderr.on('data', (chunk) => {
        error = (error + chunk).slice(-2000);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Coordinator copy verification failed: ${error}`));
      });
    });
    for (const [path, before] of schemas)
      if (schema(path) !== before)
        throw new Error(
          'Coordinator verification changed the data schema; safe rollback is unavailable.',
        );
    receipt.state = 'verified';
    this.persist(receipt);
    await rm(copy, { recursive: true, force: true });
    return receipt;
  }
  async activate(id: string) {
    const receipt = this.receipt(id);
    if (receipt.state === 'activated') {
      if (this.currentEntry !== receipt.entry)
        throw new Error('This coordinator release is no longer current');
      return receipt;
    }
    if (receipt.state !== 'verified') throw new Error('Coordinator must verify before activation');
    // Recheck staged bytes at the switch boundary, not just at Prepare.
    const stage = join(this.root, 'builds', id);
    for (const [path, hash] of Object.entries(receipt.manifest.files))
      if (sha(await readFile(join(stage, path))) !== hash)
        throw new Error('Staged coordinator build changed');
    receipt.previous = this.currentEntry;
    receipt.previousVersion = this.currentVersion;
    receipt.previousId = this.currentId;
    receipt.previousCwd = this.currentCwd;
    receipt.state = 'starting';
    this.persist(receipt);
    try {
      await this.switchBuild(receipt.entry, receipt.manifest.version, id, stage);
      atomic(join(this.root, 'active.json'), {
        entry: receipt.entry,
        version: receipt.manifest.version,
        cwd: stage,
        id,
      });
      receipt.state = 'activated';
      this.persist(receipt);
      this.currentCwd = stage;
      this.currentId = id;
      this.currentEntry = receipt.entry;
      this.currentVersion = receipt.manifest.version;
    } catch (error) {
      await this.restore(receipt, String(error instanceof Error ? error.message : error));
    }
    return receipt;
  }
  async restore(receipt: CoordinatorReceipt, reason: string) {
    // Persist the rollback decision before starting the old build. Recovery sees aborted, never Live.
    receipt.state = 'aborted';
    receipt.error = reason;
    this.persist(receipt);
    atomic(join(this.root, 'active.json'), {
      entry: receipt.previous,
      version: receipt.previousVersion,
      id: receipt.previousId,
      cwd: receipt.previousCwd,
    });
    this.currentId = receipt.previousId;
    this.currentCwd = receipt.previousCwd || process.cwd();
    this.currentEntry = receipt.previous;
    this.currentVersion = receipt.previousVersion;
    await this.switchBuild(
      receipt.previous,
      receipt.previousVersion,
      receipt.previousId,
      receipt.previousCwd,
    );
  }
  async recover() {
    for (const file of await readdir(this.receipts)) {
      if (!file.endsWith('.json')) continue;
      const receipt = this.receipt(file.slice(0, -5));
      if (receipt.state === 'starting') {
        receipt.state = 'aborted';
        receipt.error =
          'Supervisor restarted before activation was confirmed; previous build retained.';
        this.persist(receipt);
        atomic(join(this.root, 'active.json'), {
          entry: receipt.previous,
          version: receipt.previousVersion,
          id: receipt.previousId,
          cwd: receipt.previousCwd,
        });
        this.currentId = receipt.previousId;
        this.currentCwd = receipt.previousCwd || process.cwd();
        this.currentEntry = receipt.previous;
        this.currentVersion = receipt.previousVersion;
      }
    }
  }
}

export async function serveCoordinatorExecutor(executor: CoordinatorExecutor) {
  const socket = join(executor.root, 'switch.sock');
  const keyPath = join(executor.root, 'switch.key');
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath, 'utf8');
  await rm(socket, { force: true });
  const server = createServer((connection) => {
    connection.setTimeout(5000, () => connection.destroy());
    let buffer = '';
    connection.on('error', () => {});
    connection.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 16_384) return connection.destroy();
      if (!buffer.includes('\n')) return;
      connection.pause();
      const send = (value: unknown) =>
        connection.end(JSON.stringify(value) + '\n', () => connection.destroy());
      void (async () => {
        let mutation = false;
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (
            typeof request.key !== 'string' ||
            request.key.length !== key.length ||
            !timingSafeEqual(Buffer.from(request.key), Buffer.from(key))
          )
            throw new Error('Invalid supervisor credential');
          if (request.action === 'status') return send({ receipt: executor.receipt(request.id) });
          if (!['prepare', 'verify', 'activate', 'rollback'].includes(request.action))
            throw new Error('Unknown supervisor operation');
          if (executor.busy) throw new Error('A coordinator switch is already in progress');
          executor.busy = mutation = true;
          connection.setTimeout(0);
          let receipt;
          if (request.action === 'prepare')
            receipt = await executor.prepare(request.id, request.source, request.digest);
          else if (request.action === 'verify') receipt = await executor.verify(request.id);
          else if (request.action === 'activate') receipt = await executor.activate(request.id);
          else {
            receipt = executor.receipt(request.id);
            if (receipt.state !== 'activated' || executor.currentEntry !== receipt.entry)
              throw new Error('Only the current coordinator release can roll back');
            await executor.restore(receipt, 'Rolled back by the release service.');
          }
          send({ receipt });
        } catch (error) {
          send({ error: String(error instanceof Error ? error.message : error) });
        } finally {
          if (mutation) executor.busy = false;
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      chmodSync(socket, 0o600);
      resolve();
    });
  });
  return server;
}
export async function coordinatorCommand(
  root: string,
  action: string,
  input: Record<string, unknown>,
) {
  const directory = join(root, 'coordinator-updates');
  const key = readFileSync(join(directory, 'switch.key'), 'utf8');
  return new Promise<CoordinatorReceipt>((resolve, reject) => {
    const connection = createConnection(join(directory, 'switch.sock'));
    let result = '';
    connection.setTimeout(180_000, () =>
      connection.destroy(new Error('Coordinator switch timed out')),
    );
    connection.on('error', reject);
    connection.on('connect', () =>
      connection.write(JSON.stringify({ ...input, key, action }) + '\n'),
    );
    connection.on('data', (chunk) => {
      result += chunk;
    });
    connection.on('end', () => {
      try {
        const response = JSON.parse(result);
        if (response.error) reject(new Error(response.error));
        else resolve(response.receipt);
      } catch (error) {
        reject(error);
      }
    });
  });
}
export async function settledCoordinatorReceipt(root: string, id: string) {
  for (let i = 0; i < 180; i++) {
    const receipt = await coordinatorCommand(root, 'status', { id });
    if (receipt.state !== 'starting') return receipt;
    await delay(1000);
  }
  throw Object.assign(new Error('Coordinator activation outcome is still uncertain'), {
    requiresRecovery: true,
  });
}
