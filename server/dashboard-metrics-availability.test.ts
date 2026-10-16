import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'deploy-metric-availability-'));
process.env.DEPLOY_DATA_DIR = directory;
const store = await import('./store.ts');
test('dashboard distinguishes missing and stale resources from a measured zero', () => {
  try {
    store.registerUser('metric-owner', 'disposable-test-password');
    store.saveDeployment({
      name: 'metric-app',
      type: 'docker',
      username: 'metric-owner',
      port: 8080,
      containerId: 'fixture',
      containerName: 'fixture',
    });
    const read = () =>
      store.getDashboardAggregate().perApp.find((app) => app.name === 'metric-app')!;
    assert.equal(read().resourceMetricsAvailable, false);
    store.logMetrics('metric-app', {
      cpuPercent: 0,
      memUsageBytes: 0,
      memLimitBytes: 1024,
      memPercent: 0,
      netRxBytes: 0,
      netTxBytes: 0,
      blockReadBytes: 0,
      blockWriteBytes: 0,
      pids: 1,
      timestamp: Date.now(),
    });
    assert.equal(read().resourceMetricsAvailable, true);
    assert.equal(read().cpuPercent, 0);
    assert.equal(read().memUsageBytes, 0);
    store
      .getSqlite()!
      .prepare('UPDATE resource_metrics SET timestamp = ?')
      .run(Date.now() - 121_000);
    assert.equal(read().resourceMetricsAvailable, false);
  } finally {
    store._resetDb();
    rmSync(directory, { recursive: true, force: true });
  }
});
