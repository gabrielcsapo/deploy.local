import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSuitcaseSyncLoop, suitcaseRetryDelay } from '../lib/suitcase-sync-loop.ts';
import {
  bootstrapSuitcaseMembershipFile,
  type SuitcaseMembership,
} from '../lib/suitcase-sync-client.ts';

function membership(mode: SuitcaseMembership['mode']): SuitcaseMembership {
  return { mode } as SuitcaseMembership;
}

test('docked background sync repeats at the success interval and stops cleanly', async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let syncs = 0;
  await runSuitcaseSyncLoop({
    signal: controller.signal,
    readMembership: () => membership('docked'),
    sync: async () => {
      syncs += 1;
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      controller.abort();
    },
    successIntervalMs: 1234,
  });
  assert.equal(syncs, 1);
  assert.deepEqual(waits, [1234]);
});

test('away mode keeps probing Home and returns to docked after a successful exchange', async () => {
  const controller = new AbortController();
  let syncs = 0;
  let docked = 0;
  await runSuitcaseSyncLoop({
    signal: controller.signal,
    readMembership: () => membership('away'),
    sync: async () => {
      syncs += 1;
    },
    markDocked: async () => {
      docked += 1;
    },
    wait: async () => controller.abort(),
  });
  assert.equal(syncs, 1);
  assert.equal(docked, 1);
});

test('rejoining syncs first and only then transitions to docked', async () => {
  const controller = new AbortController();
  const order: string[] = [];
  await runSuitcaseSyncLoop({
    signal: controller.signal,
    readMembership: () => membership('rejoining'),
    sync: async () => {
      order.push('sync');
    },
    markDocked: async () => {
      order.push('docked');
    },
    wait: async () => controller.abort(),
  });
  assert.deepEqual(order, ['sync', 'docked']);
});

test('failures use bounded exponential jitter and reset only after success', async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  const errors: number[] = [];
  let awayTransitions = 0;
  let attempts = 0;
  await runSuitcaseSyncLoop({
    signal: controller.signal,
    readMembership: () => membership('docked'),
    sync: async () => {
      attempts += 1;
      throw new Error(`offline ${attempts}`);
    },
    retryBaseMs: 100,
    retryMaximumMs: 250,
    random: () => 1,
    onError: (_error, retryInMs) => errors.push(retryInMs),
    markAway: () => {
      awayTransitions += 1;
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      if (waits.length === 4) controller.abort();
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [100, 200, 250, 250]);
  assert.deepEqual(errors, waits);
  assert.equal(awayTransitions, 1);
  assert.equal(
    suitcaseRetryDelay(99, 100, 250, () => 0),
    200,
  );
});

test('pairing exchange seeds named-volume membership without becoming authoritative', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-membership-bootstrap-'));
  const exchange = join(directory, 'host', 'fleet-membership.json');
  const authoritative = join(directory, 'state', 'fleet-membership.json');
  const value = {
    schemaVersion: 1,
    targetId: 'target-1',
    coordinatorUrl: 'https://home.test',
    siteId: 'site-1',
    fleetId: 'fleet-1',
    homeSiteId: 'home-1',
    credential: 'site_secret_test',
    protocolVersion: 1,
    publicKey: 'public',
    privateKey: 'private',
  };
  mkdirSync(join(directory, 'host'));
  writeFileSync(exchange, JSON.stringify(value));
  assert.equal(bootstrapSuitcaseMembershipFile(authoritative, exchange), true);
  writeFileSync(exchange, JSON.stringify({ ...value, credential: 'changed-host-copy' }));
  assert.equal(bootstrapSuitcaseMembershipFile(authoritative, exchange), false);
  assert.equal(JSON.parse(readFileSync(authoritative, 'utf8')).credential, 'site_secret_test');
  rmSync(join(directory, 'host'), { recursive: true });
  assert.equal(JSON.parse(readFileSync(authoritative, 'utf8')).siteId, 'site-1');
  rmSync(directory, { recursive: true });
});
