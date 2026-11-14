import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import type { GraphDockerAdapter } from './graph-docker-adapter.ts';

const temporary = mkdtempSync('/tmp/backup-provider-scope-');
const home = join(temporary, 'home');
process.env.DEPLOY_DATA_DIR = home;
process.env.DEPLOY_RELEASE_CONFIG = join(temporary, 'no-release-config.json');
const providers = await import('./backups/providers.ts');
const store = await import('./store.ts');
const { _resetDb: resetStore } = store;
const workspaceStore = await import('./workspace/store.ts');
const {
  createApplicationProvider,
  createDirectoryProvider,
  createHomeProvider,
  createOfflineWorkspaceProvider,
  createSelfUpdateProvider,
} = providers;
const { maintenance } = await import('./maintenance.ts');
const { wireBackupCatalog } = await import('./main/backups.ts');
const { loadOrCreateSecretKey } = await import('./secrets.ts');
const { ensureLocalIdentity } = await import('./local-site.ts');
const { ensureCerts } = await import('./certs.ts');
const { getRequestsSqlite } = await import('./requests-db.ts');
const { checkpointBlobPath } = await import('./workspace/checkpoint-storage.ts');
const { compileDeployYaml } = await import('./application-spec.ts');
const { buildApplicationGraphRuntime } = await import('./application-runtime.ts');
const { ApplicationGraphExecutor } = await import('./application-graph-executor.ts');
const { graphVolumeName } = await import('./graph-docker-adapter.ts');

function file(path: string, content = path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function tables(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
  } finally {
    database.close();
  }
}
function databaseScope(source: string, copy: string) {
  assert.deepEqual(tables(copy), tables(source), copy);
  const database = new Database(copy, { readonly: true });
  try {
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(database.prepare('SELECT * FROM scope_probe').all(), [
      { id: 1, value: 'committed WAL bytes' },
    ]);
  } finally {
    database.close();
  }
}
function seedDatabase(database: Database.Database) {
  database.pragma('journal_mode = WAL');
  database.pragma('wal_autocheckpoint = 0');
  database.exec(
    "CREATE TABLE scope_probe(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO scope_probe VALUES(1, 'committed WAL bytes')",
  );
}
seedDatabase(store.getSqlite()!);
seedDatabase(workspaceStore.db);
seedDatabase(getRequestsSqlite());
loadOrCreateSecretKey();
ensureLocalIdentity();
ensureCerts();
workspaceStore.save('checkpoint', 'owner', {
  id: 'scope',
  snapshot: {
    files: [{ path: 'work.txt', content: 'checkpoint contents' }],
    excluded: [],
    digest: 'scope',
  },
});
const checkpoint = workspaceStore.get('checkpoint', 'owner', 'scope');
const checkpointPath = checkpointBlobPath(workspaceStore.root, checkpoint.snapshotBlob);
const durableFiles = [
  'workspace/repositories/probe.git/HEAD',
  'workspace/repositories/probe.git/lfs/objects/asset',
  'workspace/tasks/probe/dirty.txt',
  'workspace/attachments/probe',
  'workspace/spool/probe',
  'volumes/probe/data/value',
  'volumes/probe/uploads/file',
  'packages/hosted/probe',
  'project-releases/journals/probe.json',
  'ssh_host_ed25519_key',
];
for (const path of durableFiles) file(join(home, path));
file(join(home, 'packages/cache/probe'));
file(join(home, 'packages/tmp/probe'));
wireBackupCatalog({ selfUpdateStateDirectory: join(temporary, 'update-state') });

after(() => {
  store.saveBackupSettings({ enabled: false, destination: '', cron: '0 0 * * *' });
  resetStore();
  workspaceStore.db.close();
  rmSync(temporary, { recursive: true, force: true });
  delete process.env.DEPLOY_DATA_DIR;
  delete process.env.DEPLOY_RELEASE_CONFIG;
});

test('app provider scope matches real legacy tar entries and real graph executor volume archives', async () => {
  const provider = createApplicationProvider();
  const legacy = await provider.capture.run({ name: 'probe' });
  const archive = join(home, 'backups/probe', legacy.filename);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .sort();
  assert.deepEqual(entries, ['data/', 'data/value', 'uploads/', 'uploads/file']);
  assert.equal(provider.verify.supported, false);

  const compiled = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/web:1
resources:
  database:
    type: volume
    backup: { policy: required, retentionCopies: 3 }
  uploads:
    type: volume
    backup: { policy: include, retentionCopies: 2 }
  cache:
    type: volume
    durability: ephemeral
    backup: { policy: exclude, retentionCopies: 0 }
`);
  const runtime = buildApplicationGraphRuntime({
    applicationId: 'scope-app',
    specDigest: compiled.digest,
    spec: compiled.spec,
    configuration: { digest: 'sha256:configuration', values: {}, missing: [] },
  });
  const volumes = new Map<string, string>();
  for (const resource of ['database', 'uploads', 'cache']) {
    const path = join(temporary, 'docker-volumes', resource);
    file(join(path, 'bytes'), resource);
    volumes.set(graphVolumeName('scope-app', resource), path);
  }
  // Only Docker transport is replaced: the production executor selects resources, writes its
  // manifest, verifies real tar archives/digests, and rejects a failed archive.
  let breakArchive = false;
  const docker = {
    async exportVolume(name: string, target: string) {
      execFileSync('tar', ['-czf', target, '-C', volumes.get(name)!, '.']);
      const bytes = readFileSync(target);
      return {
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes: bytes.length,
      };
    },
    async verifyVolumeArchive(path: string) {
      execFileSync('tar', ['-tzf', path]);
      return !breakArchive;
    },
  } as GraphDockerAdapter;
  const executor = new ApplicationGraphExecutor({ docker });
  executor.converge = async () => {
    throw new Error('fixture has no running graph');
  };
  const options = {
    manifestFormat: () => 'deploy.yaml' as const,
    graphRuntime: () => runtime,
    executor: {
      createRecoveryPoint: (
        context: Parameters<typeof executor.createRecoveryPoint>[0],
        destination: string,
      ) => executor.createRecoveryPoint(context, destination, { resume: false }),
      restoreRecoveryPoint: executor.restoreRecoveryPoint.bind(executor),
      converge: executor.converge.bind(executor),
    },
  };
  const result = await provider.capture.run(
    { name: 'graph-probe', appId: 'scope-app', activeSpecDigest: compiled.digest },
    null,
    options,
  );
  const directory = join(home, 'backups/graph-probe', result.filename);
  const manifest = JSON.parse(readFileSync(join(directory, 'recovery-manifest.json'), 'utf8'));
  assert.equal(provider.scope.volumes, 'application-format');
  assert.deepEqual(manifest.resources.map((row: { resource: string }) => row.resource).sort(), [
    'database',
    'uploads',
  ]);
  assert.equal(readdirSync(directory).length, 3);
  for (const resource of manifest.resources) {
    assert.equal(
      execFileSync('tar', ['-xOzf', join(directory, resource.archive), './bytes'], {
        encoding: 'utf8',
      }),
      resource.resource,
    );
  }
  breakArchive = true;
  await assert.rejects(
    provider.capture.run({ name: 'graph-failure', appId: 'scope-app' }, null, options),
    /unreadable/,
  );
});

test('directory provider captures declared databases, Git, blobs, keys and in-tree volumes, with existing exclusions', async () => {
  const provider = createDirectoryProvider(maintenance.runBackup);
  const drive = join(temporary, 'drive');
  file(join(drive, '.deploy-backup-destination'), 'fixture');
  store.saveBackupSettings({ enabled: true, destination: drive, cron: '0 0 * * *' });
  const result = await provider.capture.run();
  assert.equal(result.success, true, result.error ?? 'directory capture failed');
  const copies = await provider.list.run(drive);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].complete, true);
  for (const database of provider.scope.databases)
    databaseScope(join(home, database.path), join(copies[0].path, database.storedAs));
  for (const path of [...durableFiles, 'secrets/master.key', 'certs/ca.key', 'certs/ca.crt'])
    assert.deepEqual(
      readFileSync(join(copies[0].path, path)),
      readFileSync(join(home, path)),
      path,
    );
  const filePaths = (root: string, prefix = ''): string[] =>
    readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filePaths(root, path) : [path];
    });
  const excluded = (path: string) =>
    provider.scope.excluded.some((rule) =>
      rule.endsWith('/') ? path.startsWith(rule) : path === rule,
    );
  const expected = [
    ...filePaths(home).filter((path) => !excluded(path)),
    ...provider.scope.databases.map((row) => row.storedAs),
  ].sort();
  assert.deepEqual(
    filePaths(copies[0].path)
      .filter((path) => path !== '.deploy-backup-complete')
      .sort(),
    expected,
  );
  assert.deepEqual(provider.scope.files, [{ path: '.', selection: 'tree' }]);
  const blob = checkpointPath.slice(workspaceStore.root.length + 1);
  assert.deepEqual(
    readFileSync(join(copies[0].path, 'workspace', blob)),
    readFileSync(checkpointPath),
  );
  for (const path of [
    'packages/cache/probe',
    'packages/tmp/probe',
    ...provider.scope.databases.map((row) => row.path),
  ])
    assert.equal(existsSync(join(copies[0].path, path)), false, path);
  assert.equal(provider.verify.supported, false);
  assert.equal(provider.restore.supported, false);
});

test('Home provider captures its declared tables, referenced blobs, keys and optional trees, and preserves restore refusals', async () => {
  const provider = createHomeProvider();
  const source =
    'apiVersion: deploy.local/v1\nkind: Application\ncomponents:\n  web:\n    image: example/web:1\n';
  const compiled = compileDeployYaml(source);
  store.saveDeployment({ name: 'revision-probe', username: 'owner' });
  store.saveDesiredApplicationSpec({
    digest: compiled.digest,
    deploymentName: 'revision-probe',
    apiVersion: 'deploy.local/v1',
    source: 'repository',
    manifestFormat: 'deploy.yaml',
    normalizedSpec: compiled.canonicalJson,
    originalSource: source,
    createdBy: 'owner',
  });
  file(join(home, 'certificates/legacy.key'), 'legacy certificate');
  file(join(home, 'secrets/ignored.tmp'), 'incomplete');
  const outputPath = join(temporary, 'bundle.json');
  const passphrase = 'scope fixture passphrase';
  const bundle = await provider.capture.run({ outputPath, passphrase });
  assert.equal(bundle.receipt.hostedPackages.included, true);
  const bundlePath = outputPath;
  await provider.verify.run({ bundlePath, passphrase, bundleId: bundle.id });
  await assert.rejects(
    provider.restore.run({ bundlePath, passphrase, destinationDataDirectory: home }),
    /Online in-place restore/,
  );
  const destination = join(temporary, 'home-restored');
  await provider.restore.run({ bundlePath, passphrase, destinationDataDirectory: destination });
  for (const database of provider.scope.databases)
    databaseScope(join(home, database.path), join(destination, database.storedAs));
  const walk = (root: string): string[] =>
    readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)],
    );
  for (const declaration of provider.scope.files.filter((row) => row.selection === 'tree')) {
    const materialRoot = join(home, declaration.path);
    if (!existsSync(materialRoot)) continue;
    for (const path of walk(materialRoot).filter((candidate) => !candidate.endsWith('.tmp')))
      assert.deepEqual(
        readFileSync(join(destination, path.slice(home.length + 1))),
        readFileSync(path),
        path,
      );
  }
  assert.deepEqual(
    readFileSync(join(destination, checkpointPath.slice(home.length + 1))),
    readFileSync(checkpointPath),
  );
  const artifacts = store
    .getSqlite()!
    .prepare(
      'SELECT digest, local_path FROM artifacts WHERE digest IN (SELECT original_artifact_digest FROM application_spec_revisions UNION SELECT normalized_artifact_digest FROM application_spec_revisions)',
    )
    .all() as { digest: string; local_path: string }[];
  assert.ok(artifacts.length >= 1);
  for (const artifact of artifacts) {
    const hash = artifact.digest.slice('sha256:'.length);
    assert.deepEqual(
      readFileSync(join(destination, 'blobs/sha256', hash.slice(0, 2), hash)),
      readFileSync(artifact.local_path),
    );
  }
  assert.equal(existsSync(join(destination, 'secrets/ignored.tmp')), false);
  assert.deepEqual(
    readFileSync(join(destination, 'ssh_host_ed25519_key')),
    readFileSync(join(home, 'ssh_host_ed25519_key')),
  );
  for (const path of [
    'workspace/repositories',
    'workspace/tasks',
    'workspace/attachments',
    'volumes',
    'packages/cache',
    'packages/tmp',
  ])
    assert.equal(existsSync(join(destination, path)), false, path);
  await assert.rejects(
    provider.restore.run({ bundlePath, passphrase, destinationDataDirectory: destination }),
    /must be empty/,
  );
});

test('offline workspace provider captures every table/file in its boundary and retains path and enrollment boundaries', async () => {
  const provider = createOfflineWorkspaceProvider();
  const source = join(temporary, 'offline-workspace');
  mkdirSync(source);
  const database = new Database(join(source, 'workspace.db'));
  database.exec(
    'CREATE TABLE records(kind TEXT,id TEXT,owner TEXT,data TEXT); CREATE TABLE worker(pid INTEGER)',
  );
  seedDatabase(database);
  database
    .prepare('INSERT INTO records VALUES(?,?,?,?)')
    .run('worker-credential', 'worker', 'owner', '{}');
  database.close();
  for (const path of [
    'repositories/repo.git/HEAD',
    'repositories/repo.git/lfs/objects/asset',
    'tasks/task/dirty',
    'attachments/asset',
    'spool/output',
  ])
    file(join(source, path));
  const destination = join(temporary, 'workspace-snapshot');
  await provider.capture.run(source, destination);
  const manifest = await provider.verify.run(destination);
  assert.deepEqual(provider.scope.files, [{ path: '.', selection: 'tree' }]);
  assert.deepEqual(
    provider.scope.databases.map((row) => row.path),
    ['workspace.db'],
  );
  databaseScope(join(source, 'workspace.db'), join(destination, 'workspace.db'));
  for (const entry of manifest.entries.filter(
    (candidate) => candidate.type === 'file' && candidate.path !== 'workspace.db',
  ))
    assert.deepEqual(
      readFileSync(join(source, entry.path)),
      readFileSync(join(destination, entry.path)),
    );
  await assert.rejects(
    provider.restore.run(destination, join(temporary, 'relocated')),
    /original workspace path/,
  );
  await assert.rejects(provider.restore.run(destination, source), /must not exist/);
  renameSync(source, join(temporary, 'old-workspace'));
  await provider.restore.run(destination, source);
  const restored = new Database(join(source, 'workspace.db'));
  assert.deepEqual(
    restored.prepare("SELECT * FROM records WHERE kind='worker-credential'").all(),
    [],
  );
  restored.close();
  file(join(destination, 'attachments/asset'), 'changed');
  await assert.rejects(provider.verify.run(destination), /verification failed/);
  assert.equal(provider.list.supported, false);
});

test('self-update provider copies exactly the declared database tables with the existing names and retention', async () => {
  const provider = createSelfUpdateProvider();
  const source = join(temporary, 'self-update-home');
  mkdirSync(join(source, 'backups'), { recursive: true });
  mkdirSync(join(source, 'workspace'));
  const databases = provider.scope.databases.map((declaration) => {
    const database = new Database(join(source, declaration.path));
    seedDatabase(database);
    database.exec('CREATE TABLE extra_table(payload BLOB)');
    return database;
  });
  try {
    for (const revision of ['1111111', '2222222', '3333333', '4444444'])
      await provider.capture.run(source, revision);
    const copies = provider.list.run(source);
    assert.equal(copies.length, 6);
    assert.equal(
      copies.some((copy) => copy.name.startsWith('self-update-1111111')),
      false,
    );
    for (const database of provider.scope.databases) {
      const name = database.storedAs.replace('<sha7>', '4444444');
      databaseScope(join(source, database.path), join(source, 'backups', name));
    }
  } finally {
    for (const database of databases) database.close();
  }
  assert.equal(provider.scope.files.length, 0);
  assert.equal(provider.scope.volumes, 'none');
  assert.equal(provider.verify.supported, false);
  assert.equal(provider.restore.supported, false);
});

test('catalog preserves raw reader values and ordering, isolates unavailable providers and exposes no restore', async () => {
  const catalog = wireBackupCatalog({ selfUpdateStateDirectory: join(temporary, 'update-state') });
  const { requireBackupAccess } = await import('./backups/port.ts');
  assert.deepEqual(
    requireBackupAccess('fixture').application.list.run('probe'),
    store.getBackups('probe'),
  );
  assert.deepEqual(
    requireBackupAccess('fixture').home.list.run(),
    store
      .getSqlite()!
      .prepare('SELECT * FROM fleet_recovery_bundles ORDER BY created_at DESC')
      .all(),
  );
  assert.equal('restore' in catalog, false);
  store.saveBackupSettings({
    enabled: true,
    destination: join(temporary, 'unmounted'),
    cron: '12 3 * * *',
  });
  const inventory = await catalog.inventory();
  assert.equal(inventory.length, 5);
  assert.match(inventory.find((row) => row.provider === 'directory-copy')!.unavailable!, /ENOENT/);
  assert.ok(inventory.find((row) => row.provider === 'home-bundle')!.holdings!.length);
  assert.equal(
    catalog.schedules().find((row) => row.provider === 'directory-copy')!.cron,
    '12 3 * * *',
  );
});
