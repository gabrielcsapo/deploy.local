import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let telemetry: typeof import('./fleet-telemetry.ts');
let transport: typeof import('./suitcase-transport.ts');
let volumes: typeof import('./volumes.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-fleet-telemetry-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?fleet-telemetry=${Date.now()}`);
  multisite = await import(`./multisite.ts?fleet-telemetry=${Date.now()}`);
  telemetry = await import(`./fleet-telemetry.ts?fleet-telemetry=${Date.now()}`);
  transport = await import(`./suitcase-transport.ts?fleet-telemetry=${Date.now()}`);
  volumes = await import(`./volumes.ts?fleet-telemetry=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('fleet telemetry synchronization', () => {
  it('exchanges selected operational history while keeping raw requests local', async () => {
    const fleet = multisite.ensureFleetIdentity('Telemetry Fleet');
    const registration = store.registerUser('admin', 'telemetry-password') as { token: string };
    const pairing = multisite.createSuitcasePairing({
      name: 'Telemetry Suitcase',
      createdBy: 'admin',
      defaultDataPolicy: 'automatic',
      accessMode: 'existing-lan',
    });
    const keys = generateKeyPairSync('ed25519');
    const suitcase = multisite.redeemSuitcasePairing({
      code: pairing.code,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      platform: 'linux',
      architecture: 'arm64',
      version: '1.0.0',
    });
    const sqlite = store.getSqlite()!;
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO deployments (name, username, app_id, created_at, updated_at)
         VALUES ('notes', 'admin', 'app-notes', ?, ?)`,
      )
      .run(now, now);
    store.addDeployEvent('notes', { action: 'deploy', username: 'admin', source: 'cli' });
    const buildId = store.createBuildLog('notes');
    writeFileSync(store.buildLogFilePath(buildId), 'build output\n');
    store.completeBuildLog(buildId, { success: true, duration: 42 });
    const backupDirectory = volumes.getBackupDir('notes');
    mkdirSync(backupDirectory, { recursive: true });
    writeFileSync(join(backupDirectory, 'notes.tar.gz'), Buffer.from('portable backup'));
    store.saveBackup({
      deploymentName: 'notes',
      filename: 'notes.tar.gz',
      label: 'before trip',
      sizeBytes: 15,
      createdBy: 'admin',
      createdAt: now,
      volumePaths: ['data', 'uploads'],
    });
    sqlite
      .prepare(
        `INSERT INTO request_logs
          (deployment_name, method, path, status, duration, timestamp, ip)
         VALUES ('notes', 'GET', '/private?token=secret', 200, 7, ?, '192.0.2.1')`,
      )
      .run(Date.now());
    sqlite
      .prepare(
        `INSERT INTO request_logs_1m
          (deployment_name, bucket_ms, count, errors_4xx, errors_5xx,
           duration_sum, duration_min, duration_max)
         VALUES ('notes', ?, 3, 0, 1, 21, 4, 10)`,
      )
      .run(Math.floor(Date.now() / 60_000) * 60_000);

    const collected = await telemetry.collectLocalFleetTelemetry({
      fleetId: fleet.id,
      siteId: fleet.homeSiteId,
    });
    assert.deepEqual([...new Set(collected.records.map((record) => record.kind))].sort(), [
      'activity',
      'backup',
      'build',
      'request-aggregate',
    ]);
    assert.equal(collected.artifacts.length, 1);
    await telemetry.collectLocalFleetTelemetry({
      fleetId: fleet.id,
      siteId: suitcase.siteId,
    });

    const authorization = transport.authorizeSuitcaseSite({
      siteId: suitcase.siteId,
      credential: suitcase.credential,
      protocolVersion: 1,
    });
    const exchange = transport.exchangeSuitcaseEvents(authorization, {
      protocolVersion: 1,
      cursors: {},
      telemetryCursors: {},
      events: [],
      telemetry: [],
    });
    assert.equal(exchange.telemetry.length, 4);
    const requestAggregate = exchange.telemetry.find(
      (record) => record.kind === 'request-aggregate',
    );
    assert.deepEqual(requestAggregate?.payload, {
      bucketMs: Number(requestAggregate?.payload.bucketMs),
      count: 3,
      errors4xx: 0,
      errors5xx: 1,
      durationSum: 21,
      durationMin: 4,
      durationMax: 10,
    });
    assert.equal(JSON.stringify(exchange.telemetry).includes('/private?token=secret'), false);
    assert.equal(JSON.stringify(exchange.telemetry).includes('192.0.2.1'), false);
    assert.equal(
      exchange.telemetry.find((record) => record.kind === 'backup')?.artifactDigests.length,
      1,
    );

    sqlite
      .prepare(
        `INSERT INTO data_sync_policies
          (app_id, site_id, policy, conflict_policy, acknowledged_risks,
           revision, updated_by, updated_at)
         VALUES ('app-notes', ?, 'none', 'collect', '[]', 1, 'admin', ?)`,
      )
      .run(suitcase.siteId, now);
    const noSync = transport.exchangeSuitcaseEvents(authorization, {
      protocolVersion: 1,
      cursors: {},
      telemetryCursors: {},
      events: [],
      telemetry: [],
    });
    const localBackup = noSync.telemetry.find((record) => record.kind === 'backup');
    assert.deepEqual(localBackup?.artifactDigests, []);
    assert.equal(localBackup?.payload.contentLocation, 'origin-site');

    const actions = await import(`../app/actions/deployments.ts?fleet-telemetry=${Date.now()}`);
    const history = await actions.fetchDeployHistory('admin', registration.token, 'notes');
    assert.equal(history.length, 2);
    assert.ok(history.some((entry: Record<string, unknown>) => entry.siteId === suitcase.siteId));
    const builds = await actions.fetchBuildLogs('admin', registration.token, 'notes');
    assert.equal(builds.total, 2);
    assert.ok(
      builds.logs.some((entry: Record<string, unknown>) => entry.siteId === suitcase.siteId),
    );
    const backupInventory = await actions.fetchBackups('admin', registration.token, 'notes');
    assert.equal(backupInventory.backups.length, 2);
    assert.ok(
      backupInventory.backups.some(
        (entry: Record<string, unknown>) => entry.remote && entry.artifactAvailable,
      ),
    );
    const bucket = Number(requestAggregate?.payload.bucketMs);
    const fleetSeries = await actions.fetchFleetSeries(
      'admin',
      registration.token,
      bucket - 60_000,
      bucket + 60_000,
    );
    assert.equal(
      fleetSeries.series.reduce(
        (total: number, point: { total: number }) => total + point.total,
        0,
      ),
      6,
    );
  });
});
