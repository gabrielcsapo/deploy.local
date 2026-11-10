import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneCliBuilds, pruneReleases } from './self-update.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'update-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('CLI retention removes only stale direct cli.* directories', (t) => {
  const root = fixture(t);
  const data = join(root, 'data');
  mkdirSync(data);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'keep');
  for (const name of [
    'cli',
    'cli.previous',
    'cli.next',
    'cli.abcdef',
    'cli.old',
    'cli-build',
    'desktop',
  ])
    mkdirSync(join(data, name));
  symlinkSync(outside, join(data, 'cli.link'));
  writeFileSync(join(data, 'cli.file'), 'keep');
  const removed = pruneCliBuilds(data);
  assert.deepEqual(removed.sort(), [join(data, 'cli.abcdef'), join(data, 'cli.old')]);
  for (const name of [
    'cli',
    'cli.previous',
    'cli.next',
    'cli-build',
    'desktop',
    'cli.file',
    'cli.link',
  ])
    assert.ok(existsSync(join(data, name)), name);
  assert.ok(existsSync(join(outside, 'keep')));
});

test('release retention preserves canonical running and rollback pins and reports unknown entries', (t) => {
  const root = fixture(t);
  const releases = join(root, 'releases');
  mkdirSync(releases);
  const names = Array.from({ length: 8 }, (_, n) => `2030010${n + 1}-main-abcdef0`);
  names.forEach((name, n) => {
    const path = join(releases, name);
    mkdirSync(path);
    utimesSync(path, n + 1, n + 1);
  });
  const running = join(root, 'current');
  symlinkSync(join(releases, names[0]), running);
  const rollback = join(releases, names[1]);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(releases, '20310101-main-1234567'));
  mkdirSync(join(releases, 'manual-release'));
  writeFileSync(join(releases, 'notes'), 'keep');
  const messages = [];
  const removed = pruneReleases(releases, [running, rollback], 3, (line) => messages.push(line));
  assert.deepEqual(
    new Set(removed),
    new Set(names.slice(2, 5).map((name) => join(releases, name))),
  );
  for (const name of [
    names[0],
    names[1],
    ...names.slice(5),
    'manual-release',
    'notes',
    '20310101-main-1234567',
  ])
    assert.ok(existsSync(join(releases, name)), name);
  assert.equal(messages.length, 3);
  assert.ok(messages.every((line) => line.includes('Unrecognized release entry (kept)')));
  assert.ok(existsSync(outside));
});

test('CLI aliases protect the builds they currently point to', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'cli.running'));
  mkdirSync(join(root, 'cli.rollback'));
  symlinkSync(join(root, 'cli.running'), join(root, 'cli'));
  symlinkSync(join(root, 'cli.rollback'), join(root, 'cli.previous'));
  assert.deepEqual(pruneCliBuilds(root), []);
});
