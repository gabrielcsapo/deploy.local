import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const run = (script, directory, ...args) =>
  spawnSync(process.execPath, [join(root, 'scripts', script), '--root', directory, ...args], {
    encoding: 'utf8',
  });

function copy(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dl-styles-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    'design/ds/deploy-local',
    'app/components/ui/v2',
    'app/design-tokens.css',
    'scripts/dl-style-drift.json',
    '.oxfmtrc.json',
  ])
    cpSync(join(root, path), join(directory, path), { recursive: true });
  return directory;
}

test('the app takes its dl-* rules from the design system', () => {
  const result = run('check-dl-styles.mjs', root);
  assert.equal(result.status, 0, result.stderr);
});

test('an app rule that changes a design-system property fails', (t) => {
  const directory = copy(t);
  appendFileSync(
    join(directory, 'app/components/ui/v2/components.css'),
    '\n.dl-btn {\n  border-radius: 4px;\n}\n',
  );
  const result = run('check-dl-styles.mjs', directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /components\.css sets border-radius on \.dl-btn/);
});

test('a source change reaches the app only through the generator', (t) => {
  const directory = copy(t);
  appendFileSync(
    join(directory, 'design/ds/deploy-local/components/bundle.css'),
    '\n.dl-hint{letter-spacing:.01em}\n',
  );
  let result = run('check-dl-styles.mjs', directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dl-components\.css is out of date/);
  assert.equal(run('build-dl-styles.mjs', directory).status, 0);
  result = run('check-dl-styles.mjs', directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(directory, 'app/components/ui/v2/dl-components.css'), 'utf8'),
    /letter-spacing: 0\.01em/,
  );
});

test('a design-system token that no longer matches its app token fails', (t) => {
  const directory = copy(t);
  const file = join(directory, 'design/ds/deploy-local/tokens.css');
  writeFileSync(file, readFileSync(file, 'utf8').replace('--paper: #f7f7f8;', '--paper: #fafafa;'));
  const result = run('check-dl-styles.mjs', directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--paper → --ds-canvas differ in light/);
});
