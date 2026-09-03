import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compileDeployYaml } from './application-spec.ts';
import { planApplicationChange } from './application-plan.ts';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let guard: typeof import('./fleet-mutation-guard.ts');
let replicas: typeof import('./fleet-replicas.ts');
let transport: typeof import('./suitcase-transport.ts');
let siteA: PairedSite;
let siteB: PairedSite;

interface PairedSite {
  siteId: string;
  fleetId: string;
  credential: string;
  privateKey: string;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-fleet-mutation-guard-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?fleet-mutation=${Date.now()}`);
  multisite = await import(`./multisite.ts?fleet-mutation=${Date.now()}`);
  guard = await import(`./fleet-mutation-guard.ts?fleet-mutation=${Date.now()}`);
  replicas = await import(`./fleet-replicas.ts?fleet-mutation=${Date.now()}`);
  transport = await import(`./suitcase-transport.ts?fleet-mutation=${Date.now()}`);
  multisite.ensureFleetIdentity('Fleet mutation test');
  siteA = pair('Travel Alpha');
  siteB = pair('Travel Bravo');
  for (const [name, appId] of [
    ['notes', 'app_notes_guard'],
    ['photos', 'app_photos_guard'],
    ['archive', 'app_archive_guard'],
  ]) {
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments (name, username, status, app_id, created_at, updated_at)
         VALUES (?, 'admin', 'running', ?, ?, ?)`,
      )
      .run(name, appId, now, now);
    for (const site of [siteA, siteB]) {
      store
        .getSqlite()!
        .prepare(
          `INSERT INTO app_replicas
            (id, app_id, site_id, runtime_status, data_mode, sync_policy,
             shared_lineage, readiness, created_at, updated_at)
           VALUES (?, ?, ?, 'running', 'replicated', 'automatic', 1, '{}', ?, ?)`,
        )
        .run(`replica_${appId}_${site.siteId}`, appId, site.siteId, now, now);
    }
  }
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function pair(name: string): PairedSite {
  const pairing = multisite.createSuitcasePairing({ name, createdBy: 'admin' });
  const keys = generateKeyPairSync('ed25519');
  const redeemed = multisite.redeemSuitcasePairing({
    code: pairing.code,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    platform: 'linux',
    architecture: 'arm64',
    version: '1.0.0',
  });
  return {
    ...redeemed,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function deleteInput(appId: string, name: string) {
  return {
    appId,
    applicationName: name,
    kind: 'application-delete' as const,
    mutationFingerprint: guard.applicationDeleteMutationFingerprint(appId),
    consequence: 'Home runtime, graph, and managed data will be deleted.',
    actor: 'admin',
  };
}

describe('durable fleet mutation acknowledgement gate', () => {
  it('includes incompatible executable revisions, migrations, and scale-downs', () => {
    const manifest = (image: string, command: string, instances = 2) =>
      compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: ${image}
    instances: ${instances}
    rollout:
      strategy: recreate
      schemaOverlap: incompatible
jobs:
  migrate:
    component: web
    command: [${command}]
    beforeTraffic: true
`).spec;
    const current = manifest('example/web:1', 'migrate-v1');
    const imageChange = manifest('example/web:2', 'migrate-v1');
    const migrationChange = manifest('example/web:1', 'migrate-v2');
    const scaleDown = manifest('example/web:1', 'migrate-v1', 1);
    const imagePlan = planApplicationChange(current, imageChange);
    assert.equal(imagePlan.destructive, false);
    assert.equal(guard.requiresFleetAcknowledgement(imagePlan, imageChange), true);
    assert.equal(
      guard.requiresFleetAcknowledgement(
        planApplicationChange(current, migrationChange),
        migrationChange,
      ),
      true,
    );
    assert.equal(
      guard.requiresFleetAcknowledgement(planApplicationChange(current, scaleDown), scaleDown),
      true,
    );
  });

  it('reuses requests, rejects spoofed acknowledgements, and survives module restart', async () => {
    const input = deleteInput('app_notes_guard', 'notes');
    assert.throws(
      () => guard.assertFleetMutationReady(input),
      (error) => {
        assert.equal((error as { code?: string }).code, 'fleet_acknowledgement_required');
        return true;
      },
    );
    assert.ok(store.getDeployment('notes'), 'blocked delete must leave the deployment intact');

    const first = guard.prepareFleetMutation(input);
    const replay = guard.prepareFleetMutation(input);
    assert.equal(replay.requestId, first.requestId);
    const requestCount = store
      .getSqlite()!
      .prepare('SELECT COUNT(*) AS count FROM fleet_events WHERE operation = ? AND app_id = ?')
      .get(guard.FLEET_MUTATION_REQUESTED, input.appId) as { count: number };
    assert.equal(requestCount.count, 1);

    const exchange = transport.exchangeSuitcaseEvents(
      transport.authorizeSuitcaseSite({
        siteId: siteA.siteId,
        credential: siteA.credential,
        protocolVersion: 1,
      }),
      { protocolVersion: 1, cursors: {}, events: [], manualSync: false },
    );
    assert.equal(
      exchange.controlRequests.some((event) => event.id === first.requestId),
      true,
      'the safety request must bypass ordinary data-policy cursors',
    );

    assert.deepEqual(
      guard.acknowledgePendingFleetMutationRequests({
        siteId: siteA.siteId,
        homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
      }),
      [first.requestId],
    );
    assert.deepEqual(
      guard.acknowledgePendingFleetMutationRequests({
        siteId: siteA.siteId,
        homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
      }),
      [],
      'acknowledgement replay must not append a second terminal event',
    );

    multisite.appendLocalFleetEvent({
      originSiteId: siteA.siteId,
      appId: input.appId,
      actor: 'malicious-test',
      operation: guard.FLEET_MUTATION_ACKNOWLEDGED,
      parentEventId: first.requestId!,
      payload: {
        requestId: first.requestId,
        requestedSiteId: siteB.siteId,
        targetSiteId: multisite.ensureFleetIdentity().homeSiteId,
        mutationFingerprint: input.mutationFingerprint,
      },
    });
    assert.deepEqual(
      guard.inspectFleetMutation(input).blockers.map((blocker) => blocker.siteId),
      [siteB.siteId],
      'an acknowledgement authored by another site must not release the hold',
    );

    guard.acknowledgePendingFleetMutationRequests({
      siteId: siteB.siteId,
      homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
    });
    assert.equal(guard.assertFleetMutationReady(input).ready, true);

    const restarted = await import(`./fleet-mutation-guard.ts?restart=${Date.now()}`);
    const afterRestart = restarted.inspectFleetMutation(input);
    assert.equal(afterRestart.ready, true);
    assert.equal(afterRestart.requestId, first.requestId);
  });

  it('keeps revoked replicas blocking until explicit data-loss removal', () => {
    const input = deleteInput('app_photos_guard', 'photos');
    const requested = guard.prepareFleetMutation(input);
    guard.acknowledgePendingFleetMutationRequests({
      siteId: siteA.siteId,
      homeSiteId: multisite.ensureFleetIdentity().homeSiteId,
    });
    store
      .getSqlite()!
      .prepare(
        `UPDATE sites SET revoked_at = ?, credential_status = 'revoked', mode = 'revoked'
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), siteB.siteId);
    const revoked = guard.inspectFleetMutation(input);
    assert.equal(revoked.ready, false);
    assert.equal(revoked.blockers[0]?.siteId, siteB.siteId);
    assert.equal(revoked.blockers[0]?.revoked, true);
    assert.throws(
      () =>
        replicas.removeLostApplicationReplica({
          appId: input.appId,
          siteId: siteB.siteId,
          actor: 'admin',
          acknowledgeUnreceivedDataLoss: false,
        }),
      /acknowledgement/,
    );
    replicas.removeLostApplicationReplica({
      appId: input.appId,
      siteId: siteB.siteId,
      actor: 'admin',
      acknowledgeUnreceivedDataLoss: true,
    });
    const released = guard.inspectFleetMutation(input);
    assert.equal(released.ready, true);
    assert.equal(released.requestId, requested.requestId);
    assert.equal(released.replicas.length, 1);
  });

  it('quarantines future data from an explicitly removed replica', () => {
    const input = deleteInput('app_archive_guard', 'archive');
    replicas.removeLostApplicationReplica({
      appId: input.appId,
      siteId: siteA.siteId,
      actor: 'admin',
      acknowledgeUnreceivedDataLoss: true,
    });
    const sequence = Number(
      (
        store
          .getSqlite()!
          .prepare(
            'SELECT COALESCE(MAX(origin_sequence), 0) + 1 AS next FROM fleet_events WHERE origin_site_id = ?',
          )
          .get(siteA.siteId) as { next: number }
      ).next,
    );
    const event = {
      id: `event_quarantine_${sequence}`,
      fleetId: siteA.fleetId,
      originSiteId: siteA.siteId,
      originSequence: sequence,
      appId: input.appId,
      authorityEpoch: 1,
      generation: 1,
      actor: `system@${siteA.siteId}`,
      operation: 'data.checkpoint.adopted',
      schemaVersion: 1,
      payload: { checkpointId: 'checkpoint_late', siteId: siteA.siteId },
      artifactDigests: [] as string[],
      parentEventId: null,
      createdAt: new Date().toISOString(),
    };
    const body = multisite.buildFleetEventBody(event);
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(
          transport.authorizeSuitcaseSite({
            siteId: siteA.siteId,
            credential: siteA.credential,
            protocolVersion: 1,
          }),
          {
            protocolVersion: 1,
            cursors: {},
            events: [
              {
                ...event,
                body,
                authenticatedDigest: sign(null, Buffer.from(body), siteA.privateKey).toString(
                  'base64url',
                ),
              },
            ],
          },
        ),
      (error) => {
        assert.equal((error as { code?: string }).code, 'replica_branch_quarantined');
        return true;
      },
    );
  });
});
