import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'scripts/check-swift-contracts.mjs');
const run = (directory) =>
  spawnSync(process.execPath, [script, '--root', directory], { encoding: 'utf8' });

function copy(t) {
  const directory = mkdtempSync(join(tmpdir(), 'swift-contracts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(root, 'shared/v2'), join(directory, 'shared/v2'), { recursive: true });
  const core = 'native/Apple/Packages/DeployKit/Sources/DeployCore';
  cpSync(join(root, core), join(directory, core), { recursive: true });
  return directory;
}

test('the Swift contracts match the TypeScript ones, apart from the recorded gaps', () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test('a new TypeScript field without a Swift counterpart fails the check', (t) => {
  const directory = copy(t);
  const file = join(directory, 'shared/v2/contracts.ts');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      "  state: 'waiting' | 'answered' | 'expired' | 'withdrawn';",
      "  state: 'waiting' | 'answered' | 'expired' | 'withdrawn';\n  snoozedUntil?: string;",
    ),
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /InboxItem\.snoozedUntil \(Swift InboxItem\)/);
});

test('a field in a nested inline type is followed into its Swift type', (t) => {
  const directory = copy(t);
  const file = join(directory, 'shared/v2/contracts.ts');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      '  actions: { id: string; label: string; primary?: boolean; confirm?: string }[];',
      '  actions: { id: string; label: string; primary?: boolean; confirm?: string; icon?: string }[];',
    ),
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /InboxItem\.actions\.icon \(Swift InboxAction\)/);
});

test('a new exported type must be mapped to Swift or marked as not decoded', (t) => {
  const directory = copy(t);
  const file = join(directory, 'shared/v2/contracts.ts');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport type Snooze = { until: string };\n`);
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Snooze has no Swift type/);
});

test('decoding a recorded gap in Swift asks for the gap to be removed', (t) => {
  const directory = copy(t);
  const file = join(
    directory,
    'native/Apple/Packages/DeployKit/Sources/DeployCore/V2Contracts.swift',
  );
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      'public struct ReleaseSource: Codable, Equatable, Sendable {\n    public var kind: ReleaseSourceKind',
      'public struct ReleaseSource: Codable, Equatable, Sendable {\n    public var commit: String?\n    public var kind: ReleaseSourceKind',
    ),
  );
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Swift now decodes Release\.source\.commit/);
});
