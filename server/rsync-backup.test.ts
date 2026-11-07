// The whole-directory backup from a running data directory to a replacement one, all real: maintenance
// runs rsync to a temp destination, scripts/restore-backup.mjs restores it, and a separate process
// reads the result the way a restarted server would.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const owner = 'admin';
const providerAddress = 'deploy.local/test/provider-connection';
const projectAddress = ['admin', 'project-1', 'app', 'API_TOKEN'] as const;
const restoreScript = resolve(import.meta.dirname, '..', 'scripts', 'restore-backup.mjs');

let root: string;
let home: string;
let store: typeof import('./store.ts');
let maintenance: typeof import('./maintenance.ts');
let requests: typeof import('./requests-db.ts');
let secrets: typeof import('./secrets.ts');
let workspace: typeof import('./workspace/store.ts');
let rsyncBackup: typeof import('./rsync-backup.ts');

/** A folder the backup will accept, like a mounted drive. */
function attachedDrive(name: string) {
  const destination = join(root, name);
  mkdirSync(destination);
  writeFileSync(join(destination, rsyncBackup.DESTINATION_MARKER), '');
  return destination;
}

function backUpTo(destination: string) {
  store.saveBackupSettings({ enabled: true, destination, cron: '0 0 * * *' });
  return maintenance.maintenance.runBackup();
}

function restore(...args: string[]) {
  return spawnSync(process.execPath, [restoreScript, ...args], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  });
}

const mode = (path: string) => statSync(path).mode & 0o777;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-rsync-backup-'));
  home = join(root, 'home');
  process.env.DEPLOY_DATA_DIR = home;
  delete process.env.DEPLOY_SECRET_KEY;
  store = await import('./store.ts');
  maintenance = await import('./maintenance.ts');
  requests = await import('./requests-db.ts');
  secrets = await import('./secrets.ts');
  workspace = await import('./workspace/store.ts');
  rsyncBackup = await import('./rsync-backup.ts');
  store.getDb();
  secrets.loadOrCreateSecretKey();
});

after(() => {
  store.saveBackupSettings({ enabled: false, destination: '', cron: '0 0 * * *' });
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('whole-directory rsync backup', () => {
  it('round trips a running data directory through a backup and a restore', async () => {
    const key = secrets.loadOrCreateSecretKey();

    // Committed rows still in the WAL.
    workspace.save('task', owner, { id: 'task-checkpointed', title: 'In the main file' });
    workspace.db.pragma('wal_checkpoint(TRUNCATE)');
    workspace.db.pragma('wal_autocheckpoint = 0');
    workspace.save('task', owner, { id: 'task-in-wal', title: 'Only in the WAL' });
    workspace.event(owner, 'task-in-wal', null, 'chat.message', { text: 'Hello' });
    workspace.save('provider-connection', owner, {
      id: 'provider-1',
      secret: secrets.encryptSecret('provider api key', key, providerAddress),
    });
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO project_configuration
          (owner, project_id, app, key, value_type, value, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 'secret', ?, ?, ?)`,
      )
      .run(
        ...projectAddress,
        secrets.encryptSecret(
          'project token',
          key,
          secrets.projectSecretAddress(...projectAddress),
        ),
        new Date().toISOString(),
        owner,
      );
    requests
      .getRequestsSqlite()
      .prepare(
        `INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp)
         VALUES('app','GET','/in-the-wal',200,5,?)`,
      )
      .run(Date.now());

    // What only this backup carries, and things it must not take or drop.
    const repository = join(home, 'workspace', 'repositories', 'project-1.git');
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(home, 'volumes', 'app'), { recursive: true });
    writeFileSync(join(home, 'volumes', 'app', 'requests.db'), 'an app file of the same name');
    mkdirSync(join(home, 'packages', 'tmp'), { recursive: true });
    writeFileSync(join(home, 'packages', 'tmp', 'unfinished'), 'incomplete');

    // A transaction open across the backup, spilled into the WAL uncommitted.
    const workspaceFile = join(home, 'workspace', 'workspace.db');
    const writer = new Database(workspaceFile);
    writer.pragma('cache_size = 5');
    const walBefore = statSync(`${workspaceFile}-wal`).size;
    writer.exec('BEGIN IMMEDIATE');
    const insert = writer.prepare(`INSERT INTO records VALUES ('task', ?, ?, ?)`);
    for (let index = 0; index < 100; index += 1)
      insert.run(`task-uncommitted-${index}`, owner, JSON.stringify({ text: 'x'.repeat(16_384) }));
    assert.ok(statSync(`${workspaceFile}-wal`).size > walBefore + 512 * 1024);

    const drive = attachedDrive('drive');
    writeFileSync(join(drive, 'left-from-an-older-backup'), 'mirrored away');
    let result;
    try {
      result = await backUpTo(drive);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
    assert.equal(result.success, true, result.error ?? '');

    // The copy has snapshots and no live database files.
    for (const file of rsyncBackup.BACKUP_DATABASES) {
      assert.equal(existsSync(join(drive, `${file}.snapshot`)), true, `${file}.snapshot`);
      for (const live of [file, `${file}-wal`, `${file}-shm`, `${file}.snapshot.tmp`])
        assert.equal(existsSync(join(drive, live)), false, live);
      // Snapshots use the data disk for the length of the backup, not after it.
      assert.equal(existsSync(join(home, `${file}.snapshot`)), false);
    }
    assert.equal(
      readFileSync(join(drive, 'workspace/repositories/project-1.git/HEAD'), 'utf8'),
      'ref: refs/heads/main\n',
    );
    assert.equal(existsSync(join(drive, 'volumes/app/requests.db')), true);
    assert.equal(existsSync(join(drive, 'packages/tmp')), false);
    assert.equal(existsSync(join(drive, 'left-from-an-older-backup')), false);
    // --delete must not remove the marker that lets the next backup run.
    assert.equal(existsSync(join(drive, rsyncBackup.DESTINATION_MARKER)), true);
    assert.equal(existsSync(join(drive, rsyncBackup.COMPLETE_MARKER)), true);

    // Mode and owner of the key survive the copy.
    const driveKey = join(drive, 'secrets', 'master.key');
    assert.equal(mode(driveKey), 0o600);
    assert.equal(mode(join(drive, 'secrets')), 0o700);
    assert.equal(statSync(driveKey).uid, statSync(join(home, 'secrets', 'master.key')).uid);
    assert.deepEqual(readFileSync(driveKey), key);

    const replacement = join(root, 'replacement');
    mkdirSync(replacement);
    const restored = restore(drive, replacement);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stderr, /This data came from .*home.*absolute path/);

    assert.equal(mode(join(replacement, 'secrets', 'master.key')), 0o600);
    assert.equal(mode(join(replacement, 'secrets')), 0o700);
    assert.equal(existsSync(join(replacement, rsyncBackup.DESTINATION_MARKER)), false);
    for (const file of rsyncBackup.BACKUP_DATABASES) {
      assert.equal(existsSync(join(replacement, `${file}.snapshot`)), false);
      assert.equal(existsSync(join(replacement, `${file}-wal`)), false);
    }
    assert.equal(
      readFileSync(join(replacement, 'workspace/repositories/project-1.git/HEAD'), 'utf8'),
      'ref: refs/heads/main\n',
    );

    // Read back through the real modules in their own process, as a restarted server would.
    const module = (path: string) => pathToFileURL(join(import.meta.dirname, path)).href;
    const reader = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const workspace = await import(${JSON.stringify(module('workspace/store.ts'))});
         const secrets = await import(${JSON.stringify(module('secrets.ts'))});
         const { getSqlite } = await import(${JSON.stringify(module('store.ts'))});
         const { getRequestsSqlite } = await import(${JSON.stringify(module('requests-db.ts'))});
         const key = secrets.loadOrCreateSecretKey();
         const provider = workspace.get('provider-connection', ${JSON.stringify(owner)}, 'provider-1');
         const project = getSqlite()
           .prepare("SELECT value FROM project_configuration WHERE key = 'API_TOKEN'")
           .get();
         console.log(JSON.stringify({
           tasks: workspace.list('task', ${JSON.stringify(owner)}).map((task) => task.id),
           chat: workspace.events(${JSON.stringify(owner)}).map((event) => event.payload.text),
           requests: getRequestsSqlite().prepare('SELECT path FROM request_logs').all(),
           providerKey: secrets.decryptSecret(provider.secret, key, ${JSON.stringify(providerAddress)}),
           projectToken: secrets.decryptSecret(
             project.value,
             key,
             secrets.projectSecretAddress(...${JSON.stringify(projectAddress)}),
           ),
         }));`,
      ],
      { encoding: 'utf8', env: { ...process.env, DEPLOY_DATA_DIR: replacement } },
    );
    assert.equal(reader.status, 0, reader.stderr);
    assert.deepEqual(JSON.parse(reader.stdout.trim().split('\n').at(-1)!), {
      tasks: ['task-checkpointed', 'task-in-wal'],
      chat: ['Hello'],
      requests: [{ path: '/in-the-wal' }],
      providerKey: 'provider api key',
      projectToken: 'project token',
    });

    // The next backup to the same drive still runs.
    const second = await backUpTo(drive);
    assert.equal(second.success, true, second.error ?? '');
  });

  it('writes nothing when the destination folder does not exist', async () => {
    // A subfolder of a mount point with no drive on it: the parent exists, rsync would create it.
    const mountPoint = join(root, 'mnt-missing');
    mkdirSync(mountPoint);
    const destination = join(mountPoint, 'deploy-backup');
    const result = await backUpTo(destination);
    assert.equal(result.success, false);
    assert.match(result.error!, /does not exist.*not mounted.*Nothing was written/);
    assert.deepEqual(readdirSync(mountPoint), []);
    assert.equal(existsSync(join(home, 'deploy.db.snapshot')), false);
  });

  it('writes nothing to an empty mount point, and deletes nothing from an unmarked folder', async () => {
    const mountPoint = join(root, 'mnt-empty');
    mkdirSync(mountPoint);
    const empty = await backUpTo(mountPoint);
    assert.equal(empty.success, false);
    assert.match(empty.error!, /no \.deploy-backup-destination file.*Nothing was written.*touch/);
    assert.deepEqual(readdirSync(mountPoint), []);
    assert.equal(existsSync(join(home, 'deploy.db.snapshot')), false);

    writeFileSync(join(mountPoint, 'precious'), 'someone else made this');
    assert.equal((await backUpTo(mountPoint)).success, false);
    assert.deepEqual(readdirSync(mountPoint), ['precious']);
  });

  it('refuses a destination that overlaps the data directory', () => {
    assert.match(
      rsyncBackup.destinationProblem(home, join(home, 'backups', 'copy'))!,
      /overlaps the data directory/,
    );
    assert.match(rsyncBackup.destinationProblem(home, root)!, /overlaps the data directory/);
    assert.match(rsyncBackup.destinationProblem(home, 'relative/path')!, /absolute path/);
  });

  it('refuses to snapshot without room on the data disk', () => {
    const needed = rsyncBackup.snapshotBytesNeeded(home);
    assert.throws(
      () => rsyncBackup.assertRoomForSnapshots(home, () => needed - 1),
      /Database snapshots need .* free on the data disk .*Nothing was copied/,
    );
    assert.doesNotThrow(() => rsyncBackup.assertRoomForSnapshots(home, () => needed));
  });

  it('finishes snapshots while other connections keep writing', async () => {
    const writer = new Database(join(home, 'workspace', 'workspace.db'));
    writer.exec('CREATE TABLE IF NOT EXISTS filler(value TEXT)');
    const fill = writer.prepare('INSERT INTO filler VALUES (?)');
    writer.transaction(() => {
      for (let index = 0; index < 600; index += 1) fill.run('x'.repeat(64 * 1024));
    })();
    const insert = writer.prepare("INSERT INTO filler VALUES ('y')");
    const timer = setInterval(() => insert.run(), 2);
    try {
      await maintenance.snapshotDatabase();
    } finally {
      clearInterval(timer);
    }
    const snapshotFile = rsyncBackup.snapshotPath(home, 'workspace/workspace.db');
    const snapshot = new Database(snapshotFile, { readonly: true });
    assert.equal(snapshot.pragma('integrity_check', { simple: true }), 'ok');
    snapshot.close();
    writer.exec('DROP TABLE filler');
    writer.close();
    rsyncBackup.removeSnapshots(home);
  });

  it('reads rsync exits for what they mean', () => {
    assert.equal(rsyncBackup.rsyncFailure(0, '', '/drive'), null);
    assert.equal(rsyncBackup.rsyncFailure(24, 'file has vanished: "/x"', '/drive'), null);
    assert.match(
      rsyncBackup.rsyncFailure(11, 'write failed: No space left on device (28)', '/drive')!,
      /\/drive ran out of space, so this copy is incomplete/,
    );
    assert.equal(rsyncBackup.rsyncFailure(23, 'some files failed', '/drive'), 'some files failed');
    assert.equal(rsyncBackup.rsyncFailure(12, '', '/drive'), 'rsync exit code 12');
  });

  it('does not restore a copy that was cut short unless told to', async () => {
    const drive = attachedDrive('drive-cut-short');
    const result = await backUpTo(drive);
    assert.equal(result.success, true, result.error ?? '');
    rsyncBackup.markCopyStarted(drive);

    const replacement = join(root, 'cut-short-replacement');
    const refused = restore(drive, replacement);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /did not finish.*--allow-incomplete/);
    assert.equal(existsSync(replacement), false);

    const allowed = restore(drive, replacement, '--allow-incomplete');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(existsSync(join(replacement, 'deploy.db')), true);

    const notEmpty = restore(drive, replacement, '--allow-incomplete');
    assert.equal(notEmpty.status, 1);
    assert.match(notEmpty.stderr, /must be empty/);
  });
});
