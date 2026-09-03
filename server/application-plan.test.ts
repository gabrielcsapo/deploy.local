import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileApplicationManifest, type ApplicationSpec } from './application-spec.ts';
import { planApplicationChange } from './application-plan.ts';

const BASE_SPEC = compileApplicationManifest({
  apiVersion: 'deploy.local/v1',
  kind: 'Application',
  metadata: { name: 'notes', labels: { tier: 'personal' } },
  configuration: {
    adminPassword: { type: 'secret', required: true },
  },
  components: {
    web: {
      build: { context: '.', dockerfile: 'Dockerfile' },
      role: 'web',
      instances: 2,
      interfaces: { http: { port: 3000, protocol: 'http' } },
      environment: { ADMIN_PASSWORD: { from: 'configuration.adminPassword' } },
      health: { interface: 'http', path: '/health' },
    },
    db: {
      image: 'postgres:18',
      role: 'service',
      profile: 'deploy.local/postgres@1',
      interfaces: { postgres: { port: 5432, protocol: 'postgres' } },
      mounts: { '/var/lib/postgresql/data': { resource: 'database' } },
    },
  },
  resources: {
    database: { type: 'volume', durability: 'durable', dataRole: 'database' },
    archive: { type: 'volume', durability: 'durable', dataRole: 'files' },
  },
  routes: {
    public: { to: 'web.http', hostname: 'notes.local' },
  },
  jobs: {
    migrate: { component: 'web', command: ['npm', 'run', 'migrate'], beforeTraffic: true },
  },
}).spec;

describe('semantic application change planning', () => {
  it('emits an explicit no-op for semantically identical specs', () => {
    const plan = planApplicationChange(BASE_SPEC, clone(BASE_SPEC));

    assert.deepEqual(plan.actions, [
      {
        classification: 'no-op',
        effect: 'none',
        address: '/',
        changedAddresses: [],
        reason: 'Current and desired application specifications are semantically identical',
        requiresApproval: false,
        destructive: false,
        restartRequired: false,
        blocked: false,
      },
    ]);
    assert.deepEqual(
      {
        source: plan.source,
        requiresApproval: plan.requiresApproval,
        destructive: plan.destructive,
        restartRequired: plan.restartRequired,
        blocked: plan.blocked,
      },
      {
        source: 'yaml',
        requiresApproval: false,
        destructive: false,
        restartRequired: false,
        blocked: false,
      },
    );
    assert.deepEqual(plan.impacts.capacity, {
      currentInstances: 3,
      desiredInstances: 3,
      addedInstances: 0,
      removedInstances: 0,
      rollingSurgeInstances: 0,
      peakInstances: 3,
      revalidationRequired: false,
    });
    assert.equal(plan.impacts.downtime.expectation, 'none');
    assert.equal(plan.impacts.backup.disposition, 'not-required');
    assert.equal(plan.impacts.data.effect, 'none');
    assert.equal(plan.impacts.suitcase.disposition, 'none');
  });

  it('classifies a configuration declaration edit without inventing a runtime restart', () => {
    const desired = clone(BASE_SPEC);
    desired.configuration.adminPassword.description = 'Password used for the first administrator';

    const plan = planApplicationChange(BASE_SPEC, desired);

    assert.deepEqual(
      plan.actions.map(({ classification, address, changedAddresses }) => ({
        classification,
        address,
        changedAddresses,
      })),
      [
        {
          classification: 'configuration-declaration-change',
          address: '/configuration/adminPassword',
          changedAddresses: ['/configuration/adminPassword/description'],
        },
      ],
    );
    assert.equal(plan.requiresApproval, false);
    assert.equal(plan.restartRequired, false);
  });

  it('classifies an instance-count-only edit as scale', () => {
    const desired = clone(BASE_SPEC);
    desired.components.web.instances = 3;

    const plan = planApplicationChange(BASE_SPEC, desired);

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].classification, 'component-scale');
    assert.equal(plan.actions[0].address, '/components/web');
    assert.deepEqual(plan.actions[0].changedAddresses, ['/components/web/instances']);
    assert.match(plan.actions[0].reason, /from 2 to 3/);
    assert.equal(plan.restartRequired, false);
  });

  it('treats display and rollout policy as durable metadata but recreates capacity changes', () => {
    const presented = clone(BASE_SPEC);
    presented.components.web.displayName = 'Family Notes';
    presented.components.web.minimumReady = 2;
    presented.components.web.rollout.maxUnavailable = 1;
    const presentationPlan = planApplicationChange(BASE_SPEC, presented);
    assert.deepEqual(
      presentationPlan.actions.map((item) => item.classification),
      ['metadata-update'],
    );
    assert.equal(presentationPlan.restartRequired, false);

    const capacity = clone(BASE_SPEC);
    capacity.components.web.capacity.memoryBytes = 536_870_912;
    const capacityPlan = planApplicationChange(BASE_SPEC, capacity);
    assert.equal(capacityPlan.actions[0]?.classification, 'component-recreate');
    assert.equal(capacityPlan.restartRequired, true);
    assert.equal(capacityPlan.impacts.capacity.revalidationRequired, true);
  });

  it('rolls image and build changes but recreates a runtime-contract change', () => {
    const imageDesired = clone(BASE_SPEC);
    imageDesired.components.db.image = 'postgres:18.1';
    const imagePlan = planApplicationChange(BASE_SPEC, imageDesired);
    assert.equal(imagePlan.actions[0].classification, 'component-rolling-restart');
    assert.deepEqual(imagePlan.actions[0].changedAddresses, ['/components/db/image']);
    assert.equal(imagePlan.restartRequired, true);

    const buildDesired = clone(BASE_SPEC);
    buildDesired.components.web.build!.target = 'production';
    const buildPlan = planApplicationChange(BASE_SPEC, buildDesired);
    assert.equal(buildPlan.actions[0].classification, 'component-rolling-restart');
    assert.deepEqual(buildPlan.actions[0].changedAddresses, ['/components/web/build/target']);

    const runtimeDesired = clone(BASE_SPEC);
    runtimeDesired.components.web.runtime.gpus = true;
    const runtimePlan = planApplicationChange(BASE_SPEC, runtimeDesired);
    assert.equal(runtimePlan.actions[0].classification, 'component-recreate');
    assert.deepEqual(runtimePlan.actions[0].changedAddresses, ['/components/web/runtime/gpus']);
    assert.equal(runtimePlan.restartRequired, true);
  });

  it('marks durable resource removal and incompatible changes destructive', () => {
    const removed = clone(BASE_SPEC);
    delete removed.resources.archive;
    const removalPlan = planApplicationChange(BASE_SPEC, removed);

    assert.equal(removalPlan.actions[0].classification, 'resource-remove');
    assert.equal(removalPlan.actions[0].address, '/resources/archive');
    assert.match(removalPlan.actions[0].reason, /explicit future move declaration/);
    assert.equal(removalPlan.requiresApproval, true);
    assert.equal(removalPlan.destructive, true);

    const changed = clone(BASE_SPEC);
    changed.resources.database.access = 'multipleReaders';
    const changePlan = planApplicationChange(BASE_SPEC, changed);

    assert.equal(changePlan.actions[0].classification, 'resource-incompatible-change');
    assert.deepEqual(changePlan.actions[0].changedAddresses, ['/resources/database/access']);
    assert.equal(changePlan.requiresApproval, true);
    assert.equal(changePlan.destructive, true);
    assert.equal(changePlan.restartRequired, true);
  });

  it('treats a durable resource key rename as remove plus create', () => {
    const desired = clone(BASE_SPEC);
    desired.resources['postgres-data'] = desired.resources.database;
    delete desired.resources.database;
    desired.components.db.mounts['/var/lib/postgresql/data'].resource = 'postgres-data';

    const plan = planApplicationChange(BASE_SPEC, desired);
    const byClassification = new Map(plan.actions.map((item) => [item.classification, item]));

    assert.equal(byClassification.get('component-recreate')?.address, '/components/db');
    assert.equal(byClassification.get('resource-remove')?.address, '/resources/database');
    assert.equal(byClassification.get('resource-create')?.address, '/resources/postgres-data');
    assert.match(byClassification.get('resource-remove')!.reason, /move declaration/);
    assert.equal(plan.requiresApproval, true);
    assert.equal(plan.destructive, true);
    assert.deepEqual(plan.impacts.data, {
      effect: 'destructive',
      preservedResources: ['archive'],
      createdResources: ['postgres-data'],
      removedResources: ['database'],
      recreatedResources: [],
    });
    assert.equal(plan.impacts.backup.disposition, 'required');
    assert.deepEqual(plan.impacts.backup.resources, ['database']);
    assert.equal(plan.impacts.downtime.expectation, 'required');
  });

  it('reports capacity, rolling downtime, backup, and suitcase revalidation impacts', () => {
    const desired = clone(BASE_SPEC);
    desired.components.web.instances = 3;
    desired.components.web.image = 'example.invalid/notes:v2';

    const plan = planApplicationChange(BASE_SPEC, desired, {
      source: 'offline-candidate',
      targetSiteId: 'suitcase-a',
      targetSiteKind: 'suitcase',
      suitcaseSiteIds: ['suitcase-a', 'suitcase-b'],
    });

    assert.equal(plan.source, 'offline-candidate');
    assert.deepEqual(plan.impacts.capacity, {
      currentInstances: 3,
      desiredInstances: 4,
      addedInstances: 1,
      removedInstances: 0,
      rollingSurgeInstances: 1,
      peakInstances: 5,
      revalidationRequired: true,
    });
    assert.equal(plan.impacts.downtime.expectation, 'rolling');
    assert.deepEqual(plan.impacts.downtime.components, ['web']);
    assert.equal(plan.impacts.backup.disposition, 'recommended');
    assert.deepEqual(plan.impacts.backup.resources, ['archive', 'database']);
    assert.deepEqual(plan.impacts.suitcase, {
      disposition: 'revalidation-required',
      sites: ['suitcase-a', 'suitcase-b'],
      reasons: [
        'Revalidate runtime, build, capacity, data, and access readiness on affected suitcases.',
      ],
    });
  });

  it('models explicit retention without pretending a stable-key removal preserves attachment', () => {
    const desired = clone(BASE_SPEC);
    delete desired.resources.archive;

    const plan = planApplicationChange(BASE_SPEC, desired, {
      source: 'catalog',
      resourceRemovalPolicy: 'retain',
      suitcaseSiteIds: [],
    });

    assert.equal(plan.actions[0].effect, 'retention');
    assert.equal(plan.destructive, false);
    assert.equal(plan.requiresApproval, true);
    assert.equal(plan.impacts.data.effect, 'retain');
    assert.deepEqual(plan.impacts.data.removedResources, ['archive']);
    assert.equal(plan.impacts.backup.disposition, 'not-required');
    assert.equal(plan.impacts.suitcase.disposition, 'none');
  });

  it('plans component, route, and job lifecycle changes at stable addresses', () => {
    const desired = clone(BASE_SPEC);
    desired.components.worker = {
      image: 'worker:1',
      role: 'worker',
      instances: 1,
      minimumReady: 1,
      rollout: {
        strategy: 'recreate',
        maxSurge: 0,
        maxUnavailable: 1,
        schemaOverlap: 'incompatible',
      },
      siteOverrides: { allowed: false, minimum: 1, maximum: 256 },
      capacity: {},
      placement: { intent: 'coLocate', requiredLabels: {} },
      interfaces: {},
      environment: {},
      configurationFiles: {},
      mounts: {},
      dependsOn: ['db'],
      runtime: {
        gpus: false,
        privileged: false,
        privilegedDocker: false,
        networkMode: 'private',
        devices: [],
        runArgs: [],
        networks: [],
      },
    };
    delete desired.components.web;
    delete desired.routes.public;
    desired.jobs.migrate.command = ['npm', 'run', 'migrate:v2'];

    const plan = planApplicationChange(BASE_SPEC, desired);

    assert.deepEqual(
      plan.actions.map(({ classification, address }) => ({ classification, address })),
      [
        { classification: 'component-remove', address: '/components/web' },
        { classification: 'component-create', address: '/components/worker' },
        { classification: 'job-update', address: '/jobs/migrate' },
        { classification: 'route-update', address: '/routes/public' },
      ],
    );
  });

  it('emits deterministic output regardless of object insertion order', () => {
    const desired = clone(BASE_SPEC);
    desired.components.web.instances = 4;
    desired.routes.public.hostname = 'new-notes.local';
    delete desired.resources.archive;

    const reorderedCurrent = reorderMaps(clone(BASE_SPEC));
    const reorderedDesired = reorderMaps(clone(desired));

    assert.deepEqual(
      planApplicationChange(BASE_SPEC, desired),
      planApplicationChange(reorderedCurrent, reorderedDesired),
    );
  });

  it('fails closed on fields the planner does not understand', () => {
    const current = clone(BASE_SPEC);
    const currentWeb = current.components.web as ApplicationSpec['components'][string] & {
      futurePolicy: string;
    };
    currentWeb.futurePolicy = 'preserve';
    const desired = clone(current);

    const plan = planApplicationChange(current, desired);

    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].classification, 'unsupported-change');
    assert.equal(plan.actions[0].address, '/components/web/futurePolicy');
    assert.equal(plan.requiresApproval, true);
    assert.equal(plan.blocked, true);
    assert.equal(
      plan.actions.some((item) => item.classification === 'no-op'),
      false,
    );
  });
});

function clone(spec: ApplicationSpec): ApplicationSpec {
  return structuredClone(spec);
}

function reorderMaps(spec: ApplicationSpec): ApplicationSpec {
  spec.configuration = reverseRecord(spec.configuration);
  spec.components = reverseRecord(spec.components);
  spec.resources = reverseRecord(spec.resources);
  spec.routes = reverseRecord(spec.routes);
  spec.jobs = reverseRecord(spec.jobs);
  for (const component of Object.values(spec.components)) {
    component.interfaces = reverseRecord(component.interfaces);
    component.environment = reverseRecord(component.environment);
    component.mounts = reverseRecord(component.mounts);
  }
  return spec;
}

function reverseRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).reverse());
}
