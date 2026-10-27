import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-worker-reconnect-'));
const { save, now } = await import('./store.ts');
const { computers } = await import('./coordination.ts');

const owner = randomUUID();
save('worker', owner, { id: 'fresh', name: 'Fresh', capabilities: ['codex'], heartbeat: now() });
// Every heartbeat is stored, so one written before this process started is what a worker that
// has not registered again since a coordinator restart looks like.
save('worker', owner, {
  id: 'silent',
  name: 'Silent',
  capabilities: ['codex'],
  heartbeat: '2000-01-01T00:00:00.000Z',
});
save('worker', owner, { id: 'never', name: 'Never', capabilities: ['codex'] });

test('a heartbeat predating this coordinator is reconnecting, not yet offline', () => {
  const workers = computers(owner);
  const worker = (id: string) => workers.find((candidate) => candidate.id === id)!;
  assert.equal(worker('fresh').status, 'online');
  assert.equal(worker('fresh').reconnecting, false);
  assert.equal(worker('silent').status, 'offline');
  assert.equal(worker('silent').reconnecting, true);
  assert.equal(worker('never').status, 'offline');
  assert.equal(worker('never').reconnecting, true);
});

test('past the reconnect window silence really is offline', (t) => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 60000 });
  t.after(() => mock.timers.reset());
  const workers = computers(owner);
  for (const id of ['silent', 'never']) {
    const worker = workers.find((candidate) => candidate.id === id)!;
    assert.equal(worker.status, 'offline');
    assert.equal(worker.reconnecting, false);
  }
});
