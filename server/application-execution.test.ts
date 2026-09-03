import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planApplicationExecution } from './application-execution.ts';
import { placementTargetFromFacts } from './application-placement.ts';
import { compileApplicationManifest, type ApplicationSpec } from './application-spec.ts';

function fixture(): ApplicationSpec {
  return compileApplicationManifest({
    apiVersion: 'deploy.local/v1',
    kind: 'Application',
    components: {
      db: {
        image: 'postgres:18',
        profile: 'deploy.local/postgres@1',
        interfaces: { postgres: { port: 5432, protocol: 'postgres' } },
        mounts: { '/var/lib/postgresql/data': { resource: 'database' } },
      },
      web: {
        build: { context: '.', target: 'production' },
        role: 'web',
        instances: 2,
        interfaces: { http: { port: 3000, protocol: 'http' } },
        environment: { DATABASE: { from: 'db.postgres' } },
        health: { interface: 'http', path: '/health' },
      },
      worker: {
        image: 'registry.example/worker@sha256:1234',
        dependsOn: ['web'],
      },
    },
    resources: {
      database: {
        type: 'volume',
        durability: 'durable',
        dataRole: 'database',
        access: 'singleWriter',
      },
    },
    routes: { public: { to: 'web.http' } },
  }).spec;
}

describe('application graph execution planning', () => {
  it('plans image and build components, fixed slots, implicit dependencies, and stable services', () => {
    const plan = planApplicationExecution('notes', fixture());

    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.componentOrder, ['db', 'web', 'worker']);
    assert.equal(plan.components.db.source.kind, 'image');
    assert.equal(plan.components.web.source.kind, 'build');
    assert.deepEqual(plan.components.web.dependencies, ['db']);
    assert.deepEqual(plan.components.web.slots, ['notes/web/1', 'notes/web/2']);
    assert.equal(plan.services['web.http'].id, 'notes/web/http');
    assert.equal(plan.routes.public.serviceId, 'notes/web/http');
    assert.equal(plan.components.db.profile?.dataMobility, 'logical-export');
    assert.equal(plan.components.db.profile?.supportsDisconnectedMultiWriter, false);
    assert.ok(plan.findings.some((item) => item.code === 'IMPLICIT_SERVICE_DEPENDENCY'));
  });

  it('fails closed for cycles and volume access contracts even with programmatic specs', () => {
    const cyclic = structuredClone(fixture());
    cyclic.components.db.dependsOn = ['worker'];
    const cyclePlan = planApplicationExecution('notes', cyclic);
    assert.equal(cyclePlan.blocked, true);
    assert.ok(cyclePlan.findings.some((item) => item.code === 'COMPONENT_DEPENDENCY_CYCLE'));

    const readOnly = structuredClone(fixture());
    readOnly.resources.database.access = 'multipleReaders';
    const volumePlan = planApplicationExecution('notes', readOnly);
    assert.equal(volumePlan.blocked, true);
    assert.ok(volumePlan.findings.some((item) => item.code === 'READ_ONLY_VOLUME_HAS_WRITER'));
  });

  it('requires provider evidence before allowing concurrent shared writers', () => {
    const spec = fixture();
    delete spec.components.db.profile;
    spec.components.db.instances = 2;
    spec.resources.database.access = 'sharedWriters';

    assert.equal(planApplicationExecution('notes', spec).blocked, true);
    const admitted = planApplicationExecution('notes', spec, {
      volumeCapabilities: { sharedWriterResources: new Set(['database']) },
    });
    assert.equal(admitted.blocked, false);
  });

  it('applies only admitted fixed-count overrides at a named site', () => {
    const spec = fixture();
    spec.components.web.siteOverrides = { allowed: true, minimum: 1, maximum: 4 };
    spec.components.web.minimumReady = 1;

    const suitcase = planApplicationExecution('notes', spec, {
      targetSiteId: 'suitcase-a',
      siteInstanceOverrides: { web: 4 },
    });
    assert.equal(suitcase.blocked, false);
    assert.equal(suitcase.components.web.defaultInstances, 2);
    assert.equal(suitcase.components.web.desiredInstances, 4);
    assert.deepEqual(suitcase.components.web.slots, [
      'notes/web/1',
      'notes/web/2',
      'notes/web/3',
      'notes/web/4',
    ]);

    const outOfBounds = planApplicationExecution('notes', spec, {
      targetSiteId: 'suitcase-a',
      siteInstanceOverrides: { web: 5 },
    });
    assert.equal(outOfBounds.blocked, true);
    assert.equal(outOfBounds.components.web.desiredInstances, 2);
    assert.ok(outOfBounds.findings.some((item) => item.code === 'SITE_OVERRIDE_OUT_OF_BOUNDS'));

    const targetless = planApplicationExecution('notes', spec, {
      siteInstanceOverrides: { web: 3 },
    });
    assert.equal(targetless.blocked, true);
    assert.ok(targetless.findings.some((item) => item.code === 'SITE_OVERRIDE_TARGET_REQUIRED'));
  });

  it('enforces required labels on the selected node and rejects unsupported spread intent', () => {
    const spec = fixture();
    spec.components.web.placement.requiredLabels = { storage: 'ssd', zone: 'inside' };
    const matchingTarget = placementTargetFromFacts({
      nodeId: 'node-home',
      kind: 'coordinator',
      platform: 'linux',
      architecture: 'arm64',
      capabilities: { labels: { storage: 'ssd', zone: 'inside' } },
      source: 'test-heartbeat',
    });
    const admitted = planApplicationExecution('notes', spec, {
      targetSiteId: matchingTarget.nodeId,
      placementTarget: matchingTarget,
    });
    assert.equal(admitted.blocked, false);
    assert.deepEqual(
      admitted.placementEvidence.find((item) => item.component === 'web'),
      {
        component: 'web',
        nodeId: 'node-home',
        intent: 'coLocate',
        desiredInstances: 2,
        requiredLabels: { storage: 'ssd', zone: 'inside' },
        observedLabels: { storage: 'ssd', zone: 'inside' },
        status: 'satisfied',
        source: 'test-heartbeat',
        detail: 'Component is admitted into the node-local private closure on node-home',
        observedAt: null,
      },
    );

    const mismatch = planApplicationExecution('notes', spec, {
      placementTarget: placementTargetFromFacts({
        nodeId: 'node-trip',
        kind: 'suitcase',
        platform: 'linux',
        architecture: 'arm64',
        capabilities: { labels: { storage: 'sd', zone: 'inside' } },
        source: 'test-presence',
      }),
    });
    assert.equal(mismatch.blocked, true);
    assert.ok(
      mismatch.findings.some(
        (item) =>
          item.code === 'PLACEMENT_REQUIRED_LABEL_MISMATCH' &&
          item.path === '/components/web/placement/requiredLabels/storage',
      ),
    );
    assert.match(
      mismatch.findings.find((item) => item.code === 'PLACEMENT_REQUIRED_LABEL_MISMATCH')!.message,
      /node-trip reports "sd"/,
    );

    const unavailable = planApplicationExecution('notes', spec);
    assert.ok(
      unavailable.findings.some((item) => item.code === 'PLACEMENT_TARGET_EVIDENCE_UNAVAILABLE'),
    );

    spec.components.web.placement.intent = 'spread';
    const spread = planApplicationExecution('notes', spec, {
      placementTarget: matchingTarget,
    });
    assert.ok(
      spread.findings.some(
        (item) => item.code === 'PLACEMENT_SPREAD_REQUIRES_CROSS_NODE_SCHEDULER',
      ),
    );
    assert.match(
      spread.placementEvidence.find((item) => item.component === 'web')!.detail,
      /node-local private dependency closure/,
    );

    const reservedLabels = placementTargetFromFacts({
      nodeId: 'node-unreported',
      kind: 'suitcase',
      platform: null,
      architecture: null,
      capabilities: {
        labels: {
          platform: 'forged-platform',
          architecture: 'forged-architecture',
          'deploy.local/node-id': 'forged-node',
          storage: 'ssd',
        },
      },
      source: 'test-presence',
    });
    assert.deepEqual(reservedLabels.labels, {
      'deploy.local/node-id': 'node-unreported',
      'deploy.local/node-kind': 'suitcase',
      'deploy.local/site-id': 'node-unreported',
      storage: 'ssd',
    });
  });
});
