import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CoordinatorExecutor,
  coordinatorCommand,
  readCoordinatorManifest,
} from './coordinator-executor.ts';
const root = mkdtempSync('/tmp/coordinator-release-');
process.env.DEPLOY_DATA_DIR = join(root, 'data');
mkdirSync(process.env.DEPLOY_DATA_DIR);
const data = process.env.DEPLOY_DATA_DIR;
const { db, save, get } = await import('../workspace/store.ts');
const { ProjectReleaseService } = await import('./releases.ts');
const { SelfReleaseRuntime } = await import('./self-release-runtime.ts');
const store = await import('../store.ts');
after(() => {
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
const original = join(root, 'original.mjs');
writeFileSync(
  original,
  'process.send({ready:process.env.DEPLOY_COORDINATOR_VERSION});setInterval(()=>{},1000);',
);
writeFileSync(join(data, 'marker'), 'live');
const database = new DatabaseSync(join(data, 'example.db'));
database.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE original(value TEXT); INSERT INTO original VALUES('live');",
);
function build(version: string, options: { crash?: boolean; denied?: boolean } = {}) {
  const source = join(root, version);
  mkdirSync(source);
  const files: Record<string, string> = {
    'server.mjs': `process.send({ready:process.env.DEPLOY_COORDINATOR_VERSION});${options.crash ? 'setTimeout(()=>process.exit(7),40);' : 'setInterval(()=>{},1000);'}`,
    'verify.mjs': `import{readFileSync,writeFileSync}from'node:fs';import{DatabaseSync}from'node:sqlite';import{join}from'node:path';
const root=process.env.DEPLOY_DATA_DIR;
if(readFileSync(join(root,'marker'),'utf8')!=='live')throw Error('bad copy');
const db=new DatabaseSync(join(root,'example.db'));if(db.prepare('SELECT value FROM original').get().value!=='live')throw Error('bad database copy');db.close();
writeFileSync(join(root,'marker'),'verified copy');
${options.denied ? `readFileSync(${JSON.stringify(join(data, 'marker'))});` : ''}`,
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(source, path), text);
  writeFileSync(
    join(source, 'coordinator-build.json'),
    JSON.stringify({
      protocol: 1,
      version,
      dataCompatibility: 'unchanged',
      entry: 'server.mjs',
      verify: 'verify.mjs',
      files: Object.fromEntries(
        Object.entries(files).map(([path, text]) => [
          path,
          createHash('sha256').update(text).digest('hex'),
        ]),
      ),
    }),
  );
  return { source, ...readCoordinatorManifest(source) };
}
async function supervisor() {
  const child = spawn(
    process.execPath,
    [new URL('./coordinator-executor-fixture.mjs', import.meta.url).pathname, data, original],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let output = '';
  child.stderr!.on('data', (chunk) => {
    output += chunk;
  });
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => {
      throw new Error(output);
    }),
  ]);
  return async () => {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await stopped;
  };
}
test('external executor verifies a copied SQLite directory, switches fake coordinators, recovers v2 activation and rolls back', async () => {
  const stop = await supervisor();
  try {
    const firstPid = JSON.parse(readFileSync(join(data, 'running.json'), 'utf8')).pid;
    const candidate = build('new');
    await coordinatorCommand(data, 'prepare', {
      id: 'good',
      source: candidate.source,
      digest: candidate.digest,
    });
    await assert.rejects(coordinatorCommand(data, 'activate', { id: 'good' }), /verify/);
    await coordinatorCommand(data, 'verify', { id: 'good' });
    assert.equal(readFileSync(join(data, 'marker'), 'utf8'), 'live');
    assert.equal(database.prepare('SELECT value FROM original').get()!.value, 'live');
    const plan = {
      apps: [{ appId: 'deploy.local', to: 'new' }],
      migrations: [],
      runtime: {
        kind: 'coordinator-self-release',
        id: 'good',
        version: 'new',
        source: candidate.source,
        digest: candidate.digest,
      },
    };
    const project = {
      id: 'project',
      name: 'deploy.local',
      apps: [{ id: 'deploy.local', name: 'deploy.local', kind: 'web' }],
    };
    save('v2-release', 'owner', {
      id: 'release',
      project,
      plan,
      release: {
        id: 'release',
        projectId: 'project',
        source: { kind: 'ship', ref: 'new' },
        startedBy: 'owner',
        apps: plan.apps,
        migrations: [],
        state: 'running',
        steps: ['prepare', 'verify', 'activate', 'watch'].map((name) => ({
          name,
          state: ['prepare', 'verify'].includes(name)
            ? 'done'
            : name === 'activate'
              ? 'running'
              : 'waiting',
        })),
      },
    });
    save('v2-project-run', 'owner', { id: 'project', operationId: 'release' });
    assert.equal((await coordinatorCommand(data, 'activate', { id: 'good' })).state, 'activated');
    assert.notEqual(JSON.parse(readFileSync(join(data, 'running.json'), 'utf8')).pid, firstPid);
    process.env.DEPLOY_COORDINATOR_RELEASE = 'good';
    await new ProjectReleaseService(new SelfReleaseRuntime(), { watchMs: 1 }).recover();
    assert.equal(get('v2-release', 'owner', 'release').release.state, 'live');
    assert.equal(get('v2-project-current', 'owner', 'project').releaseId, 'release');
    assert.equal(get('v2-coordinator-activation', 'system', 'good').state, 'activated');
    assert.equal((await coordinatorCommand(data, 'rollback', { id: 'good' })).state, 'aborted');
    assert.equal(JSON.parse(readFileSync(join(data, 'running.json'), 'utf8')).version, 'old');
  } finally {
    await stop();
  }
});
test('bad checksums, live-directory access, and long-running startup failure keep the old coordinator', async () => {
  const stop = await supervisor();
  try {
    const corrupt = build('corrupt');
    writeFileSync(join(corrupt.source, 'server.mjs'), 'changed');
    await assert.rejects(
      coordinatorCommand(data, 'prepare', {
        id: 'corrupt',
        source: corrupt.source,
        digest: corrupt.digest,
      }),
      /checksum/,
    );
    const denied = build('denied', { denied: true });
    await coordinatorCommand(data, 'prepare', {
      id: 'denied',
      source: denied.source,
      digest: denied.digest,
    });
    await assert.rejects(
      coordinatorCommand(data, 'verify', { id: 'denied' }),
      /verification failed/,
    );
    const bad = build('bad', { crash: true });
    await coordinatorCommand(data, 'prepare', {
      id: 'bad',
      source: bad.source,
      digest: bad.digest,
    });
    await coordinatorCommand(data, 'verify', { id: 'bad' });
    const receipt = await coordinatorCommand(data, 'activate', { id: 'bad' });
    assert.equal(receipt.state, 'aborted');
    assert.match(receipt.error!, /startup/);
    assert.equal(JSON.parse(readFileSync(join(data, 'running.json'), 'utf8')).version, 'old');
    const unauthorized = createConnection(join(data, 'coordinator-updates', 'switch.sock'));
    unauthorized.write(JSON.stringify({ key: 'wrong', action: 'activate', id: 'bad' }) + '\n');
    let response = '';
    unauthorized.on('data', (chunk) => {
      response += chunk;
    });
    await once(unauthorized, 'end');
    assert.match(response, /Invalid supervisor credential/);
  } finally {
    await stop();
    database.close();
  }
});
test('unconfirmed activation recovers to the original entry and build symlinks are refused', async () => {
  const executor = new CoordinatorExecutor({
    root: data,
    entry: original,
    switchBuild: async () => {},
  });
  const candidate = build('interrupted');
  const receipt = await executor.prepare('interrupted', candidate.source, candidate.digest);
  receipt.state = 'starting';
  executor.persist(receipt);
  await executor.recover();
  assert.equal(executor.receipt('interrupted').state, 'aborted');
  assert.equal(executor.currentEntry, original);
  const linked = build('linked');
  rmSync(join(linked.source, 'server.mjs'));
  symlinkSync(original, join(linked.source, 'server.mjs'));
  await assert.rejects(executor.prepare('linked', linked.source, linked.digest), /symlinks/);
});
