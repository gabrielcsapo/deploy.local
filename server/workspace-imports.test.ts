import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = join(root, 'server/workspace');

// Like kernel-imports.test.ts: include re-exports, side effects, types and literal dynamic imports.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

test('workspace boundary scan covers types, exports, side effects, dynamic imports and requires', () => {
  assert.deepEqual(
    imports(`
      import type { Source } from '../v2/types.ts';
      export * from '../v2/feature.ts';
      import '../packages/hooks.ts';
      const feature = import('../v2/design.ts');
      const legacy = require('../packages/store.ts');
      const loaded = createRequire(import.meta.url)('../v2/api.ts');
    `),
    [
      '../v2/types.ts',
      '../v2/feature.ts',
      '../packages/hooks.ts',
      '../v2/design.ts',
      '../packages/store.ts',
      '../v2/api.ts',
    ],
  );
});

const remainingV2: string[] = [];
// Package hooks deliberately have optional behavior in CLI/remote workers. Leave the package
// startup/credential/copy policy together until its process-specific composition is extracted.
const remainingPackages = [
  'check-runner.ts -> ../packages/builds.ts',
  'credentials.ts -> ../packages/keys.ts',
  'pipeline-worker.ts -> ../packages/pipelines.ts',
  'worker.ts -> ../packages/builds.ts',
  'worker.ts -> ../packages/hooks.ts',
];

function workspaceImports() {
  const result: { file: string; specifier: string; target: string }[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.[cm]?[jt]sx?$/.test(file) && !/\.test\./.test(file))
        for (const specifier of imports(readFileSync(file, 'utf8')))
          result.push({ file, specifier, target: resolve(dirname(file), specifier) });
    }
  }
  walk(workspace);
  return result;
}

for (const [feature, allowed] of [
  ['v2', remainingV2],
  ['packages', remainingPackages],
] as const)
  test(`workspace cannot add imports of ${feature} implementations`, () => {
    const actual = workspaceImports()
      .filter(({ target }) => target.startsWith(join(root, 'server', feature) + '/'))
      .map(({ file, specifier }) => `${relative(workspace, file)} -> ${specifier}`)
      .sort();
    assert.deepEqual(actual, [...allowed].sort());
  });

test('contracts contain types only and no feature imports', () => {
  const source = readFileSync(join(root, 'server/contracts/workspace-media.ts'), 'utf8');
  assert.deepEqual(imports(source), []);
  assert.doesNotMatch(source, /\b(?:function|const|let|class|enum)\b/);
});

// ESM evaluates static dependencies in source order. Compare with the original two worker
// imports, ignoring only the new, inert contract/port/composition modules. No process is run.
function evaluationOrder(entry: string, original: boolean) {
  const visited = new Set<string>();
  const order: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(
      /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"`]*?\s+from\s*)?['"]([^'"]+)['"]/gm,
    )) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const target = relative(root, resolve(root, dirname(file), specifier));
      if (original && target === 'server/main/local-worker-media.ts') {
        visit('server/v2/screenshots.ts');
        visit('server/v2/attachments.ts');
      } else if (existsSync(join(root, target))) visit(target);
    }
    if (
      ![
        'server/main/local-worker-media.ts',
        'server/workspace/media-ports.ts',
        'server/contracts/workspace-media.ts',
      ].includes(file)
    )
      order.push(file);
  }
  visit(entry);
  return { order, visited };
}

for (const entry of [
  'server/boot.ts',
  'server/workspace/repository-worker.ts',
  'server/workspace/pipeline-worker.ts',
  'server/workspace/worker.ts',
  'server/workspace/remote-worker.ts',
  'server/workspace/preview.ts',
  'bin/deploy.js',
])
  test(`${entry} preserves eager imports and wires only needed media ports`, () => {
    const actual = evaluationOrder(entry, false);
    assert.deepEqual(actual.order, evaluationOrder(entry, true).order);
    const local = entry === 'server/workspace/worker.ts';
    assert.equal(actual.visited.has('server/main/local-worker-media.ts'), local);
    assert.equal(actual.visited.has('server/workspace/media-ports.ts'), local);
    if (local) {
      const source = readFileSync(join(root, entry), 'utf8');
      const wire = source.indexOf('\nwireLocalWorkerMedia();');
      for (const call of [
        "requireScreenshotWorker('local worker')",
        "requireAttachmentBytesSource('local worker')",
        "claimWorker('local')",
        'recoverChecks();',
        'createServer(coordinationApi)',
        'setInterval(',
      ])
        assert.ok(wire >= 0 && wire < source.indexOf(call), call);
      const composition = readFileSync(join(root, 'server/main/local-worker-media.ts'), 'utf8');
      assert.match(composition, /registerScreenshotWorker\(screenshotWorker\)/);
      assert.match(composition, /registerAttachmentBytesSource\(attachmentBytes\)/);
    }
  });
