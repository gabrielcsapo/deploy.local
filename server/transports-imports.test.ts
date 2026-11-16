import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const transports = join(root, 'server/transports');
// Include types, re-exports, side effects, literal dynamic imports and CommonJS.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

function files(folder: string, tests = false): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = join(folder, entry.name);
    return entry.isDirectory()
      ? files(file, tests)
      : /\.[cm]?[jt]sx?$/.test(file) && (tests || !file.includes('.test.'))
        ? [file]
        : [];
  });
}

// Follow compatibility forwards so an import cannot conceal where it really lands.
function chain(file: string, specifier: string) {
  let destination = resolve(dirname(file), specifier);
  const seen: string[] = [];
  while (!seen.includes(destination)) {
    seen.push(destination);
    const forward = readFileSync(destination, 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      .trim()
      .match(/^export (?:\*|\{[^}]*\})\s+from ['"]([^'"]+)['"];\s*$/);
    if (!forward) break;
    destination = resolve(dirname(destination), forward[1]);
  }
  return seen.map((path) => relative(root, path));
}

test('kernel and features never import transports', () => {
  const violations: string[] = [];
  for (const folder of ['server/kernel', 'server/features'])
    for (const file of files(join(root, folder), true))
      for (const specifier of imports(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('.')) continue;
        // Tests may reach a transport through an old compatibility path; production may not.
        const path = file.includes('.test.')
          ? [relative(root, resolve(dirname(file), specifier))]
          : chain(file, specifier);
        for (const target of path)
          if (target.startsWith('server/transports/'))
            violations.push(`${relative(root, file)} -> ${target}`);
      }
  assert.deepEqual(violations, []);
});

// Transports may import features, kernel, contracts, ports and each other freely. Every other
// target is an exact edge retained by the pure move. An edge disappearing also requires review.
const allowed: Record<string, { reason: string; edges: string[] }> = {
  engineStore: {
    reason: 'Existing engine records and bootstrap; preserve database evaluation order.',
    edges: [
      'v2/auth.ts -> server/store.ts',
      'v2/dashboard-page.ts -> server/store.ts',
      'v2/diagnostics.ts -> server/store.ts',
      'v2/performance.ts -> server/store.ts',
      'v2/project-page.ts -> server/store.ts',
      'v2/requests.ts -> server/store.ts',
      'workspace/terminal-socket.ts -> server/store.ts',
    ],
  },
  workspaceStore: {
    reason:
      'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
    edges: [
      'v2/dashboard-page.ts -> server/workspace/store.ts',
      'v2/project-page.ts -> server/workspace/store.ts',
      'v2/pull-files.ts -> server/workspace/store.ts',
      'v2/push.ts -> server/workspace/store.ts',
      'v2/requests.ts -> server/workspace/store.ts',
      'v2/search.ts -> server/workspace/store.ts',
      'workspace/api.ts -> server/workspace/store.ts',
      'workspace/coordination-api.ts -> server/workspace/store.ts',
      'workspace/recording-upload.ts -> server/workspace/store.ts',
    ],
  },
  sharedContracts: {
    reason: 'Existing public client contracts and address parsing; preserve response shapes.',
    edges: [
      'v2/logs.ts -> shared/v2/contracts.ts',
      'v2/project-page.ts -> shared/v2/contracts.ts',
      'v2/push.ts -> shared/v2/contracts.ts',
      'v2/requests.ts -> shared/v2/contracts.ts',
      'workspace/api.ts -> shared/repository-address.ts',
      'workspace/api.ts -> shared/v2/contracts.ts',
    ],
  },
  workspaceDomain: {
    reason:
      'Workspace task, worker and attachment services not yet in a feature folder; preserve their behavior.',
    edges: [
      'workspace/api.ts -> server/workspace/attachments.ts',
      'workspace/api.ts -> server/workspace/credentials.ts',
      'workspace/api.ts -> server/workspace/event-feed.ts',
      'workspace/api.ts -> server/workspace/managed-worker.ts',
      'workspace/api.ts -> server/workspace/protocol.ts',
      'workspace/api.ts -> server/workspace/run-queue.ts',
      'workspace/api.ts -> server/workspace/service.ts',
      'workspace/api.ts -> server/workspace/shell-commands.ts',
      'workspace/coordination-api.ts -> server/workspace/attachments.ts',
      'workspace/coordination-api.ts -> server/workspace/checkpoint-commit.ts',
      'workspace/recording-upload.ts -> server/workspace/attachments.ts',
      'workspace/terminal-socket.ts -> server/workspace/credentials.ts',
      'v2/dashboard-page.ts -> server/workspace/service.ts',
    ],
  },
  v2Product: {
    reason:
      'v2 product and auth modules not yet in a feature folder or the kernel; preserve their behavior.',
    edges: [
      'v2/auth.ts -> server/v2/auth-cli.ts',
      'v2/auth.ts -> server/v2/auth-passkey.ts',
      'v2/auth.ts -> server/v2/auth-store.ts',
      'v2/auth.ts -> server/v2/devices.ts',
      'v2/auth.ts -> server/v2/setup.ts',
      'v2/dashboard-page.ts -> server/v2/design.ts',
      'v2/dashboard-page.ts -> server/v2/devices.ts',
      'v2/dashboard-page.ts -> server/v2/releases.ts',
      'v2/dashboard-page.ts -> server/v2/settings.ts',
      'v2/dashboard-page.ts -> server/v2/tasks.ts',
      'v2/project-page.ts -> server/v2/releases.ts',
      'v2/project-page.ts -> server/v2/settings.ts',
      'v2/projects-api.ts -> server/v2/settings.ts',
      'v2/pull-files.ts -> server/v2/attachments.ts',
      'v2/push.ts -> server/v2/devices.ts',
      'v2/search.ts -> server/v2/attachments.ts',
    ],
  },
  requestTelemetry: {
    reason: 'Existing request log, capture and edge telemetry storage; preserve recorded rows.',
    edges: [
      'v2/performance.ts -> server/requests-db.ts',
      'v2/performance.ts -> server/telemetry.ts',
      'v2/project-page.ts -> server/requests-db.ts',
      'v2/project-page.ts -> server/telemetry.ts',
      'v2/requests.ts -> server/capture.ts',
      'v2/requests.ts -> server/requests-db.ts',
    ],
  },
  dashboardSeed: {
    reason:
      'The dashboard page seed reads engine, catalog and package handlers directly; preserve seeded resources.',
    edges: [
      'v2/dashboard-page.ts -> server/api/catalog.ts',
      'v2/dashboard-page.ts -> server/api/fleet.ts',
      'v2/dashboard-page.ts -> server/catalog/handler.ts',
      'v2/dashboard-page.ts -> server/desktop-download.ts',
      'v2/dashboard-page.ts -> server/packages/api.ts',
      'v2/dashboard-page.ts -> server/packages/copies.ts',
      'v2/dashboard-page.ts -> server/packages/keys.ts',
      'v2/dashboard-page.ts -> server/packages/npm.ts',
    ],
  },
  engineModules: {
    reason: 'Existing manifest compiler and content store; preserve validation and stored bytes.',
    edges: [
      'v2/pull-files.ts -> server/content-store.ts',
      'v2/start.ts -> server/application-spec.ts',
    ],
  },
  packages: {
    reason: 'Existing third-party parsers and the WebSocket server; preserve wire behavior.',
    edges: ['v2/start.ts -> yaml', 'workspace/terminal-socket.ts -> ws'],
  },
};

test('transports allow only reviewed dependencies outside features, kernel and contracts', () => {
  const expected = Object.values(allowed).flatMap(({ edges }) => edges);
  assert.equal(new Set(expected).size, expected.length, 'an edge is listed in two groups');
  const actual = new Set<string>();
  for (const file of files(transports)) {
    const name = relative(transports, file);
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) {
        actual.add(`${name} -> ${specifier}`);
        continue;
      }
      const target = chain(file, specifier).at(-1)!;
      if (/^server\/(?:kernel|features|contracts|transports)\//.test(target)) continue;
      if (/^server\/.+-port\.ts$/.test(target)) continue;
      actual.add(`${name} -> ${target}`);
    }
  }
  assert.deepEqual([...actual].sort(), expected.sort());
});

test('transports boundary scanner includes every supported import form', () => {
  assert.deepEqual(
    imports(`
    import type { A } from '../v2/a.ts';
    export * from '../transports/a.ts';
    import '../features/tasks/a.ts';
    const a = import('../v2/b.ts');
    const b = require('../transports/b.ts');
    const c = createRequire(import.meta.url)('../v2/c.ts');
  `),
    [
      '../v2/a.ts',
      '../transports/a.ts',
      '../features/tasks/a.ts',
      '../v2/b.ts',
      '../transports/b.ts',
      '../v2/c.ts',
    ],
  );
});
