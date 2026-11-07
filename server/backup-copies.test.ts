import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import * as backup from './rsync-backup.ts';

const root = mkdtempSync(join(tmpdir(), 'deploy-copy-policy-'));
after(() => rmSync(root, { recursive: true, force: true }));

it('retains recent runs, seven daily and four weekly copies, and prunes only owned folders', async () => {
  const destination = join(root, 'retention');
  mkdirSync(destination);
  const now = new Date('2026-11-07T18:00:00.000Z');
  const copies: string[] = [];
  for (let day = 40; day >= 0; day--) {
    const path = await backup.createCopyDirectory(destination, new Date(+now - day * 86400000));
    await backup.markCopyComplete(root, path);
    copies.push(path);
  }
  const recent = await backup.createCopyDirectory(destination, new Date(+now - 6 * 3600000));
  await backup.markCopyComplete(root, recent);
  const incomplete = await backup.createCopyDirectory(destination, new Date('2020-01-01'));
  const newer = await backup.createCopyDirectory(destination, new Date(+now + 1));
  const sameTime = await backup.createCopyDirectory(destination, now);
  const malformed = join(
    destination,
    'deploy-backup-2020-02-30T00-00-00-000Z-00000000-0000-4000-8000-000000000000',
  );
  mkdirSync(malformed);
  const unrelated = join(destination, 'deploy-backup-2020-01-01');
  mkdirSync(unrelated);
  writeFileSync(join(destination, 'precious'), 'keep');
  const symlink = join(
    destination,
    'deploy-backup-2019-01-01T00-00-00-000Z-00000000-0000-4000-8000-000000000000',
  );
  symlinkSync(copies[0], symlink);
  const kept = backup.retainedCopyNames(await backup.listBackupCopies(destination), now);
  for (const path of copies.slice(-7)) assert.ok(kept.has(path.split('/').at(-1)!));
  assert.ok(kept.has(recent.split('/').at(-1)!));
  assert.ok(kept.has(copies[27].split('/').at(-1)!)); // Sunday of a prior UTC week.
  assert.ok(!kept.has(copies[0].split('/').at(-1)!));
  await backup.pruneBackupCopies(destination, now);
  assert.equal(
    (await backup.listBackupCopies(destination)).filter((copy) => copy.complete).length,
    kept.size,
  );
  const entries = readdirSync(destination);
  for (const path of [newer, sameTime, malformed, unrelated, symlink])
    assert.ok(entries.includes(path.split('/').at(-1)!));
  assert.ok(entries.includes('precious'));
  assert.equal(existsSync(incomplete), false, 'older incomplete copy must be removed');
  // A clock jump must not remove the newest complete copy.
  assert.ok(
    backup
      .retainedCopyNames(await backup.listBackupCopies(destination), new Date('2035-01-01'))
      .has(copies.at(-1)!.split('/').at(-1)!),
  );
});

it('checks destination hard links asynchronously and reports the exact actionable failure', async () => {
  const destination = join(root, 'links');
  mkdirSync(destination);
  const probe = backup.assertDestinationHardLinks(destination);
  assert.ok(probe instanceof Promise, 'hard-link probe must use asynchronous I/O');
  await probe;
  assert.deepEqual(readdirSync(destination), []);
  await assert.rejects(
    async () =>
      backup.assertDestinationHardLinks(destination, () => {
        throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
      }),
    {
      message: `Backup destination ${destination} can't make hard links, so it can't keep dated copies. Nothing was written. Format the drive as ext4.`,
    },
  );
  assert.deepEqual(readdirSync(destination), []);
});

it('budgets a full first copy and all changed data in the next copy before writing it', async () => {
  const destination = join(root, 'room');
  const source = join(root, 'source');
  mkdirSync(destination);
  mkdirSync(source);
  writeFileSync(join(source, 'asset'), Buffer.alloc(1024 * 1024));
  writeFileSync(join(source, 'deploy.db.snapshot'), Buffer.alloc(4096));
  const timestamp = new Date('2026-01-01T00:00:00Z');
  utimesSync(join(source, 'asset'), timestamp, timestamp);
  const first = await backup.copyBytesNeeded(source);
  assert.ok(first >= 1024 * 1024 + 4096);
  await assert.rejects(async () => backup.assertRoomForCopy(destination, first, () => first - 1), {
    message: `Backup destination ${destination} doesn't have room for this copy, which needs ${(first / 1024 ** 3).toFixed(1)} GB. Nothing was written.`,
  });
  await backup.assertRoomForCopy(destination, first, () => first);
  const previous = await backup.createCopyDirectory(destination);
  writeFileSync(join(previous, 'asset'), Buffer.alloc(1024 * 1024));
  writeFileSync(join(previous, 'deploy.db.snapshot'), Buffer.alloc(4096));
  utimesSync(join(previous, 'asset'), timestamp, timestamp);
  const next = await backup.copyBytesNeeded(source, previous);
  // Fresh database snapshots are always budgeted; unchanged assets are not.
  assert.equal(first - next, 1024 * 1024);
  writeFileSync(join(source, 'asset'), Buffer.alloc(1024 * 1024, 1));
  utimesSync(join(source, 'asset'), timestamp, timestamp);
  assert.equal(
    await backup.copyBytesNeeded(source, previous),
    next,
    'same size and mtime must not read contents',
  );
  utimesSync(join(source, 'asset'), +timestamp / 1000, +timestamp / 1000 + 0.75);
  assert.equal(
    await backup.copyBytesNeeded(source, previous),
    next,
    'rsync ignores subsecond mtime',
  );
  utimesSync(join(source, 'asset'), timestamp, new Date(+timestamp + 1000));
  assert.equal(await backup.copyBytesNeeded(source, previous), first);
  utimesSync(join(source, 'asset'), timestamp, timestamp);
  chmodSync(join(source, 'asset'), 0o700);
  assert.equal(await backup.copyBytesNeeded(source, previous), first);
});

it('uses rsync quick checks without checksum reads', () => {
  const args = backup.rsyncArguments('/source', '/destination', '/previous');
  assert.ok(!args.includes('--checksum'));
  assert.ok(args.includes('--link-dest=/previous'));
});

it('yields to requests while budgeting a first copy and pruning a tree', async () => {
  const destination = join(root, 'yield-drive');
  mkdirSync(destination);
  const source = await backup.createCopyDirectory(destination, new Date('2020-01-01'));
  for (let index = 0; index < 2000; index++) writeFileSync(join(source, String(index)), 'x');
  let ticked = false;
  let timer = setTimeout(() => {
    ticked = true;
  }, 0);
  await backup.copyBytesNeeded(source);
  clearTimeout(timer);
  assert.ok(ticked, 'budgeting must let timers run');
  await backup.markCopyComplete(root, source);
  for (let day = 1; day <= 40; day++) {
    const copy = await backup.createCopyDirectory(
      destination,
      new Date(Date.UTC(2020, 0, day + 1)),
    );
    await backup.markCopyComplete(root, copy);
  }
  ticked = false;
  timer = setTimeout(() => {
    ticked = true;
  }, 0);
  await backup.pruneBackupCopies(destination, new Date('2020-02-10'));
  clearTimeout(timer);
  assert.ok(ticked, 'pruning must let timers run');
  assert.equal(existsSync(source), false);
});

it('does not prune incomplete copies when there is no complete copy', async () => {
  const destination = join(root, 'no-complete');
  mkdirSync(destination);
  const copy = await backup.createCopyDirectory(destination, new Date('2020-01-01'));
  await backup.pruneBackupCopies(destination);
  assert.ok(existsSync(copy));
});

it('publishes and lists completion markers asynchronously', async () => {
  const destination = join(root, 'async-marker');
  mkdirSync(destination);
  const copy = await backup.createCopyDirectory(destination);
  const publish = backup.markCopyComplete(root, copy);
  assert.ok(publish instanceof Promise, 'publishing must use asynchronous I/O');
  await publish;
  const listing = backup.listBackupCopies(destination);
  assert.ok(listing instanceof Promise, 'listing must use asynchronous I/O');
  assert.equal((await listing)[0].complete, true);
});

it('budgets same-size same-mtime data without reading content or subsecond timestamps', async () => {
  const source = join(root, 'quick-source');
  const previous = join(root, 'quick-previous');
  mkdirSync(source);
  mkdirSync(previous);
  writeFileSync(join(source, 'asset'), 'new');
  writeFileSync(join(previous, 'asset'), 'old');
  const seconds = Date.UTC(2026, 0, 1) / 1000;
  utimesSync(join(source, 'asset'), seconds, seconds);
  utimesSync(join(previous, 'asset'), seconds, seconds);
  assert.equal(await backup.copyBytesNeeded(source, previous), 256 * 1024 ** 2);
  utimesSync(join(source, 'asset'), seconds, seconds + 0.75);
  assert.equal(await backup.copyBytesNeeded(source, previous), 256 * 1024 ** 2);
});

it('reports the exact hard-link preflight reason', async () => {
  const destination = join(root, 'link-message');
  mkdirSync(destination);
  await assert.rejects(
    async () =>
      backup.assertDestinationHardLinks(destination, () => {
        throw new Error('injected unsupported filesystem');
      }),
    {
      message: `Backup destination ${destination} can't make hard links, so it can't keep dated copies. Nothing was written. Format the drive as ext4.`,
    },
  );
  assert.deepEqual(readdirSync(destination), []);
});

it('lists copies asynchronously', async () => {
  const listing = backup.listBackupCopies(root);
  assert.ok(listing instanceof Promise);
  await listing;
});

it('yields during retention deletion', async () => {
  const destination = join(root, 'prune-yield');
  mkdirSync(destination);
  const source = await backup.createCopyDirectory(destination, new Date('2020-01-01'));
  for (let index = 0; index < 2000; index++) writeFileSync(join(source, String(index)), 'x');
  for (let day = 1; day <= 40; day++) {
    const copy = await backup.createCopyDirectory(
      destination,
      new Date(Date.UTC(2020, 0, day + 1)),
    );
    await backup.markCopyComplete(root, copy);
  }
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 0);
  await backup.pruneBackupCopies(destination, new Date('2020-02-10'));
  clearTimeout(timer);
  assert.ok(ticked, 'pruning must let timers run');
});
