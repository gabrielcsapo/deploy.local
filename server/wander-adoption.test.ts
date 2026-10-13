import assert from 'node:assert/strict';
import { test, afterEach, after } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'wander-fsm-'));
process.env.DEPLOY_DATA_DIR = root;
const { WanderAdoption, newWanderJournal } = await import('./wander-adoption.ts');
const {
  readWanderJournal,
  writeWanderJournal,
  _resetWanderJournal,
  wanderReservation,
  assertWanderLegacyAllowed,
  assertWanderContainerMutation,
  WANDER_MANAGED_DIGEST,
} = await import('./wander-adoption-fence.ts');
const { withCiMutation } = await import('./ci-fence.ts');
const { compileDeployYaml } = await import('./application-spec.ts');
import type { WanderAdoptionAdapter, WanderIntent } from './wander-adoption.ts';
const intent: WanderIntent = {
  applicationId: 'app-fixture',
  expectedContainer: 'original',
  expectedImage: 'sha256:' + 'a'.repeat(64),
  expectedRuntimeSettings: 'b'.repeat(64),
  expectedSource: 'sha256:' + 'c'.repeat(64),
  expectedParent: 'sha256:' + 'd'.repeat(64),
  sourceCommit: 'e'.repeat(40),
  sourceDigest: 'sha256:' + 'f'.repeat(64),
  sourceArchiveDigest: 'sha256:' + '1'.repeat(64),
  requestKey: 'fixture',
  specDigest: WANDER_MANAGED_DIGEST,
  sourceDirectory: '/tmp/synthetic-source',
};
function fixture(fail = '') {
  const calls: string[] = [];
  let failed = false;
  let oldRunning = true;
  let managedRunning = false;
  const step = async (n: string) => {
    calls.push(n);
    if (fail === n && !failed) {
      failed = true;
      throw Error('injected ' + n);
    }
  };
  const adapter: WanderAdoptionAdapter = {
    async acquire() {
      await step('acquire');
    },
    claim(_j) {
      calls.push('claim');
      const latest = readWanderJournal()!;
      if (latest.activePid) throw Error('owned');
      latest.activePid = process.pid;
      latest.activeThread = 0;
      writeWanderJournal(latest);
      return latest;
    },
    release(j) {
      calls.push('release');
      j.activePid = null;
      j.activeThread = null;
      writeWanderJournal(j);
    },
    reserve(i, owner) {
      const j = newWanderJournal(i, owner, {}, 'fingerprint', 'roots');
      writeWanderJournal(j, true);
      return j;
    },
    async checkBaseline(_j, stopped) {
      await step('baseline');
      if (stopped) assert.equal(oldRunning, false);
      assert.ok(!(oldRunning && managedRunning));
    },
    async build() {
      await step('build');
      return 'built-image';
    },
    async stopLegacy() {
      await step('stop');
      oldRunning = false;
    },
    async snapshot() {
      await step('snapshot');
      return {
        directory: '/tmp/disposable',
        archiveDigest: 'archive',
        inventoryDigest: 'inventory',
        databaseDigest: 'db',
        resources: { data: 'data', uploads: 'uploads' },
      };
    },
    async seed(j, n) {
      j.providers[n] = { name: 'fixture-' + n, created: true, seeded: false };
      writeWanderJournal(j);
      await step('seed-' + n);
    },
    async verifySeed() {
      await step('verify-seed');
    },
    async activate() {
      await step('activate');
      assert.equal(oldRunning, false);
      managedRunning = true;
      return 'candidate';
    },
    async verifyCandidate() {
      await step('health');
      assert.equal(managedRunning, true);
    },
    async commit() {
      await step('commit');
    },
    async fenceHelpers() {
      assert.equal(readWanderJournal()!.activePid, process.pid);
      await step('fence-helpers');
    },
    async resumeOriginal() {
      await step('resume');
      assert.equal(managedRunning, false);
      oldRunning = true;
    },
  };
  return {
    service: new WanderAdoption('owner', adapter),
    adapter,
    calls,
    get oldRunning() {
      return oldRunning;
    },
    get managedRunning() {
      return managedRunning;
    },
  };
}
afterEach(() => _resetWanderJournal());
after(() => rmSync(root, { recursive: true, force: true }));
test('exact companion manifest digest and managed storage contract', () => {
  const g = compileDeployYaml(
    readFileSync(new URL('./fixtures/wander-adoption/deploy.yaml', import.meta.url), 'utf8'),
  );
  assert.equal(g.digest, WANDER_MANAGED_DIGEST);
  for (const n of ['data', 'uploads']) {
    assert.equal(g.spec.resources[n].type, 'volume');
    assert.equal(g.spec.resources[n].access, 'singleWriter');
    assert.equal(g.spec.resources[n].source, undefined);
  }
});
test('successful cold-copy transaction and exact intent idempotency', async () => {
  const f = fixture();
  const r = await f.service.adopt(intent);
  assert.equal(r.status, 'committed');
  assert.equal(f.oldRunning, false);
  assert.equal(f.managedRunning, true);
  const before = f.calls.length;
  assert.equal((await f.service.adopt(intent)).operationId, r.operationId);
  assert.equal(f.calls.length, before);
  for (const k of [
    'sourceCommit',
    'sourceDigest',
    'sourceArchiveDigest',
    'expectedContainer',
    'expectedImage',
    'expectedRuntimeSettings',
    'expectedSource',
    'expectedParent',
    'requestKey',
    'specDigest',
    'applicationId',
  ] as const)
    await assert.rejects(() => f.service.adopt({ ...intent, [k]: 'different' }), /conflicts/);
  assert.throws(() => assertWanderLegacyAllowed('wander'), { status: 409 });
  assert.throws(() => assertWanderContainerMutation('original'), { status: 409 });
  assert.doesNotThrow(() => assertWanderLegacyAllowed('groffee'));
  assert.equal(wanderReservation('wander'), undefined);
});
for (const failure of [
  'acquire',
  'fence-helpers',
  'baseline',
  'build',
  'stop',
  'snapshot',
  'seed-data',
  'seed-uploads',
  'verify-seed',
  'activate',
  'health',
  'commit',
])
  test('failure ' + failure + ' stays fenced and recovers exact operation', async () => {
    const f = fixture(failure);
    await assert.rejects(() => f.service.adopt(intent), /injected/);
    const j = readWanderJournal()!;
    assert.equal(j.activePid, null);
    assert.equal(wanderReservation('wander'), j.id);
    assert.throws(() => assertWanderLegacyAllowed('wander'), { status: 409 });
    assert.ok(!(f.oldRunning && f.managedRunning));
    assert.equal((await f.service.recover(j.id)).status, 'committed');
    assert.equal(f.oldRunning, false);
    assert.equal(readWanderJournal()!.activePid, null);
  });
test('owner-only recovery, live-owner exclusion, and no rollback after activation', async () => {
  const f = fixture('health');
  await assert.rejects(() => f.service.adopt(intent));
  let j = readWanderJournal()!;
  await assert.rejects(() => new WanderAdoption('other', f.adapter).recover(j.id), { status: 404 });
  await assert.rejects(() => f.service.recover(j.id, true), /rollback is forbidden/);
  assert.equal(f.oldRunning, false);
  j = readWanderJournal()!;
  j.activePid = process.pid;
  writeWanderJournal(j);
  await assert.rejects(() => f.service.recover(j.id), /Live process/);
});
test('prestart cancellation claims and releases before original writer resumes', async () => {
  const f = fixture('verify-seed');
  await assert.rejects(() => f.service.adopt(intent));
  const j = readWanderJournal()!;
  f.calls.length = 0;
  assert.equal((await f.service.recover(j.id, true)).status, 'cancelled');
  assert.equal(f.calls[0], 'claim');
  assert.ok(f.calls.indexOf('fence-helpers') > f.calls.indexOf('claim'));
  assert.equal(f.calls.at(-1), 'release');
  assert.equal(f.oldRunning, true);
  assert.equal(wanderReservation('wander'), undefined);
});
test('concurrent recover/cancel cannot mutate the active recovery', async () => {
  const f = fixture('snapshot');
  await assert.rejects(() => f.service.adopt(intent));
  const j = readWanderJournal()!;
  let unblock!: () => void;
  const wait = new Promise<void>((r) => (unblock = r));
  f.adapter.acquire = () => wait;
  const running = f.service.recover(j.id);
  const calls = f.calls.length;
  await assert.rejects(() => f.service.recover(j.id, true), /Live process/);
  assert.equal(f.calls.length, calls);
  unblock();
  await running;
});
test('malformed or permissive durable journal fails closed', () => {
  const f = fixture();
  f.adapter.reserve(intent, 'owner');
  const path = join(root, 'wander-adoption', 'journal.json');
  chmodSync(path, 0o644);
  assert.throws(() => wanderReservation('wander'), { status: 409 });
  chmodSync(path, 0o600);
  writeFileSync(path, '{}');
  assert.throws(() => assertWanderLegacyAllowed('wander'), { status: 409 });
});
test('reservation context permits only the owner transaction helper', () => {
  const f = fixture();
  const j = f.adapter.reserve(intent, 'owner');
  withCiMutation(j.id, () => assertWanderContainerMutation('original'));
  assert.throws(() => withCiMutation('wrong', () => assertWanderContainerMutation('original')), {
    status: 409,
  });
});
