import { materializeCheckpoint } from './workspace/checkpoint-storage.ts';
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
  it('keeps two dated copies immutable, hard links unchanged files, and restores newest or named copies', async () => {
    const drive = attachedDrive('dated-round-trip');
    writeFileSync(join(drive, 'unrelated'), 'leave me');
    writeFileSync(join(home, 'changed.txt'), 'before');
    writeFileSync(join(home, 'unchanged.txt'), 'shared');
    assert.equal((await backUpTo(drive)).success, true);
    const names = () =>
      readdirSync(drive)
        .filter((name) => name.startsWith('deploy-backup-'))
        .sort();
    assert.equal(names().length, 1, 'each run must create a dated copy');
    const first = names()[0];
    writeFileSync(join(home, 'changed.txt'), 'after!!');
    assert.equal((await backUpTo(drive)).success, true);
    assert.equal(names().length, 2);
    const second = names()[1];
    assert.equal(readFileSync(join(drive, first, 'changed.txt'), 'utf8'), 'before');
    assert.equal(readFileSync(join(drive, second, 'changed.txt'), 'utf8'), 'after!!');
    assert.equal(
      statSync(join(drive, first, 'unchanged.txt')).ino,
      statSync(join(drive, second, 'unchanged.txt')).ino,
    );
    assert.notEqual(
      statSync(join(drive, first, 'changed.txt')).ino,
      statSync(join(drive, second, 'changed.txt')).ino,
    );
    assert.equal(readFileSync(join(drive, 'unrelated'), 'utf8'), 'leave me');
    const listing = restore(drive, '--list');
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, new RegExp(first));
    assert.match(listing.stdout, new RegExp(second));
    const latest = join(root, 'dated-latest');
    const newest = restore(drive, latest);
    assert.equal(newest.status, 0, newest.stderr);
    assert.equal(readFileSync(join(latest, 'changed.txt'), 'utf8'), 'after!!');
    const older = join(root, 'dated-older');
    const named = restore(drive, older, '--copy', first);
    assert.equal(named.status, 0, named.stderr);
    assert.equal(readFileSync(join(older, 'changed.txt'), 'utf8'), 'before');
  });

  it('round trips a running data directory through a backup and a restore', async () => {
    const key = secrets.loadOrCreateSecretKey();

    // Committed rows still in the WAL.
    workspace.save('task', owner, { id: 'task-checkpointed', title: 'In the main file' });
    workspace.db.pragma('wal_checkpoint(TRUNCATE)');
    workspace.db.pragma('wal_autocheckpoint = 0');
    workspace.save('task', owner, { id: 'task-in-wal', title: 'Only in the WAL' });
    const checkpointSnapshot = {
      files: [{ path: 'binary.dat', content: 'AP8BAg==', executable: true }],
      excluded: [],
      digest: 'fixture',
    };
    workspace.save('checkpoint', owner, { id: 'external', snapshot: checkpointSnapshot });
    workspace.db
      .prepare("INSERT INTO records VALUES('checkpoint','inline',?,?)")
      .run(owner, JSON.stringify({ id: 'inline', snapshot: checkpointSnapshot }));

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

    const copy = (await rsyncBackup.listBackupCopies(drive)).find((copy) => copy.complete)!.path;
    // The copy has snapshots and no live database files.
    for (const file of rsyncBackup.BACKUP_DATABASES) {
      assert.equal(existsSync(join(copy, `${file}.snapshot`)), true, `${file}.snapshot`);
      for (const live of [file, `${file}-wal`, `${file}-shm`, `${file}.snapshot.tmp`])
        assert.equal(existsSync(join(copy, live)), false, live);
      // Snapshots use the data disk for the length of the backup, not after it.
      assert.equal(existsSync(join(home, `${file}.snapshot`)), false);
    }
    assert.equal(
      readFileSync(join(copy, 'workspace/repositories/project-1.git/HEAD'), 'utf8'),
      'ref: refs/heads/main\n',
    );
    assert.equal(existsSync(join(copy, 'volumes/app/requests.db')), true);
    assert.equal(existsSync(join(copy, 'packages/tmp')), false);
    assert.equal(existsSync(join(drive, 'left-from-an-older-backup')), true);
    // The destination marker stays at the root; completion belongs to this copy.
    assert.equal(existsSync(join(drive, rsyncBackup.DESTINATION_MARKER)), true);
    assert.equal(existsSync(join(copy, rsyncBackup.COMPLETE_MARKER)), true);

    // Mode and owner of the key survive the copy.
    const driveKey = join(copy, 'secrets', 'master.key');
    assert.equal(mode(driveKey), 0o600);
    assert.equal(mode(join(copy, 'secrets')), 0o700);
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
    const restoredWorkspace = new Database(join(replacement, 'workspace', 'workspace.db'));
    try {
      const rows = restoredWorkspace
        .prepare("SELECT data FROM records WHERE kind='checkpoint'")
        .all() as { data: string }[];
      assert.equal(rows.length, 2);
      for (const row of rows)
        assert.deepEqual(
          materializeCheckpoint(join(replacement, 'workspace'), JSON.parse(row.data)).snapshot,
          checkpointSnapshot,
        );
    } finally {
      restoredWorkspace.close();
    }

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

  it('leaves failed and interrupted runs incomplete and links the next run from the last complete copy', async () => {
    const drive = attachedDrive('failed-runs');
    writeFileSync(join(home, 'stable-through-failure'), 'good');
    assert.equal((await backUpTo(drive)).success, true);
    const first = (await rsyncBackup.listBackupCopies(drive))[0];
    const historical = [];
    for (let day = 0; day < 12; day++) {
      const path = await rsyncBackup.createCopyDirectory(
        drive,
        new Date(Date.now() - (day + 2) * 86400000),
      );
      await rsyncBackup.markCopyComplete(home, path);
      historical.push(path);
    }
    const commands = join(root, 'fake-rsync');
    mkdirSync(commands);
    writeFileSync(
      join(commands, 'rsync'),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.argv.at(-1), 'partial'), 'bad');
console.error('injected rsync failure');
process.exit(23);
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${commands}:${oldPath}`;
      const failed = await backUpTo(drive);
      assert.equal(failed.success, false);
      assert.match(failed.error!, /injected rsync failure/);
    } finally {
      process.env.PATH = oldPath;
    }
    const failed = (await rsyncBackup.listBackupCopies(drive)).find((copy) => !copy.complete)!;
    assert.ok(failed);
    for (const path of historical) assert.ok(existsSync(path), 'failure must not prune old copies');
    assert.equal(existsSync(join(first.path, rsyncBackup.COMPLETE_MARKER)), true);
    const interrupted = await rsyncBackup.createCopyDirectory(drive);
    writeFileSync(join(interrupted, 'stable-through-failure'), 'broken');
    assert.equal((await backUpTo(drive)).success, true);
    const newest = (await rsyncBackup.listBackupCopies(drive)).find((copy) => copy.complete)!;
    assert.notEqual(newest.name, first.name);
    assert.ok(
      historical.some((path) => !existsSync(path)),
      'success should prune expired copies',
    );
    assert.equal(
      statSync(join(newest.path, 'stable-through-failure')).ino,
      statSync(join(first.path, 'stable-through-failure')).ino,
    );
    assert.equal(existsSync(failed.path), false, 'later success removes older failed copy');
    assert.equal(existsSync(interrupted), false, 'later success removes older interrupted copy');
    const replacement = join(root, 'after-failure');
    const restored = restore(drive, replacement);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(join(replacement, 'stable-through-failure'), 'utf8'), 'good');
    assert.equal(existsSync(join(replacement, 'partial')), false);
  });

  it('lists copies and refuses unknown names, missing snapshots and implicit incomplete restores', async () => {
    const drive = attachedDrive('restore-selection');
    const unfinished = await rsyncBackup.createCopyDirectory(drive);
    const name = unfinished.split('/').at(-1)!;
    const listing = restore(drive, '--list');
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, new RegExp(`${name}\\tincomplete`));
    const replacement = join(root, 'selection-refused');
    const defaultRestore = restore(drive, replacement, '--allow-incomplete');
    assert.equal(defaultRestore.status, 1);
    assert.match(defaultRestore.stderr, /No complete dated copy/);
    const traversal = restore(drive, replacement, '--copy', '../home');
    assert.equal(traversal.status, 1);
    assert.match(traversal.stderr, /No dated copy named/);
    const missing = restore(drive, replacement, '--copy', name, '--allow-incomplete');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /deploy.db.snapshot is missing/);
    assert.equal(existsSync(replacement), false);
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
    assert.match(
      empty.error!,
      /no \.deploy-backup-destination file.*Nothing was written.*mount it/,
    );
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
    const copy = (await rsyncBackup.listBackupCopies(drive))[0];
    rmSync(join(copy.path, rsyncBackup.COMPLETE_MARKER));

    const replacement = join(root, 'cut-short-replacement');
    const refused = restore(drive, replacement, '--copy', copy.name);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /did not finish.*--allow-incomplete/);
    assert.equal(existsSync(replacement), false);

    const allowed = restore(drive, replacement, '--copy', copy.name, '--allow-incomplete');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(existsSync(join(replacement, 'deploy.db')), true);

    const notEmpty = restore(drive, replacement, '--copy', copy.name, '--allow-incomplete');
    assert.equal(notEmpty.status, 1);
    assert.match(notEmpty.stderr, /must be empty/);
  });
});
