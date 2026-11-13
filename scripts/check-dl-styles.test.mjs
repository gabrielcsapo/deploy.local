import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/check-dl-styles.mjs');
const run = (directory) =>
  spawnSync(process.execPath, [script, '--root', directory], { encoding: 'utf8' });

function copy(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dl-styles-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    'design/ds/deploy-local',
    'app/components/ui/v2',
    'app/design-tokens.css',
    'scripts/dl-style-drift.json',
  ])
    cpSync(join(root, path), join(directory, path), { recursive: true });
  return directory;
}

test('the boards and the web app differ only where the record says', () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('a value changed on one side only fails the check', (t) => {
  const directory = copy(t);
  appendFileSync(
    join(directory, 'app/components/ui/v2/components.css'),
    '\n.dl-btn { border-radius: 4px; }\n',
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new conflicts: .*"\.dl-btn".*"border-radius"/);
});

test('a token resolved differently in the dark theme fails the check', (t) => {
  const directory = copy(t);
  appendFileSync(
    join(directory, 'design/ds/deploy-local/components/bundle.css'),
    '\n.dl-hint{color:var(--ink)}\n',
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new conflicts: .*"\.dl-hint".*"color"/);
});

test('a dl-* class added to one side only fails the check', (t) => {
  const directory = copy(t);
  appendFileSync(
    join(directory, 'app/components/ui/v2/components.css'),
    '\n.dl-snooze { display: flex; }\n',
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new appOnlyClasses: "dl-snooze"/);
});
