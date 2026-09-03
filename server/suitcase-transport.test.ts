import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SuitcaseTargetManager } from '../lib/suitcase-target.ts';
import { compileDeployYaml } from './application-spec.ts';

let dataDirectory: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let transport: typeof import('./suitcase-transport.ts');
let releases: typeof import('./fleet-release.ts');
let syncClient: typeof import('../lib/suitcase-sync-client.ts');
let certs: typeof import('./certs.ts');

interface PairedSite {
  siteId: string;
  fleetId: string;
  credential: string;
  privateKey: string;
  publicKey: string;
}

let suitcaseA: PairedSite;
let suitcaseB: PairedSite;

before(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-transport-'));
  process.env.DEPLOY_DATA_DIR = dataDirectory;
  store = await import('./store.ts');
  multisite = await import('./multisite.ts');
  transport = await import('./suitcase-transport.ts');
  releases = await import('./fleet-release.ts');
  syncClient = await import('../lib/suitcase-sync-client.ts');
  certs = await import('./certs.ts');
  certs.ensureCerts();
  multisite.ensureFleetIdentity('Transport Test Fleet');
  suitcaseA = pair('Suitcase Alpha');
  suitcaseB = pair('Suitcase Bravo');
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

function pair(name: string): PairedSite {
  const pairing = multisite.createSuitcasePairing({ name, createdBy: 'admin' });
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const redeemed = multisite.redeemSuitcasePairing({
    code: pairing.code,
    publicKey,
    platform: 'linux',
    architecture: 'arm64',
    version: '1.0.0',
  });
  return { ...redeemed, publicKey, privateKey };
}

function testIntermediateCsr(): string {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-test-intermediate-'));
  try {
    const key = join(directory, 'issuer.key');
    const csr = join(directory, 'issuer.csr');
    execFileSync(
      'openssl',
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        csr,
        '-subj',
        '/CN=deploy.local Test Suitcase Intermediate',
      ],
      { stdio: 'pipe' },
    );
    return readFileSync(csr, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function authorization(site: PairedSite, credential = site.credential) {
  return transport.authorizeSuitcaseSite({
    siteId: site.siteId,
    credential,
    protocolVersion: 1,
  });
}

function signedEvent(
  site: PairedSite,
  sequence: number,
  overrides: Partial<import('./suitcase-transport.ts').WireFleetEvent> = {},
) {
  const base = {
    id: `event_${site.siteId}_${sequence}`,
    fleetId: site.fleetId,
    originSiteId: site.siteId,
    originSequence: sequence,
    appId: 'app_portable_notes',
    authorityEpoch: 1,
    generation: 1,
    actor: `admin@${site.siteId}`,
    operation: 'application.command.candidate',
    schemaVersion: 1,
    payload: { command: 'restart' },
    artifactDigests: [] as string[],
    parentEventId: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    ...overrides,
  };
  const body = multisite.buildFleetEventBody(base);
  return {
    ...base,
    body,
    authenticatedDigest: sign(null, Buffer.from(body), site.privateKey).toString('base64url'),
  };
}

describe('authenticated suitcase event transport', () => {
  it('checks protocol, credentials, and distinct suitcase identities', () => {
    assert.notEqual(suitcaseA.siteId, suitcaseB.siteId);
    assert.notEqual(suitcaseA.publicKey, suitcaseB.publicKey);
    assert.equal(authorization(suitcaseA).siteId, suitcaseA.siteId);
    assert.equal(authorization(suitcaseB).siteId, suitcaseB.siteId);
    assert.throws(
      () =>
        transport.authorizeSuitcaseSite({
          siteId: suitcaseA.siteId,
          credential: suitcaseB.credential,
          protocolVersion: 1,
        }),
      /Invalid suitcase credential/,
    );
    assert.throws(
      () =>
        transport.authorizeSuitcaseSite({
          siteId: suitcaseA.siteId,
          credential: suitcaseA.credential,
          protocolVersion: 2,
        }),
      /protocol 1 is required/,
    );
  });

  it('accepts byte-identical replay, rejects sequence conflicts, and stores commands as candidates', () => {
    const auth = authorization(suitcaseA);
    const event = signedEvent(suitcaseA, 1);
    const first = transport.exchangeSuitcaseEvents(auth, {
      protocolVersion: 1,
      fleetId: suitcaseA.fleetId,
      mode: 'away',
      cursors: {},
      events: [event],
    });
    assert.equal(first.acceptedThrough, 1);
    assert.equal(first.replayed, 0);

    const replay = transport.exchangeSuitcaseEvents(auth, {
      protocolVersion: 1,
      cursors: {},
      events: [event],
    });
    assert.equal(replay.acceptedThrough, 1);
    assert.equal(replay.replayed, 1);
    const status = transport.suitcaseSyncStatus(suitcaseA.siteId);
    assert.equal(status.commandCandidates.length, 1);
    assert.equal(status.commandCandidates[0].payload.command, 'restart');

    const conflict = signedEvent(suitcaseA, 1, { id: `event_${suitcaseA.siteId}_conflict` });
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(auth, {
          protocolVersion: 1,
          cursors: {},
          events: [conflict],
        }),
      /conflicts with an accepted event/,
    );
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(authorization(suitcaseB), {
          protocolVersion: 1,
          cursors: {},
          events: [signedEvent(suitcaseA, 2)],
        }),
      /origin.*invalid|fleet, origin/i,
    );
  });

  it('enforces none and manual data policies without blocking semantic event sync', () => {
    const auth = authorization(suitcaseA);
    const dataEvent = signedEvent(suitcaseA, 2, {
      operation: 'data.changeset.proposed',
      payload: { checkpointId: 'checkpoint_away_1' },
    });
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(auth, {
          protocolVersion: 1,
          cursors: {},
          events: [dataEvent],
          manualSync: true,
        }),
      /Data sync is disabled/,
    );
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO data_sync_policies
          (app_id, site_id, policy, conflict_policy, acknowledged_risks,
           revision, updated_by, updated_at)
         VALUES (?, ?, 'manual', 'collect', '[]', 1, 'admin', ?)`,
      )
      .run('app_portable_notes', suitcaseA.siteId, new Date().toISOString());
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(auth, {
          protocolVersion: 1,
          cursors: {},
          events: [dataEvent],
        }),
      /requires an explicit sync now/,
    );
    const manual = transport.exchangeSuitcaseEvents(auth, {
      protocolVersion: 1,
      cursors: {},
      events: [dataEvent],
      manualSync: true,
    });
    assert.equal(manual.acceptedThrough, 2);
  });

  it('transports policy control to a no-sync replica without enabling data prematurely', () => {
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments (name, username, app_id, created_at, updated_at)
         VALUES ('policy-control', 'admin', 'app_policy_control', ?, ?)`,
      )
      .run(now, now);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
           readiness, created_at, updated_at)
         VALUES ('replica-policy-control', 'app_policy_control', ?, 'running', 'site-local',
                 'none', 0, '{}', ?, ?)`,
      )
      .run(suitcaseB.siteId, now, now);
    const request = signedEvent(suitcaseB, 1, {
      appId: 'app_policy_control',
      operation: 'application.data.policy.transition.requested',
      payload: {
        siteId: suitcaseB.siteId,
        previousPolicy: 'none',
        policy: 'automatic',
        transitionStatus: 'pending-target-processing',
        rejoinChoice: 'replace-site-from-shared',
        requiredActions: ['Preserve and restore the target namespace'],
        consequence: 'No data changes until target processing completes',
      },
    });
    const accepted = transport.exchangeSuitcaseEvents(authorization(suitcaseB), {
      protocolVersion: 1,
      cursors: {},
      events: [request],
    });
    assert.equal(accepted.acceptedThrough, 1);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT sync_policy, shared_lineage, base_checkpoint_id, last_policy_event_id
             FROM app_replicas WHERE id = 'replica-policy-control'`,
        )
        .get(),
      {
        sync_policy: 'none',
        shared_lineage: 0,
        base_checkpoint_id: null,
        last_policy_event_id: request.id,
      },
    );
  });

  it('rejects changesets from an unselected or non-shared suitcase replica', () => {
    const event = signedEvent(suitcaseB, 2, {
      appId: 'app_unselected_changeset',
      operation: 'data.changeset.created',
      payload: {},
    });
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(authorization(suitcaseB), {
          protocolVersion: 1,
          cursors: {},
          events: [event],
          manualSync: true,
        }),
      /not selected on suitcase/,
    );

    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
           readiness, created_at, updated_at)
         VALUES ('replica-unselected-changeset', 'app_unselected_changeset', ?, 'running',
                 'site-local', 'none', 0, '{}', ?, ?)`,
      )
      .run(suitcaseB.siteId, now, now);
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(authorization(suitcaseB), {
          protocolVersion: 1,
          cursors: {},
          events: [event],
          manualSync: true,
        }),
      /cannot submit shared changesets from data mode site-local/,
    );
  });

  it('uses independent per-origin cursors for home and two suitcases', () => {
    const fleet = multisite.ensureFleetIdentity();
    multisite.appendLocalFleetEvent({
      originSiteId: fleet.homeSiteId,
      actor: 'admin',
      operation: 'application.policy.updated',
      payload: { appId: 'app_portable_notes', policy: 'manual' },
    });
    const alpha = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors: {},
      events: [],
    });
    const homeEvent = alpha.events.find((event) => event.originSiteId === fleet.homeSiteId)!;
    assert.ok(homeEvent);

    const alphaAck = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors: { [fleet.homeSiteId]: homeEvent.originSequence },
      events: [],
    });
    assert.equal(
      alphaAck.events.some((event) => event.id === homeEvent.id),
      false,
    );
    const bravo = transport.exchangeSuitcaseEvents(authorization(suitcaseB), {
      protocolVersion: 1,
      cursors: {},
      events: [],
    });
    assert.equal(
      bravo.events.some((event) => event.id === homeEvent.id),
      true,
    );
  });

  it('defers manual outgoing data without consuming its cursor and permanently skips none', () => {
    const fleet = multisite.ensureFleetIdentity();
    const appended = multisite.appendLocalFleetEvent({
      originSiteId: fleet.homeSiteId,
      appId: 'app_portable_notes',
      actor: 'admin',
      operation: 'data.checkpoint.created',
      payload: { checkpointId: 'checkpoint_manual_cursor' },
    });
    const maxima = store
      .getSqlite()!
      .prepare(
        `SELECT origin_site_id, MAX(origin_sequence) AS sequence
           FROM fleet_events GROUP BY origin_site_id`,
      )
      .all() as Array<{ origin_site_id: string; sequence: number }>;
    const cursors = Object.fromEntries(
      maxima.map((row) => [
        row.origin_site_id,
        row.origin_site_id === fleet.homeSiteId ? appended.originSequence - 1 : row.sequence,
      ]),
    );

    const background = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors,
      events: [],
      manualSync: false,
    });
    assert.deepEqual(background.events, []);
    assert.deepEqual(background.skippedSequences, {});
    assert.deepEqual(background.deferredOrigins, [fleet.homeSiteId]);
    assert.equal(background.hasMore, false);

    const explicit = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors,
      events: [],
      manualSync: true,
    });
    assert.equal(explicit.events[0]?.originSequence, appended.originSequence);

    const disabled = transport.exchangeSuitcaseEvents(authorization(suitcaseB), {
      protocolVersion: 1,
      cursors,
      events: [],
      manualSync: true,
    });
    assert.deepEqual(disabled.events, []);
    assert.deepEqual(disabled.skippedSequences[fleet.homeSiteId], [appended.originSequence]);
  });

  it('transports writer-handoff control events without a second manual-sync gate', () => {
    const fleet = multisite.ensureFleetIdentity();
    const before = Number(
      (
        store
          .getSqlite()!
          .prepare(
            'SELECT COALESCE(MAX(origin_sequence), 0) AS sequence FROM fleet_events WHERE origin_site_id = ?',
          )
          .get(fleet.homeSiteId) as { sequence: number }
      ).sequence,
    );
    const event = multisite.appendLocalFleetEvent({
      originSiteId: fleet.homeSiteId,
      appId: 'app_portable_notes',
      actor: 'admin',
      operation: 'data.volume.authority.transfer.requested',
      authorityEpoch: 1,
      payload: {
        transferId: 'handoff_transport_test',
        applicationId: 'app_portable_notes',
        sourceSiteId: fleet.homeSiteId,
        targetSiteId: suitcaseA.siteId,
        expectedSnapshotId: null,
        expectedAuthorityEpoch: 1,
        expectedDataSequence: 0,
      },
    });
    const exchange = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors: { [fleet.homeSiteId]: before },
      events: [],
      manualSync: false,
    });
    assert.equal(
      exchange.events.some((candidate) => candidate.id === event.eventId),
      true,
    );
    assert.deepEqual(exchange.deferredOrigins, []);
  });

  it('resumes authenticated artifact uploads and serves ranged downloads', async () => {
    const bytes = Buffer.from('portable artifact transferred in two resumable chunks');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const auth = authorization(suitcaseA);
    const transfer = transport.beginSuitcaseArtifactUpload(auth, {
      digest,
      expectedSize: bytes.length,
    });
    const first = bytes.subarray(0, 17);
    await transport.appendSuitcaseArtifactChunk(auth, {
      transferId: transfer.id,
      digest,
      offset: 0,
      bytes: first,
      metadata: { type: 'checkpoint' },
    });
    const replay = await transport.appendSuitcaseArtifactChunk(auth, {
      transferId: transfer.id,
      digest,
      offset: 0,
      bytes: first,
      metadata: { type: 'checkpoint' },
    });
    assert.equal(replay.verifiedOffset, first.length);
    const complete = await transport.appendSuitcaseArtifactChunk(auth, {
      transferId: transfer.id,
      digest,
      offset: first.length,
      bytes: bytes.subarray(first.length),
      metadata: { type: 'checkpoint', retentionClass: 'checkpoint' },
    });
    assert.equal(complete.status, 'complete');

    const chunkA = transport.readSuitcaseArtifactChunk(auth, digest, 0, 13);
    const chunkB = transport.readSuitcaseArtifactChunk(auth, digest, chunkA.nextOffset, 1024);
    assert.deepEqual(Buffer.concat([chunkA.bytes, chunkB.bytes]), bytes);
    assert.equal(chunkB.complete, true);
  });

  it('acknowledges a data event only after its authenticated artifacts project into Home', async () => {
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, created_at, updated_at)
         VALUES ('portable-notes', 'admin', 'app_portable_notes', ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      )
      .run(now, now);
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage,
           readiness, created_at, updated_at)
         VALUES ('replica-portable-notes-sync', 'app_portable_notes', ?, 'running',
                 'replicated', 'manual', 1, '{}', ?, ?)
         ON CONFLICT(app_id, site_id) DO UPDATE SET
           data_mode = 'replicated', sync_policy = 'manual', shared_lineage = 1,
           removed_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(suitcaseA.siteId, now, now);
    const manifest = {
      formatVersion: 1,
      appId: 'app_portable_notes',
      originSiteId: suitcaseA.siteId,
      baseCheckpointId: 'checkpoint_base_1',
      schemaFingerprint: null,
      databaseArtifactDigest: null,
      fileManifestDigest: null,
    };
    const bytes = Buffer.from(multisite.canonicalFleetPayload(manifest));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const branchAuthenticatedDigest = sign(null, bytes, suitcaseA.privateKey).toString('base64url');
    const event = signedEvent(suitcaseA, 3, {
      operation: 'data.changeset.created',
      payload: {
        changesetId: 'changeset_projected_1',
        baseCheckpointId: 'checkpoint_base_1',
        branchManifestDigest: digest,
        schemaFingerprint: null,
        databaseArtifactDigest: null,
        fileDeltaArtifactDigest: null,
        branchAuthenticatedDigest,
      },
      artifactDigests: [digest],
    });
    const waiting = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors: {},
      events: [event],
      manualSync: true,
    });
    assert.equal(waiting.acceptedThrough, 2);
    assert.deepEqual(waiting.missingArtifacts, [digest]);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare('SELECT 1 FROM data_changesets WHERE id = ?')
        .get('changeset_projected_1'),
      undefined,
    );

    const transfer = transport.beginSuitcaseArtifactUpload(authorization(suitcaseA), {
      digest,
      expectedSize: bytes.length,
    });
    await transport.appendSuitcaseArtifactChunk(authorization(suitcaseA), {
      transferId: transfer.id,
      digest,
      offset: 0,
      bytes,
      metadata: { type: 'data-changeset-manifest', retentionClass: 'checkpoint' },
    });
    const accepted = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors: {},
      events: [event],
      manualSync: true,
    });
    assert.equal(accepted.acceptedThrough, 3);
    const projected = store
      .getSqlite()!
      .prepare('SELECT status, branch_manifest_digest FROM data_changesets WHERE id = ?')
      .get('changeset_projected_1') as Record<string, unknown>;
    assert.deepEqual(projected, { status: 'pending', branch_manifest_digest: digest });

    const rebound = signedEvent(suitcaseA, 4, {
      operation: 'data.changeset.created',
      payload: {
        changesetId: 'changeset_rebound_2',
        baseCheckpointId: 'checkpoint_attacker_selected',
        branchManifestDigest: digest,
        schemaFingerprint: null,
        databaseArtifactDigest: null,
        fileDeltaArtifactDigest: null,
        branchAuthenticatedDigest,
      },
      artifactDigests: [digest],
    });
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
          protocolVersion: 1,
          cursors: { [suitcaseA.siteId]: 3 },
          events: [rebound],
          manualSync: true,
        }),
      /does not match its signed branch manifest/,
    );
    assert.equal(
      store
        .getSqlite()!
        .prepare('SELECT 1 FROM data_changesets WHERE id = ?')
        .get('changeset_rebound_2'),
      undefined,
    );
  });

  it('keeps offline applications reviewable, then adopts a new graph and queues materialization', () => {
    const existingSpec = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: portable-notes
components:
  web:
    image: nginx:stable
`);
    const createdSpec = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: offline-created
components:
  web:
    image: nginx:stable
`);
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT OR IGNORE INTO deployments
          (name, username, app_id, release_authority_epoch, release_generation, created_at, updated_at)
         VALUES ('portable-notes', 'admin', 'app_portable_notes', 1, 1, ?, ?)`,
      )
      .run(now, now);
    const directActivation = signedEvent(suitcaseA, 4, {
      operation: 'application.revision.activated',
      payload: { name: 'portable-notes', specDigest: existingSpec.digest },
    });
    assert.throws(
      () =>
        transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
          protocolVersion: 1,
          cursors: {},
          events: [directActivation],
        }),
      /reviewable release candidates/,
    );

    const existing = signedEvent(suitcaseA, 4, {
      operation: 'application.offline.release.candidate',
      payload: {
        name: 'portable-notes',
        appId: 'app_portable_notes',
        specDigest: existingSpec.digest,
        normalizedSpec: existingSpec.canonicalJson,
        manifestFormat: 'yaml',
        parentDigest: null,
        baseAuthorityEpoch: 1,
        baseGeneration: 1,
        sourceArtifactDigest: null,
        imageArtifactDigest: null,
        configurationDigest: null,
        architecture: 'arm64',
        candidateKind: 'offline-application-revision',
      },
    });
    const created = signedEvent(suitcaseA, 5, {
      appId: 'app_offline_created',
      operation: 'application.offline.release.candidate',
      payload: {
        name: 'offline-created',
        appId: 'app_offline_created',
        specDigest: createdSpec.digest,
        normalizedSpec: createdSpec.canonicalJson,
        manifestFormat: 'yaml',
        parentDigest: null,
        baseAuthorityEpoch: 1,
        baseGeneration: 0,
        sourceArtifactDigest: null,
        imageArtifactDigest: null,
        configurationDigest: null,
        architecture: 'arm64',
        candidateKind: 'offline-application-revision',
      },
    });
    const exchange = transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors: {},
      events: [existing, created],
    });
    assert.equal(exchange.acceptedThrough, 5);
    const candidates = store
      .getSqlite()!
      .prepare(
        `SELECT app_id, spec_digest, parent_spec_digest, requested_alias, artifact_digests, state
           FROM release_candidates
          WHERE id IN (?, ?) ORDER BY app_id`,
      )
      .all(existing.id, created.id) as Array<Record<string, unknown>>;
    assert.deepEqual(candidates, [
      {
        app_id: 'app_offline_created',
        spec_digest: createdSpec.digest,
        parent_spec_digest: null,
        requested_alias: 'offline-created',
        artifact_digests: '[]',
        state: 'pending',
      },
      {
        app_id: 'app_portable_notes',
        spec_digest: existingSpec.digest,
        parent_spec_digest: null,
        requested_alias: 'portable-notes',
        artifact_digests: '[]',
        state: 'pending',
      },
    ]);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare('SELECT applied_at FROM fleet_events WHERE id = ?')
        .get(created.id),
      { applied_at: null },
    );
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT status, desired_spec_digest, active_spec_digest
             FROM deployments WHERE app_id = ?`,
        )
        .get('app_offline_created'),
      { status: 'candidate', desired_spec_digest: null, active_spec_digest: null },
    );
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT state FROM application_aliases
            WHERE fleet_id = ? AND alias = ? AND app_id = ?`,
        )
        .get(suitcaseA.fleetId, 'offline-created', 'app_offline_created'),
      { state: 'reserved' },
    );
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT digest FROM application_spec_revisions
            WHERE deployment_name = 'offline-created'`,
        )
        .get(),
      { digest: createdSpec.digest },
    );

    assert.equal(releases.evaluateReleaseCandidate(created.id), 'ready-to-promote');
    assert.equal(releases.promoteReleaseCandidate({ candidateId: created.id, actor: 'admin' }), 1);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT status, desired_node_id, desired_spec_digest, active_spec_digest,
                  desired_release_digest, release_generation
             FROM deployments WHERE app_id = ?`,
        )
        .get('app_offline_created'),
      {
        status: 'pending',
        desired_node_id: 'coordinator',
        desired_spec_digest: createdSpec.digest,
        active_spec_digest: null,
        desired_release_digest: createdSpec.digest,
        release_generation: 1,
      },
    );
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT state FROM application_aliases
            WHERE fleet_id = ? AND alias = ? AND app_id = ?`,
        )
        .get(suitcaseA.fleetId, 'offline-created', 'app_offline_created'),
      { state: 'active' },
    );
    const homeSiteId = (
      store
        .getSqlite()!
        .prepare('SELECT home_site_id FROM fleets WHERE id = ?')
        .get(suitcaseA.fleetId) as { home_site_id: string }
    ).home_site_id;
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT desired_release_digest, runtime_status, data_mode, sync_policy
             FROM app_replicas WHERE app_id = ? AND site_id = ?`,
        )
        .get('app_offline_created', homeSiteId),
      {
        desired_release_digest: createdSpec.digest,
        runtime_status: 'pending',
        data_mode: 'site-local',
        sync_policy: 'none',
      },
    );
    const queued = store
      .getSqlite()!
      .prepare(
        `SELECT generation, payload FROM fleet_events
          WHERE app_id = ? AND operation = 'application.revision.desired'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get('app_offline_created') as { generation: number; payload: string };
    assert.equal(queued.generation, 1);
    assert.deepEqual(
      {
        specDigest: JSON.parse(queued.payload).specDigest,
        parentDigest: JSON.parse(queued.payload).parentDigest,
        releaseCandidateId: JSON.parse(queued.payload).releaseCandidateId,
      },
      {
        specDigest: createdSpec.digest,
        parentDigest: null,
        releaseCandidateId: created.id,
      },
    );
  });

  it('blocks new offline application promotion until its requested alias conflict is resolved', () => {
    const compiled = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: portable-notes
components:
  web:
    image: nginx:stable
`);
    const event = signedEvent(suitcaseA, 6, {
      appId: 'app_offline_alias_conflict',
      operation: 'application.offline.release.candidate',
      payload: {
        name: 'portable-notes',
        appId: 'app_offline_alias_conflict',
        specDigest: compiled.digest,
        normalizedSpec: compiled.canonicalJson,
        manifestFormat: 'yaml',
        parentDigest: null,
        baseAuthorityEpoch: 1,
        baseGeneration: 0,
        sourceArtifactDigest: null,
        imageArtifactDigest: null,
        configurationDigest: null,
        architecture: 'arm64',
        candidateKind: 'offline-application-revision',
      },
    });
    transport.exchangeSuitcaseEvents(authorization(suitcaseA), {
      protocolVersion: 1,
      cursors: {},
      events: [event],
    });
    assert.equal(releases.evaluateReleaseCandidate(event.id), 'ready-to-promote');
    assert.throws(
      () => releases.promoteReleaseCandidate({ candidateId: event.id, actor: 'admin' }),
      /alias .* conflicts/i,
    );
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT status, desired_spec_digest, active_spec_digest
             FROM deployments WHERE app_id = ?`,
        )
        .get('app_offline_alias_conflict'),
      { status: 'candidate', desired_spec_digest: null, active_spec_digest: null },
    );
  });

  it('rejects a credential immediately after revocation', () => {
    multisite.revokeSite(suitcaseB.siteId, 'test revocation');
    assert.throws(() => authorization(suitcaseB), /revoked/);
  });
});

describe('fake-fetch suitcase client and CLI', () => {
  function fakeCoordinator(options: { recoverOnFirstExchange?: boolean } = {}) {
    const homeKeys = generateKeyPairSync('ed25519');
    const rootPublicIdentity = homeKeys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    let pairCount = 0;
    let recoveryRequired = options.recoverOnFirstExchange === true;
    const exchanged: Array<Record<string, unknown>> = [];
    const transitionProofs: Array<Record<string, unknown>> = [];
    const exchangeCredentials: string[] = [];
    const fetcher: import('../lib/suitcase-sync-client.ts').FetchLike = async (
      input,
      init = {},
    ) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname === '/api/suitcases/pair') {
        pairCount += 1;
        const siteId = `site_fake_${pairCount}`;
        const delegatedTrust = certs.signSuitcaseIntermediateCertificate(
          String(body.intermediateCsr || ''),
        );
        return Response.json(
          {
            siteId,
            fleetId: 'fleet_fake_home',
            homeSiteId: 'site_fake_home',
            credential: `site_secret_fake_${pairCount}`,
            name: `Fake Suitcase ${pairCount}`,
            defaultDataPolicy: 'none',
            accessMode: 'host-hotspot',
            securityProfile: 'isolated',
            protocolVersion: 1,
            rootPublicIdentity,
            ...delegatedTrust,
            administratorProjection: {
              targetSiteId: siteId,
              users: [
                {
                  username: 'fleet-admin',
                  role: 'admin',
                  passwordVerifier: 'scrypt:test:verifier',
                  revision: 1,
                  enabled: true,
                  updatedAt: '2026-08-08T12:00:00.000Z',
                },
              ],
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/api/suitcases/presence') {
        return Response.json({
          siteId: init.headers && new Headers(init.headers).get('x-deploy-site-id'),
          mode: body.mode,
        });
      }
      if (url.pathname === '/api/suitcases/sync/exchange') {
        exchangeCredentials.push(
          String(new Headers(init.headers).get('x-deploy-site-credential') || ''),
        );
        if (recoveryRequired) {
          recoveryRequired = false;
          return Response.json(
            {
              error: 'Recovered Home requires a signed Suitcase re-adoption proof',
              code: 'recovery_readoption_required',
            },
            { status: 428 },
          );
        }
        exchanged.push(body);
        const events = body.events as Array<{ originSequence: number }>;
        const telemetry = (body.telemetry ?? []) as Array<{ originSequence: number }>;
        return Response.json({
          protocolVersion: 1,
          fleetId: body.fleetId,
          homeSiteId: 'site_fake_home',
          siteId: new Headers(init.headers).get('x-deploy-site-id'),
          acceptedThrough: events.at(-1)?.originSequence ?? 0,
          acceptedTelemetryThrough: telemetry.at(-1)?.originSequence ?? 0,
          replayed: 0,
          telemetryReplayed: 0,
          events: [],
          telemetry: [],
          hasMore: false,
          missingArtifacts: [],
          sitePublicKeys: {},
        });
      }
      if (url.pathname === '/api/suitcases/recovery/readopt') {
        transitionProofs.push(body);
        const proof = body.proof as Record<string, unknown>;
        return Response.json({
          siteId: proof.siteId,
          fleetId: proof.fleetId,
          homeSiteId: proof.homeSiteId,
          credentialStatus: 'active',
          mode: 'rejoining',
          rotated: true,
        });
      }
      if (url.pathname === '/api/suitcases/sync/status') {
        return Response.json({ protocolVersion: 1, replicas: [], commandCandidates: [] });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    return { fetcher, exchanged, transitionProofs, exchangeCredentials };
  }

  it('keeps hardware and fleet identities separate for two paired targets', async () => {
    const fake = fakeCoordinator();
    const directoryA = mkdtempSync(join(tmpdir(), 'deploy-client-a-'));
    const directoryB = mkdtempSync(join(tmpdir(), 'deploy-client-b-'));
    const alpha = await syncClient.pairSuitcase(
      { coordinatorUrl: 'https://home.test', code: 'CASE-A', targetId: 'target-alpha' },
      { directory: directoryA, fetch: fake.fetcher },
    );
    const bravo = await syncClient.pairSuitcase(
      { coordinatorUrl: 'https://home.test', code: 'CASE-B', targetId: 'target-bravo' },
      { directory: directoryB, fetch: fake.fetcher },
    );
    assert.notEqual(alpha.siteId, bravo.siteId);
    assert.notEqual(alpha.targetId, alpha.siteId);
    assert.notEqual(bravo.targetId, bravo.siteId);
    const storedA = syncClient.readSuitcaseMembership(directoryA)!;
    const storedB = syncClient.readSuitcaseMembership(directoryB)!;
    assert.notEqual(storedA.privateKey, storedB.privateKey);
    assert.equal(storedA.credential.includes('fake_1'), true);
    assert.equal(storedB.credential.includes('fake_2'), true);
    assert.equal(JSON.stringify(storedA).includes('scrypt:test:verifier'), false);
    assert.equal(
      syncClient.readPendingAdministratorProjection(directoryA)?.users[0]?.username,
      'fleet-admin',
    );
  });

  it('queues an offline command candidate and exchanges it idempotently with fake fetch', async () => {
    const fake = fakeCoordinator();
    const directory = mkdtempSync(join(tmpdir(), 'deploy-client-sync-'));
    await syncClient.pairSuitcase(
      { coordinatorUrl: 'https://home.test', code: 'CASE-SYNC', targetId: 'target-sync' },
      { directory, fetch: fake.fetcher },
    );
    const event = syncClient.queueSuitcaseCommandCandidate(
      { appId: 'app_portable_notes', command: 'restart' },
      { directory, now: () => new Date('2026-08-08T12:00:00.000Z') },
    );
    assert.equal(event.payload.command, 'restart');
    assert.equal(syncClient.readSuitcaseMembership(directory)!.outbox.length, 1);
    const result = await syncClient.syncSuitcaseNow({
      directory,
      fetch: fake.fetcher,
      capabilities: { catalog: { engineVersion: '28.0.0', storageMiB: 32_768 } },
    });
    assert.equal(result.sent, 1);
    assert.equal(syncClient.readSuitcaseMembership(directory)!.outbox.length, 0);
    assert.equal((fake.exchanged[0].events as unknown[]).length, 1);
    assert.deepEqual(fake.exchanged[0].capabilities, {
      catalog: { engineVersion: '28.0.0', storageMiB: 32_768 },
    });
    const status = await syncClient.suitcaseClientSyncStatus({ directory, fetch: fake.fetcher });
    assert.equal(status.connected, true);
  });

  it('automatically signs re-adoption and replaces its credential after Home recovery', async () => {
    const fake = fakeCoordinator({ recoverOnFirstExchange: true });
    const directory = mkdtempSync(join(tmpdir(), 'deploy-client-readoption-'));
    await syncClient.pairSuitcase(
      { coordinatorUrl: 'https://home.test', code: 'CASE-RECOVERY', targetId: 'target-recovery' },
      { directory, fetch: fake.fetcher },
    );
    const before = syncClient.readSuitcaseMembership(directory)!;
    const result = await syncClient.syncSuitcaseNow({ directory, fetch: fake.fetcher });
    const after = syncClient.readSuitcaseMembership(directory)!;
    assert.equal(result.siteId, before.siteId);
    assert.equal(fake.transitionProofs.length, 1);
    const transition = fake.transitionProofs[0]!;
    assert.equal((transition.proof as Record<string, unknown>).purpose, 'home-recovery-readoption');
    assert.equal(typeof transition.signature, 'string');
    assert.equal(JSON.stringify(transition).includes(before.credential), false);
    assert.notEqual(after.credential, before.credential);
    assert.equal(after.mode, 'rejoining');
    assert.equal(fake.exchangeCredentials[0], before.credential);
    assert.equal(fake.exchangeCredentials.at(-1), after.credential);
  });

  it('never uploads an unrequested telemetry artifact', async () => {
    const fake = fakeCoordinator();
    const directory = mkdtempSync(join(tmpdir(), 'deploy-client-telemetry-policy-'));
    await syncClient.pairSuitcase(
      { coordinatorUrl: 'https://home.test', code: 'CASE-DATA', targetId: 'target-data' },
      { directory, fetch: fake.fetcher },
    );
    const membership = syncClient.readSuitcaseMembership(directory)!;
    const artifactPath = join(directory, 'site-local-backup.tar.gz');
    writeFileSync(artifactPath, 'must remain local');
    const digest = `sha256:${createHash('sha256').update('must remain local').digest('hex')}`;
    const result = await syncClient.syncSuitcaseNow({
      directory,
      fetch: fake.fetcher,
      manualSync: false,
      telemetry: [
        {
          id: `telemetry_${'a'.repeat(48)}`,
          fleetId: membership.fleetId,
          originSiteId: membership.siteId,
          originSequence: 1,
          kind: 'backup',
          appId: 'app_local_data',
          deploymentName: 'local-data',
          logicalKey: 'backup:1',
          observedAt: '2026-08-08T12:00:00.000Z',
          payload: { contentAvailable: true },
          artifactDigests: [digest],
          createdAt: '2026-08-08T12:00:00.000Z',
        },
      ],
      telemetryArtifacts: [
        {
          digest,
          path: artifactPath,
          type: 'application-backup',
          mediaType: 'application/gzip',
          retentionClass: 'recovery',
        },
      ],
    });
    assert.equal(result.pendingArtifacts, 0);
    assert.equal(fake.exchanged.length, 1);
  });

  it('routes the offline candidate flow through suitcase-core, not host membership', async () => {
    const fake = fakeCoordinator();
    const directory = mkdtempSync(join(tmpdir(), 'deploy-client-cli-'));
    new SuitcaseTargetManager({ directory, uuid: () => 'target-cli' }).ensureArtifacts();
    await syncClient.pairSuitcase(
      { coordinatorUrl: 'https://home.test', code: 'CASE-CLI', targetId: 'target-cli' },
      { directory, fetch: fake.fetcher },
    );
    const repository = resolve(import.meta.dirname, '..');
    const fakeBin = mkdtempSync(join(tmpdir(), 'deploy-fake-docker-'));
    const capture = join(fakeBin, 'docker-args');
    const docker = join(fakeBin, 'docker');
    writeFileSync(
      docker,
      `#!/bin/sh\nprintf '%s\\n' "$*" > "$DEPLOY_TEST_DOCKER_CAPTURE"\nprintf '%s\\n' '{"id":"event_core_candidate","payload":{"command":"restart"}}'\n`,
    );
    chmodSync(docker, 0o755);
    const output = execFileSync(
      process.execPath,
      [
        'bin/deploy.js',
        'suitcase',
        'candidate',
        'app_portable_notes',
        'restart',
        '--target-dir',
        directory,
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          DEPLOY_TEST_DOCKER_CAPTURE: capture,
        },
      },
    );
    assert.match(output, /Queued restart as candidate event/);
    assert.match(output, /was not executed/);
    const membership = JSON.parse(
      readFileSync(join(directory, 'fleet-membership.json'), 'utf8'),
    ) as { outbox: unknown[] };
    assert.equal(membership.outbox.length, 0);
    assert.match(
      readFileSync(capture, 'utf8'),
      /exec -T core node \/opt\/deploy\.local\/dist\/suitcase-control\.js candidate app_portable_notes restart/,
    );
  });
});

describe('suitcase HTTP endpoints', () => {
  it('pairs, exchanges, changes presence, reports topology, and enforces revocation', async () => {
    const { apiMiddleware } = await import('./api.ts');
    const { stopMetricsCollector } = await import('./metrics-collector.ts');
    const { stopDockerEventStream } = await import('./docker.ts');
    const middleware = apiMiddleware();
    const server = createServer((request, response) => {
      void middleware(request, response, () => {
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const request = async (
      path: string,
      init: RequestInit = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${base}${path}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    try {
      const registered = await request('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'fleet-admin', password: 'correct-horse-battery' }),
      });
      assert.equal(registered.status, 201);
      const adminHeaders = {
        'Content-Type': 'application/json',
        'X-Deploy-Username': 'fleet-admin',
        'X-Deploy-Token': String(registered.body.token),
      };
      const pairing = await request('/api/suitcases/pairing', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ name: 'HTTP Suitcase', defaultDataPolicy: 'manual' }),
      });
      assert.equal(pairing.status, 201);

      const keys = generateKeyPairSync('ed25519');
      const rejectedCsr = await request('/api/suitcases/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: pairing.body.code,
          publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          intermediateCsr: 'not-a-csr',
          platform: 'linux',
          architecture: 'arm64',
          version: '1.0.0',
          protocolVersion: 1,
          targetId: 'target_http_suitcase',
        }),
      });
      assert.equal(rejectedCsr.status, 400);
      const intermediateCsr = testIntermediateCsr();
      const paired = await request('/api/suitcases/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: pairing.body.code,
          publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          intermediateCsr,
          platform: 'linux',
          architecture: 'arm64',
          version: '1.0.0',
          protocolVersion: 1,
          targetId: 'target_http_suitcase',
        }),
      });
      assert.equal(paired.status, 201);
      assert.match(String(paired.body.siteId), /^site_/);
      assert.match(String(paired.body.homeSiteId), /^site_/);
      assert.ok(String(paired.body.rootPublicIdentity).includes('PUBLIC KEY'));
      assert.equal(
        String(paired.body.rootCertificate),
        readFileSync(join(dataDirectory, 'certs', 'ca.crt'), 'utf8'),
      );
      assert.match(String(paired.body.intermediateCertificate), /BEGIN CERTIFICATE/);
      assert.equal('rootPrivateKey' in paired.body, false);
      assert.equal(
        JSON.stringify(paired.body).includes(
          readFileSync(join(dataDirectory, 'certs', 'ca.key'), 'utf8').trim(),
        ),
        false,
      );
      const siteHeaders = {
        'Content-Type': 'application/json',
        'X-Deploy-Site-Id': String(paired.body.siteId),
        'X-Deploy-Site-Credential': String(paired.body.credential),
        'X-Deploy-Suitcase-Protocol': '1',
      };

      const away = await request('/api/suitcases/presence', {
        method: 'POST',
        headers: siteHeaders,
        body: JSON.stringify({ protocolVersion: 1, mode: 'away' }),
      });
      assert.equal(away.status, 200);
      assert.equal(away.body.mode, 'away');
      const exchange = await request('/api/suitcases/sync/exchange', {
        method: 'POST',
        headers: siteHeaders,
        body: JSON.stringify({ protocolVersion: 1, cursors: {}, events: [] }),
      });
      assert.equal(exchange.status, 200);
      assert.equal(exchange.body.protocolVersion, 1);
      assert.equal(exchange.body.siteId, paired.body.siteId);
      const status = await request('/api/suitcases/sync/status', { headers: siteHeaders });
      assert.equal(status.status, 200);

      const mismatch = await request('/api/suitcases/sync/status', {
        headers: { ...siteHeaders, 'X-Deploy-Suitcase-Protocol': '99' },
      });
      assert.equal(mismatch.status, 426);
      assert.equal(mismatch.body.code, 'protocol_version_mismatch');
      const topology = await request('/api/suitcases/topology', { headers: adminHeaders });
      assert.equal(topology.status, 200);
      assert.ok((topology.body.sites as unknown[]).length >= 3);
      const fleetTopology = await request('/api/fleet/topology', { headers: adminHeaders });
      assert.equal(fleetTopology.status, 200);
      assert.ok(Array.isArray(fleetTopology.body.sites));

      const rotationRequested = await request('/api/suitcases/credentials/rotation', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ siteId: paired.body.siteId }),
      });
      assert.equal(rotationRequested.status, 200);
      assert.equal(rotationRequested.body.count, 1);
      assert.equal('credential' in rotationRequested.body, false);
      const rotationBlocked = await request('/api/suitcases/sync/status', {
        headers: siteHeaders,
      });
      assert.equal(rotationBlocked.status, 428);
      assert.equal(rotationBlocked.body.code, 'credential_rotation_required');
      const rotatedCredential = 'site_secret_http_rotated';
      const rotationProof = {
        schemaVersion: 1,
        purpose: 'credential-rotation',
        siteId: String(paired.body.siteId),
        fleetId: String(paired.body.fleetId),
        homeSiteId: String(paired.body.homeSiteId),
        protocolVersion: 1,
        acknowledgedLocalSequence: 0,
        acknowledgedLocalTelemetrySequence: 0,
        cursors: {},
        applications: [],
        proposedCredentialHash: createHash('sha256').update(rotatedCredential).digest('hex'),
        nonce: createHash('sha256').update(`rotation:${paired.body.siteId}`).digest('base64url'),
        createdAt: new Date().toISOString(),
      };
      const rotationCompleted = await request('/api/suitcases/credentials/complete', {
        method: 'POST',
        headers: siteHeaders,
        body: JSON.stringify({
          proof: rotationProof,
          signature: sign(
            null,
            Buffer.from(multisite.canonicalFleetPayload(rotationProof)),
            keys.privateKey,
          ).toString('base64url'),
        }),
      });
      assert.equal(rotationCompleted.status, 200);
      assert.equal(rotationCompleted.body.credentialStatus, 'active');
      assert.equal('credential' in rotationCompleted.body, false);
      const rotatedHeaders = {
        ...siteHeaders,
        'X-Deploy-Site-Credential': rotatedCredential,
      };
      assert.equal(
        (await request('/api/suitcases/sync/status', { headers: rotatedHeaders })).status,
        200,
      );
      assert.equal(
        (await request('/api/suitcases/sync/status', { headers: siteHeaders })).status,
        401,
      );

      const revoked = await request(
        `/api/suitcases/${encodeURIComponent(String(paired.body.siteId))}/revoke`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ reason: 'HTTP test complete' }),
        },
      );
      assert.equal(revoked.status, 200);
      const afterRevoke = await request('/api/suitcases/sync/status', { headers: rotatedHeaders });
      assert.equal(afterRevoke.status, 403);
      assert.equal(afterRevoke.body.code, 'site_revoked');
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
      );
      stopMetricsCollector();
      stopDockerEventStream();
    }
  });
});
