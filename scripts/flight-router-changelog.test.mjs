import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('router changelog is local, scoped, repeatable, and never changes versions or Git refs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'router-changelog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, 'packages/react-flight-router');
  mkdirSync(join(library, 'scripts'), { recursive: true });
  copyFileSync(
    new URL('../packages/react-flight-router/scripts/release.mjs', import.meta.url),
    join(library, 'scripts/release.mjs'),
  );
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const pkg = join(library, 'package.json');
  writeFileSync(pkg, '{"version":"0.12.1"}\n');
  const changelog = join(library, 'CHANGELOG.md');
  const original = '# Changelog\n\n## [0.12.1]\n\nExisting release.\n';
  writeFileSync(changelog, original);
  git('add', '.');
  git('commit', '-m', 'release: v0.12.1');
  const base = git('rev-parse', 'HEAD');
  const run = (...args) =>
    execFileSync(process.execPath, ['scripts/release.mjs', ...args], {
      cwd: library,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  assert.match(run(), /No router changes/);
  writeFileSync(join(library, 'feature.ts'), 'export const feature = true;');
  git('add', '.');
  git('commit', '-m', 'feat(router): add a feature');
  writeFileSync(join(root, 'unrelated.txt'), 'unrelated');
  git('add', '.');
  git('commit', '-m', 'fix: unrelated root change');
  const refs = git('show-ref');
  const preview = run('--dry-run');
  assert.match(preview, /Features[\s\S]*\*\*router:\*\* add a feature/);
  assert.doesNotMatch(preview, /unrelated root change/);
  assert.equal(readFileSync(changelog, 'utf8'), original);
  run();
  const generated = readFileSync(changelog, 'utf8');
  run();
  assert.equal(readFileSync(changelog, 'utf8'), generated);
  assert.match(generated, /## \[Unreleased\]/);
  assert.ok(generated.endsWith(original.slice(original.indexOf('##'))));
  // A version set in the PR gets its own entry; repeated generation replaces it.
  writeFileSync(pkg, '{"version":"0.12.2"}\n');
  run('--since', base);
  const bumped = readFileSync(changelog, 'utf8');
  assert.match(bumped, /## \[0.12.2\]/);
  assert.doesNotMatch(bumped, /Unreleased/);
  run('--since', base);
  assert.equal(readFileSync(changelog, 'utf8'), bumped);
  assert.equal(readFileSync(pkg, 'utf8'), '{"version":"0.12.2"}\n');
  assert.equal(git('show-ref'), refs);
  assert.throws(() => run('patch'));
  assert.throws(() => run('--publish'));
});
