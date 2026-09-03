import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { compileDeployYaml } from './application-spec.ts';
import type { WireFleetEvent } from './suitcase-transport.ts';

let directory: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let projector: typeof import('./suitcase-projector.ts');
let siteIdentity: typeof import('./site-identity.ts');
let localOutbox: typeof import('./suitcase-local-outbox.ts');
let homePrivateKey: KeyObject;
let localPrivateKey: KeyObject;
let homePublicKey: string;
let localPublicKey: string;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'deploy-suitcase-projector-'));
  process.env.DEPLOY_DATA_DIR = directory;
  store = await import('./store.ts');
  multisite = await import('./multisite.ts');
  projector = await import('./suitcase-projector.ts');
  siteIdentity = await import('./site-identity.ts');
  localOutbox = await import('./suitcase-local-outbox.ts');
  const home = generateKeyPairSync('ed25519');
  const local = generateKeyPairSync('ed25519');
  homePrivateKey = home.privateKey;
  localPrivateKey = local.privateKey;
  homePublicKey = home.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  localPublicKey = local.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(directory, { recursive: true, force: true });
});

function context(): import('./suitcase-projector.ts').SuitcaseProjectionContext {
  return {
    fleetId: 'fleet_projector',
    fleetName: 'Projector Test',
    homeSiteId: 'site_home',
    localSiteId: 'site_suitcase',
    localSiteName: 'Test Suitcase',
    rootPublicIdentity: homePublicKey,
    localPublicKey,
    siteKeys: { site_home: homePublicKey, site_suitcase: localPublicKey },
    defaultDataPolicy: 'manual',
    accessMode: 'host-hotspot',
    securityProfile: 'isolated',
    siteCredential: 'site_secret_projector',
  };
}

function event(
  sequence: number,
  operation: string,
  payload: Record<string, unknown>,
  overrides: Partial<WireFleetEvent> = {},
): WireFleetEvent {
  const base = {
    id: `event_projector_${sequence}`,
    fleetId: 'fleet_projector',
    originSiteId: 'site_home',
    originSequence: sequence,
    appId: 'app_notes',
    authorityEpoch: 1,
    generation: 2,
    actor: 'admin',
    operation,
    schemaVersion: 1,
    payload,
    artifactDigests: [] as string[],
    parentEventId: null,
    createdAt: '2026-08-08T12:00:00.000Z',
    ...overrides,
  };
  const body = multisite.buildFleetEventBody(base);
  return {
    ...base,
    body,
    authenticatedDigest: sign(null, Buffer.from(body), homePrivateKey).toString('base64url'),
  };
}

test('verified application revisions and replica policies project idempotently', async () => {
  const compiled = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: notes
configuration:
  SESSION_TOKEN:
    type: secret
components:
  web:
    image: example/notes:1
`);
  const revision = event(1, 'application.revision.activated', {
    name: 'notes',
    specDigest: compiled.digest,
    parentDigest: null,
    apiVersion: 'deploy.local/v1',
    manifestFormat: 'yaml',
    normalizedSpec: compiled.spec,
    configurationDigest: `sha256:${'b'.repeat(64)}`,
  });
  await projector.projectSuitcaseFleetEvent(revision, context(), {});
  await projector.projectSuitcaseFleetEvent(revision, context(), {});

  const deployment = store
    .getSqlite()!
    .prepare(
      'SELECT app_id, status, desired_spec_digest, active_spec_digest, configuration_digest FROM deployments WHERE name = ?',
    )
    .get('notes') as Record<string, unknown>;
  assert.deepEqual(deployment, {
    app_id: 'app_notes',
    status: 'stopped',
    desired_spec_digest: compiled.digest,
    active_spec_digest: null,
    configuration_digest: `sha256:${'b'.repeat(64)}`,
  });
  assert.equal(
    (
      store
        .getSqlite()!
        .prepare('SELECT COUNT(*) AS count FROM fleet_events WHERE id = ?')
        .get(revision.id) as { count: number }
    ).count,
    1,
  );

  const replica = event(2, 'application.replica.selected', {
    replicaId: 'replica_notes_suitcase',
    siteId: 'site_suitcase',
    policy: 'manual',
    conflictPolicy: 'collect',
    sharedLineage: true,
  });
  await projector.projectSuitcaseFleetEvent(replica, context(), {});
  const projected = store
    .getSqlite()!
    .prepare(
      'SELECT sync_policy, shared_lineage FROM app_replicas WHERE app_id = ? AND site_id = ?',
    )
    .get('app_notes', 'site_suitcase') as Record<string, unknown>;
  assert.deepEqual(projected, { sync_policy: 'manual', shared_lineage: 1 });
});

test('the exact signed portability report and reconciliation profile project only to its target', async () => {
  const appId = 'app_portable';
  const analyzerVersion = '1.0.0';
  const profileCore = {
    analyzerVersion,
    schemaFingerprint: `sha256:${'f'.repeat(64)}`,
    sqliteFiles: [{ resource: 'data', relativePath: 'notes.db' }],
    eligibleTables: [
      { file: 'data/notes.db', table: 'notes', primaryKey: ['id'], rowIdentity: 'primary-key' },
    ],
    excludedTables: [],
    uploadPaths: [],
    opaquePaths: [],
    conflictPolicy: 'collect',
  };
  const profileDigest = `sha256:${createHash('sha256')
    .update(multisite.canonicalFleetPayload(profileCore))
    .digest('hex')}`;
  const compatibilityDigest = `sha256:${createHash('sha256')
    .update(
      multisite.canonicalFleetPayload({
        analyzerVersion,
        schemaFingerprint: profileCore.schemaFingerprint,
        eligibleTables: profileCore.eligibleTables,
        excludedTables: profileCore.excludedTables,
        uploadPaths: profileCore.uploadPaths,
        conflictPolicy: profileCore.conflictPolicy,
      }),
    )
    .digest('hex')}`;
  const revision = event(
    20,
    'application.revision.activated',
    {
      name: 'portable',
      specDigest: `sha256:${'d'.repeat(64)}`,
      parentDigest: null,
      apiVersion: 'deploy.local/v1',
      manifestFormat: 'yaml',
      normalizedSpec: { components: { web: { image: 'example/portable:1' } } },
    },
    { appId },
  );
  await projector.projectSuitcaseFleetEvent(revision, context(), {});
  const report = event(
    21,
    'application.portability.reported',
    {
      targetSiteId: 'site_suitcase',
      reportId: 'report_portable',
      specDigest: `sha256:${'d'.repeat(64)}`,
      analyzerVersion,
      classification: 'sqlite-replica',
      capabilityVector: { compute: { status: 'pass' } },
      findings: [],
      evidence: [],
      profileDigest,
      reconciliationProfile: {
        version: profileDigest,
        ...profileCore,
        compatibilityDigest,
      },
      createdAt: '2026-08-08T12:01:00.000Z',
    },
    { appId },
  );
  await projector.projectSuitcaseFleetEvent(report, context(), {});
  assert.deepEqual(
    store
      .getSqlite()!
      .prepare(
        `SELECT classification, profile_digest FROM portability_reports
          WHERE id = 'report_portable'`,
      )
      .get(),
    { classification: 'sqlite-replica', profile_digest: profileDigest },
  );
  assert.equal(
    (
      store
        .getSqlite()!
        .prepare('SELECT reconciliation_profile_version FROM deployments WHERE app_id = ?')
        .get(appId) as { reconciliation_profile_version: string }
    ).reconciliation_profile_version,
    profileDigest,
  );

  const otherTarget = event(
    22,
    'application.portability.reported',
    { ...report.payload, targetSiteId: 'site_other', reportId: 'report_other' },
    { appId },
  );
  await projector.projectSuitcaseFleetEvent(otherTarget, context(), {});
  assert.equal(
    (
      store
        .getSqlite()!
        .prepare("SELECT COUNT(*) AS count FROM portability_reports WHERE id = 'report_other'")
        .get() as { count: number }
    ).count,
    0,
  );
});

test('projected policy events update topology/base/event while rejoin requests remain non-destructive', async () => {
  const automatic = event(30, 'application.data.policy.transition.completed', {
    siteId: 'site_suitcase',
    previousPolicy: 'manual',
    policy: 'automatic',
    transitionStatus: 'completed',
    conflictPolicy: 'collect',
    acknowledgedRisks: [],
    dataTopology: 'syncs-across-sites',
    sharedLineage: true,
    baseCheckpointId: 'checkpoint_projected',
    clearBranch: false,
  });
  await projector.projectSuitcaseFleetEvent(automatic, context(), {});
  assert.deepEqual(
    store
      .getSqlite()!
      .prepare(
        `SELECT sync_policy, data_mode, shared_lineage, base_checkpoint_id,
                last_policy_event_id
           FROM app_replicas WHERE app_id = ? AND site_id = ?`,
      )
      .get('app_notes', 'site_suitcase'),
    {
      sync_policy: 'automatic',
      data_mode: 'replicated',
      shared_lineage: 1,
      base_checkpoint_id: 'checkpoint_projected',
      last_policy_event_id: automatic.id,
    },
  );

  const noSync = event(31, 'application.data.policy.updated', {
    siteId: 'site_suitcase',
    previousPolicy: 'automatic',
    policy: 'none',
    transitionStatus: 'completed',
    conflictPolicy: 'collect',
    acknowledgedRisks: ['Site-local data does not converge'],
    dataTopology: 'site-local',
    sharedLineage: false,
    baseCheckpointId: null,
    forkCheckpointId: 'checkpoint_projected',
    siteLocalNamespaceId: 'namespace_projected',
    clearBranch: true,
  });
  await projector.projectSuitcaseFleetEvent(noSync, context(), {});
  const requested = event(32, 'application.data.policy.transition.requested', {
    siteId: 'site_suitcase',
    previousPolicy: 'none',
    policy: 'automatic',
    transitionStatus: 'pending-target-processing',
    rejoinChoice: 'replace-site-from-shared',
    proposedSharedCheckpointId: 'checkpoint_projected',
    requiredActions: ['Preserve the site-local namespace before replacement'],
    consequence: 'The site-local namespace would be displaced only after target processing',
  });
  await projector.projectSuitcaseFleetEvent(requested, context(), {});
  assert.deepEqual(
    store
      .getSqlite()!
      .prepare(
        `SELECT sync_policy, data_mode, shared_lineage, base_checkpoint_id,
                branch_checkpoint_id, last_policy_event_id
           FROM app_replicas WHERE app_id = ? AND site_id = ?`,
      )
      .get('app_notes', 'site_suitcase'),
    {
      sync_policy: 'none',
      data_mode: 'site-local',
      shared_lineage: 0,
      base_checkpoint_id: null,
      branch_checkpoint_id: null,
      last_policy_event_id: requested.id,
    },
  );
  assert.equal(
    (
      store
        .getSqlite()!
        .prepare('SELECT policy FROM data_sync_policies WHERE app_id = ? AND site_id = ?')
        .get('app_notes', 'site_suitcase') as { policy: string }
    ).policy,
    'none',
  );
});

test('signed replica and policy events cannot bypass the resource data-mode contract', async () => {
  const compiled = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: local-only
components:
  web:
    image: example/local-only:1
resources:
  private-data:
    type: volume
    suitcase:
      allowedDataModes: [site-local]
`);
  const revision = event(
    60,
    'application.revision.activated',
    {
      name: 'local-only',
      specDigest: compiled.digest,
      parentDigest: null,
      apiVersion: compiled.spec.apiVersion,
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.spec,
    },
    { appId: 'app_local_only' },
  );
  await projector.projectSuitcaseFleetEvent(revision, context(), {});

  const disallowedSelection = event(
    61,
    'application.replica.selected',
    {
      replicaId: 'replica_local_only',
      siteId: 'site_suitcase',
      policy: 'manual',
      dataTopology: 'syncs-across-sites',
      sharedLineage: true,
    },
    { appId: 'app_local_only' },
  );
  await assert.rejects(
    projector.projectSuitcaseFleetEvent(disallowedSelection, context(), {}),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'suitcase_data_mode_not_allowed' &&
      /private-data/.test(error.message),
  );
  assert.equal(
    store
      .getSqlite()!
      .prepare('SELECT 1 FROM app_replicas WHERE app_id = ? AND site_id = ?')
      .get('app_local_only', 'site_suitcase'),
    undefined,
  );
  assert.equal(
    store
      .getSqlite()!
      .prepare('SELECT 1 FROM fleet_events WHERE id = ?')
      .get(disallowedSelection.id),
    undefined,
  );

  const selected = event(
    62,
    'application.replica.selected',
    {
      replicaId: 'replica_local_only',
      siteId: 'site_suitcase',
      policy: 'none',
      dataTopology: 'site-local',
      sharedLineage: false,
    },
    { appId: 'app_local_only' },
  );
  await projector.projectSuitcaseFleetEvent(selected, context(), {});
  const disallowedTransition = event(
    63,
    'application.data.policy.transition.completed',
    {
      siteId: 'site_suitcase',
      previousPolicy: 'none',
      policy: 'automatic',
      transitionStatus: 'completed',
      dataTopology: 'syncs-across-sites',
      sharedLineage: true,
    },
    { appId: 'app_local_only' },
  );
  await assert.rejects(
    projector.projectSuitcaseFleetEvent(disallowedTransition, context(), {}),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'suitcase_data_mode_not_allowed',
  );
  assert.deepEqual(
    store
      .getSqlite()!
      .prepare('SELECT data_mode, sync_policy FROM app_replicas WHERE app_id = ? AND site_id = ?')
      .get('app_local_only', 'site_suitcase'),
    { data_mode: 'site-local', sync_policy: 'none' },
  );
  assert.equal(
    store
      .getSqlite()!
      .prepare('SELECT 1 FROM fleet_events WHERE id = ?')
      .get(disallowedTransition.id),
    undefined,
  );
});

test('projection rejects secret values before mutating the suitcase database', async () => {
  const unsafe = event(3, 'application.revision.activated', {
    name: 'unsafe',
    specDigest: `sha256:${'c'.repeat(64)}`,
    normalizedSpec: { password: 'do-not-replicate' },
  });
  await assert.rejects(
    projector.projectSuitcaseFleetEvent(unsafe, context(), {}),
    /forbidden configuration value/,
  );
  assert.equal(
    store.getSqlite()!.prepare('SELECT 1 FROM fleet_events WHERE id = ?').get(unsafe.id),
    undefined,
  );
});

test('artifact references are rehashed and recorded before an event is applied', async () => {
  const path = join(directory, 'incoming-artifact');
  const bytes = Buffer.from('verified suitcase artifact');
  writeFileSync(path, bytes);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const artifactEvent = event(
    4,
    'application.artifact.available',
    { artifactDigest: digest },
    { artifactDigests: [digest] },
  );
  await projector.projectSuitcaseFleetEvent(artifactEvent, context(), { [digest]: path });
  const artifact = store
    .getSqlite()!
    .prepare('SELECT verification_status, created_by_event_id FROM artifacts WHERE digest = ?')
    .get(digest) as Record<string, unknown>;
  assert.deepEqual(artifact, {
    verification_status: 'verified',
    created_by_event_id: artifactEvent.id,
  });
});

test('targeted administrator events install only verifier-backed offline admins', async () => {
  const adminEvent = event(5, 'fleet.administrators.projected', {
    targetSiteId: 'site_suitcase',
    users: [
      {
        username: 'fleet-admin',
        role: 'admin',
        passwordVerifier: 'scrypt:test-salt:test-verifier',
        revision: 1,
        enabled: true,
        updatedAt: '2026-08-08T12:00:00.000Z',
      },
    ],
  });
  await projector.projectSuitcaseFleetEvent(adminEvent, context(), {});
  const user = store
    .getSqlite()!
    .prepare('SELECT username, role, password FROM users WHERE username = ?')
    .get('fleet-admin') as Record<string, unknown>;
  assert.deepEqual(user, {
    username: 'fleet-admin',
    role: 'admin',
    password: 'scrypt:test-salt:test-verifier',
  });
});

test('normal suitcase database events use the paired key and enter the durable outbox', () => {
  const membershipFile = join(directory, 'fleet-membership.json');
  const pairedAt = '2026-08-08T12:00:00.000Z';
  const membership = {
    schemaVersion: 1,
    targetId: 'target-projector',
    coordinatorUrl: 'https://home.test',
    siteId: 'site_suitcase',
    fleetId: 'fleet_projector',
    homeSiteId: 'site_home',
    credential: 'site_secret_projector',
    protocolVersion: 1,
    name: 'Test Suitcase',
    defaultDataPolicy: 'manual',
    accessMode: 'host-hotspot',
    securityProfile: 'isolated',
    publicKey: localPublicKey,
    privateKey: localPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    siteKeys: { site_home: homePublicKey, site_suitcase: localPublicKey },
    mode: 'docked',
    nextOriginSequence: 1,
    acknowledgedLocalSequence: 0,
    cursors: {},
    outbox: [],
    inbox: [],
    projectedEventIds: [],
    outgoingArtifacts: [],
    pairedAt,
  };
  writeFileSync(membershipFile, JSON.stringify(membership));
  siteIdentity.installSiteIdentity({
    siteId: membership.siteId,
    publicKey: membership.publicKey,
    privateKey: membership.privateKey,
    createdAt: pairedAt,
  });
  process.env.DEPLOY_SUITCASE = '1';
  process.env.DEPLOY_SUITCASE_MEMBERSHIP_FILE = membershipFile;
  try {
    const appended = multisite.appendLocalFleetEvent({
      originSiteId: 'site_home',
      appId: 'app_notes',
      actor: 'admin@site_suitcase',
      operation: 'application.command.candidate',
      payload: { command: 'restart' },
    });
    assert.equal(
      siteIdentity.verifySitePayload(localPublicKey, appended.body, appended.authenticatedDigest),
      true,
    );
    assert.equal(localOutbox.enqueueLocalDatabaseEvents(membershipFile), 1);
    const saved = JSON.parse(readFileSync(membershipFile, 'utf8')) as {
      outbox: WireFleetEvent[];
    };
    assert.equal(saved.outbox[0].originSiteId, 'site_suitcase');
    assert.equal(saved.outbox[0].authenticatedDigest, appended.authenticatedDigest);
  } finally {
    delete process.env.DEPLOY_SUITCASE;
    delete process.env.DEPLOY_SUITCASE_MEMBERSHIP_FILE;
  }
});
