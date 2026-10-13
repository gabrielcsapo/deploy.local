import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'ci-release-store-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('./store.ts');
const ci = await import('./ci-releases.ts');
const { compileDeployYaml } = await import('./application-spec.ts');
const manifest = `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: notes
components:
  web:
    build:
      context: .
    role: web
    interfaces:
      http:
        port: 3000
        protocol: http
    health:
      interface: http
      path: /health
routes:
  public:
    to: web.http
`;
const graph = compileDeployYaml(manifest);
store.registerUser('alice', 'synthetic-password');
store.registerUser('bob', 'synthetic-password');
function target(name = 'notes') {
  store.saveDeployment({
    name,
    username: 'alice',
    containerId: 'old-container',
    containerName: 'deploy-sh-notes-web',
    port: 3000,
    type: 'application-graph',
  });
  store.saveDesiredApplicationSpec({
    deploymentName: name,
    digest: graph.digest,
    apiVersion: graph.spec.apiVersion,
    source: 'repository',
    manifestFormat: 'deploy.yaml',
    normalizedSpec: graph.canonicalJson,
    originalSource: manifest,
    createdBy: 'alice',
  });
  store.activateDesiredApplicationSpec(name, graph.digest);
  store.updateDeploymentArtifactDigests(name, { sourceArtifactDigest: 'sha256:' + '0'.repeat(64) });
  store.updateDeploymentStatus(name, 'running');
}
target();
const created = ci.issueCiCredential('alice', 'notes', 3600);
const credential = ci.authenticateCi(created.token);
const runtime = { containerId: 'old-container', imageDigest: 'sha256:' + '0'.repeat(64) };
const reserve = (input: Parameters<typeof ci.reserveCiRelease>[1]) =>
  ci.reserveCiRelease(credential, input, runtime);
const intent = (key: string) => ({
  application: 'notes',
  sourceCommit: 'a'.repeat(40),
  sourceDigest: 'sha256:' + '1'.repeat(64),
  sourceArchiveDigest: 'sha256:' + '2'.repeat(64),
  idempotencyKey: key,
  expectedRelease: ci.ciHead(credential).releaseId,
});
after(() => {
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
test('CI secrets are hashed, scoped, expiring and individually revocable; account authentication rejects them', () => {
  assert.equal(store.authenticate('alice', created.token), false);
  assert.throws(() => ci.issueCiCredential('bob', 'notes', 3600), /not found/);
  assert.throws(() => ci.issueCiCredential('alice', 'notes', 31 * 86400), /Expiry/);
  const raw = store
    .getSqlite()!
    .prepare('select token_hash from ci_credentials where id=?')
    .get(created.id) as { token_hash: string };
  assert.notEqual(raw.token_hash, created.token);
  assert.equal(raw.token_hash.length, 64);
  const other = ci.issueCiCredential('alice', 'notes', 60);
  ci.revokeCiCredential(other.id, 'alice');
  assert.throws(() => ci.authenticateCi(other.token), /Unauthorized/);
  const expired = ci.issueCiCredential('alice', 'notes', 60);
  store.getSqlite()!.prepare('update ci_credentials set expires_at=0 where id=?').run(expired.id);
  assert.throws(() => ci.authenticateCi(expired.token), /Unauthorized/);
  assert.throws(() => ci.revokeCiCredential(created.id, 'bob'), /not found/);
});
test('durable CAS and retry key bind exact commit, both byte digests and predecessor', () => {
  const input = intent('same');
  const r = reserve(input);
  assert.equal(reserve(input).id, r.id);
  for (const changed of [
    { sourceCommit: 'b'.repeat(40) },
    { sourceDigest: 'sha256:' + '3'.repeat(64) },
    { sourceArchiveDigest: 'sha256:' + '4'.repeat(64) },
    { expectedRelease: 'stale' },
  ])
    assert.throws(() => reserve({ ...input, ...changed }), /conflicts/);
  assert.throws(() => reserve({ ...input, idempotencyKey: 'competitor' }), /reservation/);
  assert.throws(() => reserve({ ...input, application: 'other' }), /Invalid/);
  ci.claimCiUpload(r.id, credential);
  assert.throws(() => ci.claimCiUpload(r.id, credential), /claimed/);
  ci.finishCiRelease(r.id, null);
  assert.equal(ci.ciReceipt(ci.ciRelease(r.id, credential)).status, 'failed');
  assert.throws(
    () => store.updateDeploymentSettings('notes', { memoryLimit: '1g' }),
    /reservation/,
  );
  ci.resolveOwnerCiRelease(ci.ownerCiRelease(r.id, 'alice'), 'alice', 'cancelled', {
    ...runtime,
    sourceDigest: r.baseline_source,
  });
  assert.throws(
    () =>
      reserve({
        ...input,
        idempotencyKey: 'stale',
        expectedRelease: 'bad',
      }),
    /Stale/,
  );
});
test('actual commit receipt is durable, secret-free and repeated terminal intents do not redeploy', async () => {
  const input = intent('healthy');
  const r = reserve(input);
  ci.claimCiUpload(r.id, credential);
  const { withCiMutation } = await import('./ci-fence.ts');
  withCiMutation(r.id, () => {
    store.saveDeployment({
      name: 'notes',
      username: 'alice',
      containerId: 'new-container',
      containerName: 'new',
      port: 3000,
    });
    store.updateDeploymentArtifactDigests('notes', { sourceArtifactDigest: input.sourceDigest });
  });
  ci.finishCiRelease(r.id, {
    containerId: 'new-container',
    imageDigest: 'sha256:' + '5'.repeat(64),
  });
  const receipt = ci.ciReceipt(reserve(input));
  assert.equal(receipt.status, 'healthy');
  assert.equal(receipt.sourceArchiveDigest, input.sourceArchiveDigest);
  assert.equal(receipt.imageDigest, 'sha256:' + '5'.repeat(64));
  assert.ok(!JSON.stringify(receipt).includes(created.token));
  target();
  assert.equal(ci.ciReceipt(ci.ciRelease(r.id, credential)).status, 'superseded');
});
test('process death surfaces interrupted state and keeps reservation fenced', () => {
  const r = reserve(intent('crash'));
  store
    .getSqlite()!
    .prepare("update ci_releases set boot_id='previous-process' where id=?")
    .run(r.id);
  assert.equal(ci.ciReceipt(ci.ciRelease(r.id, credential)).status, 'interrupted');
  assert.throws(() => ci.claimCiUpload(r.id, credential), /interrupted/);
  assert.throws(() => ci.assertNoCiRelease('notes'), /reservation/);
  const resumed = ci.resolveOwnerCiRelease(ci.ownerCiRelease(r.id, 'alice'), 'alice', 'accepted', {
    ...runtime,
    sourceDigest: r.baseline_source,
  });
  assert.equal(ci.ciReceipt(resumed).status, 'accepted');
  assert.equal(ci.ciReceipt(resumed).resolvedBy, 'alice');
  ci.resolveOwnerCiRelease(resumed, 'alice', 'cancelled', {
    ...runtime,
    sourceDigest: r.baseline_source,
  });
});
test('legacy targets and changed runtime state are refused before upload mutation', async () => {
  store.saveDeployment({
    name: 'legacy',
    username: 'alice',
    containerId: 'legacy-container',
    containerName: 'deploy-sh-legacy',
  });
  store.updateDeploymentStatus('legacy', 'running');
  assert.throws(() => ci.issueCiCredential('alice', 'legacy', 3600), /legacy adoption/);
  const r = reserve(intent('drift'));
  assert.throws(
    () => store.saveDeployment({ name: 'notes', username: 'alice', containerId: 'unexpected' }),
    /reservation/,
  );
  const { withCiMutation } = await import('./ci-fence.ts');
  withCiMutation(r.id, () =>
    store.saveDeployment({
      name: 'notes',
      username: 'alice',
      containerId: 'unexpected',
      containerName: 'unexpected',
      port: 3000,
    }),
  );
  assert.throws(() => ci.claimCiUpload(r.id, credential), /stale/);
});

test('another live process boot cannot be recovered or cleared', () => {
  // Remove the deliberately drifted accepted fixture from the preceding test.
  const prior = ci.activeCiRelease('notes');
  if (prior)
    store
      .getSqlite()!
      .prepare("UPDATE ci_releases SET status='cancelled' WHERE id=?")
      .run(prior.id);
  target();
  const r = reserve(intent('other-boot'));
  ci.claimCiUpload(r.id, credential);
  store
    .getSqlite()!
    .prepare("UPDATE ci_releases SET boot_id='different-live-worker' WHERE id=?")
    .run(r.id);
  const live = ci.ownerCiRelease(r.id, 'alice');
  assert.equal(ci.ciReceipt(live).status, 'building');
  assert.throws(
    () =>
      ci.resolveOwnerCiRelease(live, 'alice', 'accepted', {
        ...runtime,
        sourceDigest: r.baseline_source,
      }),
    /Live process/,
  );
  store.getSqlite()!.prepare('UPDATE ci_releases SET owner_pid=2147483647 WHERE id=?').run(r.id);
  assert.equal(ci.ciReceipt(ci.ownerCiRelease(r.id, 'alice')).status, 'interrupted');
  ci.resolveOwnerCiRelease(ci.ownerCiRelease(r.id, 'alice'), 'alice', 'cancelled', {
    ...runtime,
    sourceDigest: r.baseline_source,
  });
});
test('verified worker exit clears only its own abandoned leases', async () => {
  const { Worker } = await import('node:worker_threads');
  const { trackCiWorker, ciMutationActive } = await import('./ci-fence.ts');
  const worker = trackCiWorker(new Worker('setInterval(() => {}, 1000)', { eval: true }));
  const tid = worker.threadId;
  store
    .getSqlite()!
    .prepare('INSERT INTO ci_mutations VALUES(?,?,?,?,?)')
    .run('worker-lease', 'notes', process.pid, tid, Date.now());
  store
    .getSqlite()!
    .prepare('INSERT INTO ci_mutations VALUES(?,?,?,?,?)')
    .run('main-lease', 'notes', process.pid, 0, Date.now());
  assert.equal(ciMutationActive('notes'), true);
  await worker.terminate();
  assert.equal(
    store.getSqlite()!.prepare('SELECT id FROM ci_mutations WHERE id=?').get('worker-lease'),
    undefined,
  );
  assert.equal(ciMutationActive('notes'), true);
  store.getSqlite()!.prepare('DELETE FROM ci_mutations WHERE id=?').run('main-lease');
  assert.equal(ciMutationActive('notes'), false);
});
