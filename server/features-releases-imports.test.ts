import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { root } from './test-import-graph.ts';

const directory = join(root, 'server/features/releases');
// Include types, re-exports, side effects, literal dynamic imports and CommonJS.
function imports(source: string) {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bcreateRequire\([^)]*\)\s*\(\s*)['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]);
}

// Exact exceptions retained by the pure move. An edge disappearing also requires review.
const workspaceOrigins = new Set<string>([
  'application-deployment.ts',
  'pipeline-deployment.ts',
  'pipelines.ts',
  'application-deployment-instructions.ts',
  'pipeline-triggers.ts',
]);
const exceptions: Record<string, string> = {
  'application-deployment.ts -> bin/bundle-files.mjs':
    'Existing archive file selection shared with the CLI; preserve checkpoint bundle contents.',
  'application-deployment.ts -> server/agent-upload.ts':
    'Existing scoped upload capabilities and ownership checks; preserve deployment admission.',
  'application-deployment.ts -> server/application-spec.ts':
    'Existing manifest compiler and types; preserve canonical digests and validation.',
  'application-deployment.ts -> server/secrets.ts':
    'Existing secret decryption and addresses; preserve deployment log redaction.',
  'application-deployment.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'application-deployment.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'application-deployment.ts -> tar-stream':
    'Existing streaming tar implementation; preserve source archive bytes and validation.',
  'pipeline-deployment.ts -> server/agent-upload.ts':
    'Existing scoped upload capabilities and ownership checks; preserve deployment admission.',
  'pipeline-deployment.ts -> server/application-spec.ts':
    'Existing manifest compiler and types; preserve canonical digests and validation.',
  'pipeline-deployment.ts -> server/ci-releases.ts':
    'Existing lazy CI credentials and release admission; preserve optional loading.',
  'pipeline-deployment.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'pipeline-deployment.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'pipeline-deployment.ts -> tar-stream':
    'Existing streaming tar implementation; preserve source archive bytes and validation.',
  'pipeline-triggers.ts -> server/packages/copies.ts':
    'Package hooks deliberately have optional behavior in CLI/remote workers; leave the package copy policy together until its process-specific composition is extracted.',
  'pipeline-triggers.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'pipelines.ts -> server/application-spec.ts':
    'Existing manifest compiler and types; preserve canonical digests and validation.',
  'pipelines.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'project-policy.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'project-policy.ts -> shared/v2/contracts.ts':
    'Existing public release and update types; preserve client contracts.',
  'project-removal.ts -> server/application-graph-executor.ts':
    'Existing graph execution and recovery; preserve project activation barriers.',
  'project-removal.ts -> server/application-spec.ts':
    'Existing manifest compiler and types; preserve canonical digests and validation.',
  'project-removal.ts -> server/docker-api.ts':
    'Existing Docker operations and error classification; preserve removal receipts.',
  'project-removal.ts -> server/docker.ts':
    'Existing legacy container removal; preserve project cleanup behavior.',
  'project-removal.ts -> server/graph-docker-adapter.ts':
    'Existing graph Docker adapter and types; preserve container and volume identities.',
  'project-removal.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'project-removal.ts -> server/v2/settings.ts':
    'Existing product dependency retained from v2; preserve release policy and evaluation order.',
  'project-removal.ts -> server/volumes.ts':
    'Existing application backup and volume paths; preserve retained data locations.',
  'project-removal.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'project-removal.ts -> shared/v2/contracts.ts':
    'Existing public release and update types; preserve client contracts.',
  'release-build-log.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'release-build-log.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'release-progress.ts -> shared/v2/contracts.ts':
    'Existing public release and update types; preserve client contracts.',
  'release-shared-data.ts -> server/application-spec.ts':
    'Existing manifest compiler and types; preserve canonical digests and validation.',
  'releases-fence.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'releases-journal.ts -> server/secrets.ts':
    'Existing secret key and encryption; preserve encrypted release journals.',
  'releases-plan.ts -> server/deploy-config.ts':
    'Existing deployment definition reader; preserve release manifest interpretation.',
  'releases-plan.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'releases-plan.ts -> shared/v2/contracts.ts':
    'Existing public release and update types; preserve client contracts.',
  'releases-remote.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'releases-remote.ts -> server/v2/releases-worker.ts':
    'Existing product dependency retained from v2; preserve release policy and evaluation order.',
  'releases-runtime.ts -> server/agent-graph-payload.ts':
    'Existing worker graph payload construction; preserve remote release jobs.',
  'releases-runtime.ts -> server/agent-graph-recording.ts':
    'Existing remote graph receipts; preserve materialization and activation records.',
  'releases-runtime.ts -> server/application-backups.ts':
    'Existing backup and restore operations; preserve pre-release data recovery.',
  'releases-runtime.ts -> server/application-configuration.ts':
    'Existing configuration resolution; preserve release configuration scope.',
  'releases-runtime.ts -> server/application-graph-executor.ts':
    'Existing graph execution and recovery; preserve project activation barriers.',
  'releases-runtime.ts -> server/application-runtime.ts':
    'Existing graph runtime builder; preserve release execution plans.',
  'releases-runtime.ts -> server/application-spec.ts':
    'Existing manifest compiler and types; preserve canonical digests and validation.',
  'releases-runtime.ts -> server/deploy-config.ts':
    'Existing deployment definition reader; preserve release manifest interpretation.',
  'releases-runtime.ts -> server/graph-docker-adapter.ts':
    'Existing graph Docker adapter and types; preserve container and volume identities.',
  'releases-runtime.ts -> server/graph-runtime-store.ts':
    'Existing durable graph state; preserve instance and endpoint publication order.',
  'releases-runtime.ts -> server/ipc.ts':
    'Existing route-change notification; preserve activation publication timing.',
  'releases-runtime.ts -> server/store.ts':
    'Existing engine records and bootstrap; preserve database evaluation order.',
  'releases-runtime.ts -> server/upload-archive.ts':
    'Existing source archive inspection; preserve release source validation.',
  'releases-runtime.ts -> server/v2/releases-worker.ts':
    'Existing product dependency retained from v2; preserve release policy and evaluation order.',
  'releases-runtime.ts -> server/v2/releases.ts':
    'Existing product dependency retained from v2; preserve release policy and evaluation order.',
  'releases-runtime.ts -> server/volumes.ts':
    'Existing application backup and volume paths; preserve retained data locations.',
  'releases-runtime.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
  'releases-runtime.ts -> shared/v2/contracts.ts':
    'Existing public release and update types; preserve client contracts.',
  'releases-upload.ts -> server/v2/releases-api.ts':
    'Existing product dependency retained from v2; preserve release policy and evaluation order.',
  'releases-upload.ts -> server/v2/releases.ts':
    'Existing product dependency retained from v2; preserve release policy and evaluation order.',
  'releases-upload.ts -> server/workspace/store.ts':
    'Existing workspace records, transactions and events; preserve bootstrap and record semantics.',
};

test('releases preserve origin boundaries and allow only reviewed dependencies', () => {
  const actual = new Set<string>();
  function files(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const file = join(folder, entry.name);
      return entry.isDirectory()
        ? files(file)
        : /\.[cm]?[jt]sx?$/.test(file) && !file.includes('.test.')
          ? [file]
          : [];
    });
  }
  for (const file of files(directory)) {
    const name = relative(directory, file);
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) {
        const edge = `${name} -> ${specifier}`;
        assert.ok(exceptions[edge], edge);
        actual.add(edge);
        continue;
      }
      let destination = resolve(dirname(file), specifier);
      // Follow compatibility forwards so a feature cannot conceal a forbidden import.
      const seen = new Set<string>();
      while (!seen.has(destination)) {
        seen.add(destination);
        const forward = readFileSync(destination, 'utf8')
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
          .trim()
          .match(/^export (?:\*|\{[^}]*\})\s+from ['"]([^'"]+)['"];\s*$/);
        if (!forward) break;
        destination = resolve(dirname(destination), forward[1]);
      }
      const target = relative(root, destination);
      for (const path of seen)
        assert.ok(
          !/^server\/(?:transports|api)(?:\/|\.ts$)/.test(relative(root, path)),
          `${name} -> ${relative(root, path)}`,
        );
      if (workspaceOrigins.has(name))
        for (const path of seen)
          assert.ok(!relative(root, path).startsWith('server/v2/'), `${name} -> ${path}`);
      // Existing dependency-free registration ports are an allowed boundary.
      const port = target.match(/^server\/workspace\/(.+)-port\.ts$/);
      if (port) {
        assert.deepEqual(imports(readFileSync(destination, 'utf8')), [
          `../contracts/${port[1]}.ts`,
        ]);
        continue;
      }
      if (/^server\/(?:kernel|contracts|features)\//.test(target)) continue;
      if (target === 'server/workspace/media-ports.ts') {
        assert.deepEqual(imports(readFileSync(destination, 'utf8')), [
          '../contracts/workspace-media.ts',
        ]);
        continue;
      }
      const edge = `${name} -> ${target}`;
      assert.ok(exceptions[edge], edge);
      actual.add(edge);
    }
  }
  assert.deepEqual([...actual].sort(), Object.keys(exceptions).sort());
});

test('releases boundary scanner includes every supported import form', () => {
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
