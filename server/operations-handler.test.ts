import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let operations: typeof import('./operations-handler.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-operations-handler-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?operations-handler=${Date.now()}`);
  operations = await import(`./operations-handler.ts?operations-handler=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

const admin = { username: 'admin', role: 'admin' as const };

describe('administrator recovery and support operations', () => {
  it('rejects non-administrators before inspecting recovery state', async () => {
    const response = await operations.handleOperationsRequest({
      method: 'GET',
      pathname: '/operations/recovery-bundles',
      actor: { username: 'member', role: 'user' },
    });
    assert.equal(response.status, 403);
  });

  it('exposes the cutover gate and durable recovery inventory', async () => {
    const readiness = await operations.handleOperationsRequest({
      method: 'GET',
      pathname: '/operations/release-readiness',
      actor: admin,
    });
    assert.equal(readiness.status, 200);
    assert.equal((readiness.body as { ready: boolean }).ready, false);
    assert.equal(
      (readiness.body as { checks: Array<{ id: string }> }).checks.some(
        (check) => check.id === 'CUTOVER.RECOVERY_BOUNDARY',
      ),
      true,
    );

    const bundles = await operations.handleOperationsRequest({
      method: 'GET',
      pathname: '/operations/recovery-bundles',
      actor: admin,
    });
    assert.deepEqual(bundles, { status: 200, body: { bundles: [] } });
  });

  it('validates requests without exposing passphrases in responses', async () => {
    const response = await operations.handleOperationsRequest({
      method: 'POST',
      pathname: '/operations/recovery-bundles',
      actor: admin,
      body: { outputPath: join(root, 'bundle') },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'passphrase is required' });

    const restore = await operations.handleOperationsRequest({
      method: 'POST',
      pathname: '/operations/recovery-bundles/restore',
      actor: admin,
      body: { bundlePath: join(root, 'missing.bundle') },
    });
    assert.equal(restore.status, 400);
    assert.deepEqual(restore.body, { error: 'passphrase is required' });

    const rehearsal = await operations.handleOperationsRequest({
      method: 'POST',
      pathname: '/operations/recovery-bundles/recovery_missing/rehearsal',
      actor: admin,
      body: { result: 'passed' },
    });
    assert.equal(rehearsal.status, 400);
    assert.deepEqual(rehearsal.body, { error: 'bundlePath is required' });
  });
});
