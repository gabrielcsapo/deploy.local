import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { compileDeployYaml } from './application-spec.ts';

let root: string;
let store: typeof import('./store.ts');
let content: typeof import('./content-store.ts');
let releases: typeof import('./fleet-release.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-fleet-release-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?release=${Date.now()}`);
  content = await import(`./content-store.ts?release=${Date.now()}`);
  releases = await import(`./fleet-release.ts?release=${Date.now()}`);
  store
    .getSqlite()!
    .prepare(
      `INSERT INTO deployments
        (name, username, app_id, release_authority_epoch, release_generation, created_at, updated_at)
       VALUES ('notes', 'admin', 'app-notes', 1, 0, ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('release candidates remain separate from data reconciliation', () => {
  it('promotes only an artifact-verified candidate on its exact authority generation', () => {
    const artifact = content.putArtifactBytes(Buffer.from('release-one'), {
      type: 'image',
      retentionClass: 'release',
    });
    const candidate = releases.createReleaseCandidate({
      appId: 'app-notes',
      originSiteId: 'site-suitcase',
      actor: 'admin',
      imageArtifactDigest: artifact.digest,
      architecture: 'arm64',
    });
    assert.equal(releases.evaluateReleaseCandidate(candidate), 'ready-to-promote');
    assert.equal(releases.promoteReleaseCandidate({ candidateId: candidate, actor: 'admin' }), 1);
    const deployment = store
      .getSqlite()!
      .prepare(
        'SELECT release_generation, desired_release_digest FROM deployments WHERE app_id = ?',
      )
      .get('app-notes') as { release_generation: number; desired_release_digest: string };
    assert.equal(deployment.release_generation, 1);
    assert.equal(deployment.desired_release_digest, artifact.digest);

    const stale = releases.createReleaseCandidate({
      appId: 'app-notes',
      originSiteId: 'site-home',
      actor: 'admin',
      imageArtifactDigest: artifact.digest,
    });
    store
      .getSqlite()!
      .prepare('UPDATE deployments SET release_generation = 2 WHERE app_id = ?')
      .run('app-notes');
    assert.equal(releases.evaluateReleaseCandidate(stale), 'stale-generation');
    assert.throws(
      () => releases.promoteReleaseCandidate({ candidateId: stale, actor: 'admin' }),
      /not safe/,
    );
  });

  it('adopts an existing application revision from its exact parent and queues ordinary intent', () => {
    const first = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: notes
components:
  web:
    image: nginx:1.27
`);
    const next = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: notes
components:
  web:
    image: nginx:1.28
`);
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `UPDATE deployments SET desired_spec_digest = ?, active_spec_digest = ?,
                release_authority_epoch = 1, release_generation = 10, updated_at = ?
          WHERE app_id = 'app-notes'`,
      )
      .run(first.digest, first.digest, now);
    const insertRevision = store.getSqlite()!.prepare(
      `INSERT OR IGNORE INTO application_spec_revisions
        (digest, deployment_name, parent_digest, api_version, source, manifest_format,
         normalized_spec, created_by, created_at)
       VALUES (?, 'notes', ?, 'deploy.local/v1', 'offline', 'deploy.yaml', ?, 'admin', ?)`,
    );
    insertRevision.run(first.digest, null, first.canonicalJson, now);
    insertRevision.run(next.digest, first.digest, next.canonicalJson, now);
    const source = content.putArtifactBytes(Buffer.from('exact-source-with-lockfile'), {
      type: 'source',
      retentionClass: 'release',
    });
    const candidate = releases.createReleaseCandidate({
      appId: 'app-notes',
      originSiteId: 'site-suitcase',
      actor: 'admin',
      specDigest: next.digest,
      parentSpecDigest: first.digest,
      requestedAlias: 'notes',
      sourceArtifactDigest: source.digest,
      artifactDigests: [source.digest],
    });

    assert.equal(releases.evaluateReleaseCandidate(candidate), 'ready-to-promote');
    const plan = releases.planReleaseCandidateChange(candidate);
    assert.equal(plan?.source, 'offline-candidate');
    assert.equal(plan?.impacts.downtime.expectation, 'rolling');
    assert.equal(plan?.impacts.suitcase.disposition, 'revalidation-required');
    assert.equal(releases.promoteReleaseCandidate({ candidateId: candidate, actor: 'admin' }), 11);
    assert.deepEqual(
      store
        .getSqlite()!
        .prepare(
          `SELECT desired_spec_digest, active_spec_digest, desired_release_digest,
                  source_artifact_digest, release_generation
             FROM deployments WHERE app_id = 'app-notes'`,
        )
        .get(),
      {
        desired_spec_digest: next.digest,
        active_spec_digest: first.digest,
        desired_release_digest: source.digest,
        source_artifact_digest: source.digest,
        release_generation: 11,
      },
    );
    const intent = store
      .getSqlite()!
      .prepare(
        `SELECT generation, artifact_digests, payload FROM fleet_events
          WHERE app_id = 'app-notes' AND operation = 'application.revision.desired'
          ORDER BY origin_sequence DESC LIMIT 1`,
      )
      .get() as { generation: number; artifact_digests: string; payload: string };
    assert.equal(intent.generation, 11);
    assert.deepEqual(JSON.parse(intent.artifact_digests), [source.digest]);
    assert.equal(JSON.parse(intent.payload).specDigest, next.digest);
    assert.equal(JSON.parse(intent.payload).parentDigest, first.digest);
  });

  it('requires explicit confirmation before adopting destructive offline graph changes', () => {
    const first = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: destructive-candidate
components:
  web:
    image: nginx:1.27
    mounts:
      /data:
        resource: uploads
resources:
  uploads:
    type: volume
    durability: durable
    dataRole: files
`);
    const next = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: destructive-candidate
components:
  web:
    image: nginx:1.28
`);
    const now = new Date().toISOString();
    store
      .getSqlite()!
      .prepare(
        `INSERT INTO deployments
          (name, username, app_id, desired_spec_digest, active_spec_digest,
           release_authority_epoch, release_generation, created_at, updated_at)
         VALUES ('destructive-candidate', 'admin', 'app-destructive-candidate', ?, ?, 1, 0, ?, ?)`,
      )
      .run(first.digest, first.digest, now, now);
    const insertRevision = store.getSqlite()!.prepare(
      `INSERT INTO application_spec_revisions
        (digest, deployment_name, parent_digest, api_version, source, manifest_format,
         normalized_spec, created_by, created_at)
       VALUES (?, 'destructive-candidate', ?, 'deploy.local/v1', 'offline', 'deploy.yaml', ?, 'admin', ?)`,
    );
    insertRevision.run(first.digest, null, first.canonicalJson, now);
    insertRevision.run(next.digest, first.digest, next.canonicalJson, now);
    const candidate = releases.createReleaseCandidate({
      appId: 'app-destructive-candidate',
      originSiteId: 'site-suitcase',
      actor: 'admin',
      specDigest: next.digest,
      parentSpecDigest: first.digest,
    });

    assert.equal(releases.evaluateReleaseCandidate(candidate), 'ready-to-promote');
    const plan = releases.planReleaseCandidateChange(candidate);
    assert.equal(plan?.destructive, true);
    assert.equal(plan?.impacts.backup.disposition, 'required');
    assert.deepEqual(plan?.impacts.data.removedResources, ['uploads']);
    assert.throws(
      () => releases.promoteReleaseCandidate({ candidateId: candidate, actor: 'admin' }),
      /explicit confirmation/,
    );
    assert.equal(
      releases.promoteReleaseCandidate({
        candidateId: candidate,
        actor: 'admin',
        confirmDestructive: true,
      }),
      1,
    );
  });
});

describe('site-scoped readiness certificates', () => {
  it('requires materialized facts and invalidates the certificate when an input drifts', () => {
    for (const capability of [
      'runtime',
      'data',
      'access',
      'identity',
      'release',
      'build',
    ] as const) {
      releases.updateMaterialization({
        appId: 'app-notes',
        siteId: 'site-suitcase',
        capability,
        desiredDigest: `sha256:${capability}`,
        availableDigest: `sha256:${capability}`,
        desiredGeneration: 2,
        availableGeneration: 2,
        state: 'ready',
        evidence: [{ probe: `${capability}-validated` }],
      });
    }
    const result = releases.evaluateReplicaReadiness({
      appId: 'app-notes',
      siteId: 'site-suitcase',
      specDigest: 'sha256:spec',
      checkpointId: 'checkpoint-1',
      analyzerVersion: '1.0.0',
      requireBuild: true,
    });
    assert.deepEqual(
      {
        runtime: result.runtimeReady,
        build: result.buildReady,
        data: result.dataReady,
        access: result.accessReady,
        blockers: result.blockers,
      },
      { runtime: true, build: true, data: true, access: true, blockers: [] },
    );

    releases.updateMaterialization({
      appId: 'app-notes',
      siteId: 'site-suitcase',
      capability: 'data',
      state: 'missing',
      blockers: ['referenced upload is missing'],
    });
    const certificate = store
      .getSqlite()!
      .prepare('SELECT invalidation_reason FROM readiness_certificates WHERE id = ?')
      .get(result.certificateId) as { invalidation_reason: string };
    assert.match(certificate.invalidation_reason, /data materialization changed/);
  });
});
