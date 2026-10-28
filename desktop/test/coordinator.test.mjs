import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { CoordinatorClient, inspectCertificate } from '../src/client.mjs';
import { WorkerManager } from '../src/worker.mjs';
const origin = process.env.DESKTOP_TEST_ORIGIN;
test(
  'real isolated coordinator: TLS pin, password login, Live, enrollment and bundled worker heartbeat',
  { skip: !origin, timeout: 30000 },
  async () => {
    const url = new URL(origin);
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(Number(url.port) >= 5180 && Number(url.port) <= 5199);
    const cert = await inspectCertificate(origin);
    const untrusted = new CoordinatorClient(origin);
    await assert.rejects(untrusted.request('/api/v2/inbox'));
    const changed = new CoordinatorClient(origin, { pin: cert.fingerprint.replace(/^../, '00') });
    await assert.rejects(changed.request('/api/v2/inbox'), /certificate changed/);
    const client = new CoordinatorClient(origin, { pin: cert.fingerprint });
    const username = `desktop-${Date.now()}`,
      password = 'isolated-desktop-test-password';
    await client.request('/api/register', { method: 'POST', body: { username, password } });
    await client.login(username, password);
    assert.deepEqual(await client.inbox(), { items: [] });
    assert.equal((await client.live()).summary.running, 0);
    const root = mkdtempSync(join(tmpdir(), 'desktop-integration-'));
    const manager = new WorkerManager({
      root,
      executable: process.env.DESKTOP_TEST_EXECUTABLE || process.execPath,
      entry: fileURLToPath(new URL('../build/worker/worker.mjs', import.meta.url)),
    });
    try {
      await manager.configure({ takeTasks: true }, client);
      const [message] = await Promise.race([
        once(manager.child, 'message'),
        once(manager.child, 'exit').then(([code]) => {
          throw new Error(`Worker exited ${code}`);
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('No heartbeat')), 15000).unref(),
        ),
      ]);
      assert.deepEqual(message, { type: 'heartbeat', online: true });
      const status = await client.request('/api/workspace/provider-connections');
      assert.ok(status.workers.some((w) => w.id === manager.connection.enrollment.workerId));
    } finally {
      await manager.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
