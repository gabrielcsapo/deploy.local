import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { keptFixture } from './kept.fixture.ts';
const fixture = await keptFixture();
const { db, add, clock } = fixture;
const { keptQuery, keptTotals, listKept, readKept, removeKept } = await import('./kept.ts');
const { storageStatus, cleanupCopies } = await import('./copies.ts');
const { writeCopy } = await import('./cache.ts');
after(fixture.close);
beforeEach(fixture.reset);
const query = (values: Record<string, string> = {}) => keptQuery(new URLSearchParams(values));

test('lists both ecosystems with bounded paging, literal search, kind filters and stable sorts', async () => {
  for (let i = 0; i < 55; i++)
    await add(`pkg-${String(i).padStart(2, '0')}`, '1.0.0', 'npm', i + 1, i);
  await add('pkg-cargo', '1.0.0', 'cargo', 200);
  await add('@scope/pkg', '1.0.0', 'npm', 300);
  const first = listKept('owner', query(), clock);
  assert.equal(first.packages, 57);
  assert.equal(first.entries.length, 50);
  assert.equal(first.entries[0].name, '@scope/pkg');
  const second = listKept('owner', query({ page: '2' }), clock);
  assert.equal(second.entries.length, 7);
  assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.name)).size, 57);
  assert.equal(listKept('owner', query({ q: 'PKG' }), clock).packages, 57);
  assert.equal(listKept('owner', query({ q: '%' }), clock).packages, 0);
  assert.equal(listKept('owner', query({ kind: 'cargo' }), clock).entries[0].name, 'pkg-cargo');
  assert.equal(listKept('owner', query({ kind: 'npm' }), clock).packages, 56);
  assert.equal(listKept('owner', query({ sort: 'name' }), clock).entries[0].name, '@scope/pkg');
  assert.equal(listKept('owner', query({ sort: 'installed' }), clock).entries[0].name, 'pkg-00');
  assert.equal(listKept('owner', query({ page: '999' }), clock).page, 2);
  assert.throws(() => query({ sort: 'size; DROP TABLE packages' }));
  assert.throws(() => query({ page: '-1' }));
});

test('totals and needed-by include main requirements, release/rollback and install pins; Cargo is protected', async () => {
  await add('shared', '1.0.0', 'npm', 100);
  await add('shared', '2.0.0', 'npm', 200);
  await add('shared', '3.0.0', 'npm', 300);
  await add('shared', '4.0.0', 'npm', 400, 1);
  await add('crate', '1.0.0', 'cargo', 50);
  db()
    .prepare('INSERT INTO package_project_requirements VALUES(?,?,?,?,?)')
    .run('owner', 'p1', 'shared@1.0.0', 'shared', '1.0.0');
  db()
    .prepare('INSERT INTO package_pins VALUES(?,?,?,?,?)')
    .run('npm', 'shared@2.0.0', 'p2', 'rollback', 'release');
  const totals = keptTotals(clock);
  assert.equal(totals.bytes, 1050);
  assert.equal(totals.versions, 5);
  assert.equal(totals.packages, 2);
  assert.equal(totals.ecosystems.npm.bytes, 1000);
  assert.equal(totals.ecosystems.cargo.bytes, 50);
  assert.equal(totals.needed.bytes, 350);
  assert.equal(totals.idle.bytes, 300);
  assert.equal(storageStatus().pinned, 350);
  const entry = readKept('owner', 'npm', 'shared');
  assert.equal(entry.neededVersions, 2);
  assert.equal(entry.totalVersions, 4);
  assert.deepEqual(
    entry.neededBy.map((p) => p.name),
    ['forma', 'wander'],
  );
  assert.deepEqual(
    entry.versions.map((v) => v.version),
    ['4.0.0', '3.0.0', '2.0.0', '1.0.0'],
  );
  assert.deepEqual(
    entry.versions[3].neededBy.map((p: { name: string }) => p.name),
    ['forma'],
  );
  const idle = listKept('owner', query({ time: 'idle' }), clock);
  assert.equal(idle.versions, 1);
  assert.equal(idle.bytes, 300);
  assert.equal(readKept('owner', 'cargo', 'crate').unusedVersions, 0);
});

test('idle removal refuses all needed versions, preserves recent installs, is idempotent and removes files', async () => {
  const idle = await add('idle');
  await add('recent', '1.0.0', 'npm', 100, 2);
  await add('main');
  await add('release');
  await add('cargo', '1.0.0', 'cargo');
  db()
    .prepare('INSERT INTO package_project_requirements VALUES(?,?,?,?,?)')
    .run('owner', 'p1', 'main@1.0.0', 'main', '1.0.0');
  db()
    .prepare('INSERT INTO package_pins VALUES(?,?,?,?,?)')
    .run('npm', 'release@1.0.0', 'p2', 'live', 'release-installed');
  assert.deepEqual(await removeKept(query({ time: 'idle' }), undefined, clock), {
    versions: 1,
    bytes: 100,
  });
  assert.equal(keptTotals(clock).versions, 4);
  await assert.rejects(stat(idle.path), { code: 'ENOENT' });
  assert.deepEqual(await removeKept(query({ time: 'idle' }), undefined, clock), {
    versions: 0,
    bytes: 0,
  });
});

test('package removal isolates name and kind, retains shared objects and upstream tombstones', async () => {
  const one = await add('target');
  await add('other', '1.0.0', 'npm', 100, 40, one.sha256);
  await add('target', '1.0.0', 'cargo');
  db()
    .prepare(
      "UPDATE package_cache_entries SET removed_at='2026-11-01' WHERE ecosystem='npm' AND key='target@1.0.0'",
    )
    .run();
  assert.deepEqual(await removeKept(query({ kind: 'npm' }), 'target', clock), {
    versions: 1,
    bytes: 0,
  });
  assert.ok(await stat(one.path));
  const tombstone = db()
    .prepare(
      "SELECT size,removed_at FROM package_cache_entries WHERE ecosystem='npm' AND key='target@1.0.0'",
    )
    .get() as any;
  assert.equal(tombstone.size, 0);
  assert.equal(tombstone.removed_at, '2026-11-01');
  assert.equal(keptTotals(clock).versions, 2);
  assert.deepEqual(await removeKept(query({ kind: 'npm' }), 'target', clock), {
    versions: 0,
    bytes: 0,
  });
});

test('rechecks pins and last use after waiting for the copy write lock', async () => {
  await add('new-pin');
  await add('just-installed');
  let release!: () => void;
  const lock = writeCopy(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const removal = removeKept(query({ time: 'idle' }), undefined, clock);
  db()
    .prepare('INSERT INTO package_pins VALUES(?,?,?,?,?)')
    .run('npm', 'new-pin@1.0.0', 'p1', 'job', 'job');
  db()
    .prepare("UPDATE package_cache_entries SET last_used_at=? WHERE key='just-installed@1.0.0'")
    .run(new Date(clock).toISOString());
  release();
  await lock;
  assert.deepEqual(await removal, { versions: 0, bytes: 0 });
});

test('automatic cleanup also protects Cargo and normalized main requirements without pins', async () => {
  await add('crate', '1.0.0', 'cargo', 100, 120);
  await add('main', '1.0.0', 'npm', 100, 120);
  await add('unused', '1.0.0', 'npm', 100, 120);
  db()
    .prepare('INSERT INTO package_project_requirements VALUES(?,?,?,?,?)')
    .run('owner', 'p1', 'main@1.0.0', 'main', '1.0.0');
  await cleanupCopies(clock);
  assert.equal(keptTotals(clock).versions, 2);
});

test('detail versions are newest first across major/minor and prerelease numbers, in bounded pages', async () => {
  for (const version of [
    '1.9.0',
    '1.10.0',
    '2.0.0-alpha.2',
    '2.0.0-alpha.10',
    '2.0.0-beta',
    '2.0.0',
  ])
    await add('ordered', version);
  const first = readKept('owner', 'npm', 'ordered');
  assert.deepEqual(
    first.versions.map((v) => v.version),
    ['2.0.0', '2.0.0-beta', '2.0.0-alpha.10', '2.0.0-alpha.2', '1.10.0'],
  );
  assert.deepEqual(
    readKept('owner', 'npm', 'ordered', 5, 100).versions.map((v) => v.version),
    ['1.9.0'],
  );
});

test('route dispatch refuses non-admin removal without a network listener', async () => {
  const { IncomingMessage, ServerResponse } = await import('node:http');
  const { Socket } = await import('node:net');
  const { packagesApi } = await import('./api.ts');
  await add('protected-by-auth');
  for (const path of [
    '/api/packages/cache/kept/remove?time=idle',
    '/api/packages/cache/remove/npm/protected-by-auth',
  ]) {
    const req = new IncomingMessage(new Socket());
    req.url = path;
    req.method = 'POST';
    const res = new ServerResponse(req);
    await assert.rejects(packagesApi(req, res, 'reader'), { status: 403 });
    req.destroy();
    res.destroy();
  }
  assert.equal(keptTotals(clock).versions, 1);
});

test('admin dispatch returns list/detail totals and removes a scoped package idempotently', async () => {
  const { IncomingMessage, ServerResponse } = await import('node:http');
  const { Socket } = await import('node:net');
  const { packagesApi } = await import('./api.ts');
  async function call(path: string, method = 'GET') {
    const req = new IncomingMessage(new Socket());
    req.url = '/api/packages/cache/' + path;
    req.method = method;
    const res = new ServerResponse(req);
    let body = '';
    res.end = ((chunk: string) => {
      body = chunk;
      return res;
    }) as typeof res.end;
    await packagesApi(req, res, 'owner');
    req.destroy();
    res.destroy();
    return JSON.parse(body);
  }
  await add('@scope/package', '1.0.0', 'npm', 200, 400);
  await add('@scope/package', '2.0.0', 'npm', 100, 400);
  db()
    .prepare('INSERT INTO package_pins VALUES(?,?,?,?,?)')
    .run('npm', '@scope/package@2.0.0', 'p1', 'live', 'release');
  assert.equal((await call('kept?q=package')).versions, 2);
  assert.equal((await call('entry/npm/%40scope%2Fpackage')).totalVersions, 2);
  const removed = await call('remove/npm/%40scope%2Fpackage', 'POST');
  assert.deepEqual(removed, { versions: 1, bytes: 200, keptBytes: 100 });
  assert.equal((await call('remove/npm/%40scope%2Fpackage', 'POST')).versions, 0);
  assert.equal((await call('kept/remove?time=idle', 'POST')).versions, 0);
});
