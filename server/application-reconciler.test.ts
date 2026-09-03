import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planApplicationExecution } from './application-execution.ts';
import { reconcileApplication, type ActualComponentInstance } from './application-reconciler.ts';
import { compileApplicationManifest } from './application-spec.ts';

const spec = compileApplicationManifest({
  apiVersion: 'deploy.local/v1',
  kind: 'Application',
  components: {
    db: { image: 'postgres:18', interfaces: { postgres: { port: 5432, protocol: 'postgres' } } },
    web: {
      image: 'example/web:2',
      instances: 2,
      dependsOn: ['db'],
      interfaces: { http: { port: 3000, protocol: 'http' } },
    },
  },
  routes: { public: { to: 'web.http' } },
}).spec;
const execution = planApplicationExecution('notes', spec);
const configurationDigest = 'sha256:configuration';

function instance(
  input: Partial<ActualComponentInstance> &
    Pick<ActualComponentInstance, 'id' | 'component' | 'slot'>,
): ActualComponentInstance {
  const serviceId = input.component === 'web' ? 'notes/web/http' : 'notes/db/postgres';
  return {
    releaseDigest: execution.specDigest,
    configurationDigest,
    status: 'ready',
    endpoints: [
      {
        id: `${input.id}-endpoint`,
        serviceId,
        host: '127.0.0.1',
        port: input.component === 'web' ? 3000 : 5432,
      },
    ],
    ...input,
  };
}

describe('application instance reconciliation', () => {
  it('blocks only a component with unresolved configuration and its dependency closure', () => {
    const gatedSpec = compileApplicationManifest({
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      configuration: { token: { type: 'secret', required: true } },
      components: {
        gated: {
          image: 'example/gated:1',
          environment: { TOKEN: { from: 'configuration.token' } },
        },
        dependent: { image: 'example/dependent:1', dependsOn: ['gated'] },
        independent: { image: 'example/independent:1' },
      },
    }).spec;
    const gatedExecution = planApplicationExecution('closure', gatedSpec, {
      unresolvedConfiguration: new Set(['token']),
    });
    const plan = reconcileApplication(gatedExecution, [], { configurationDigest });

    assert.equal(plan.state, 'blocked');
    assert.equal(plan.components.gated.state, 'blocked');
    assert.equal(plan.components.dependent.state, 'blocked');
    assert.equal(plan.components.independent.state, 'progressing');
    assert.deepEqual(
      plan.actions.filter((item) => item.type === 'create-instance').map((item) => item.component),
      ['independent'],
    );
  });

  it('starts components in dependency order and creates fixed instance slots', () => {
    const empty = reconcileApplication(execution, [], { configurationDigest });
    assert.deepEqual(
      empty.actions.filter((item) => item.type === 'create-instance').map((item) => item.component),
      ['db'],
    );
    assert.equal(empty.components.web.state, 'waiting');

    const db = instance({ id: 'db-1', component: 'db', slot: 'notes/db/1' });
    const next = reconcileApplication(execution, [db], { configurationDigest });
    assert.deepEqual(
      next.actions
        .filter((item) => item.type === 'create-instance')
        .map((item) => ('slot' in item ? item.slot : '')),
      ['notes/web/1', 'notes/web/2'],
    );
  });

  it('keeps an accepted old endpoint serving until a healthy replacement is ready', () => {
    const oldRelease = 'sha256:previous';
    const db = instance({ id: 'db-1', component: 'db', slot: 'notes/db/1' });
    const old = instance({
      id: 'web-old',
      component: 'web',
      slot: 'notes/web/1',
      releaseDigest: oldRelease,
    });
    const web2 = instance({ id: 'web-2', component: 'web', slot: 'notes/web/2' });
    const admitted = new Set(['web-old-endpoint', 'web-2-endpoint']);
    const rolling = reconcileApplication(execution, [db, old, web2], {
      configurationDigest,
      acceptedReleaseDigests: new Set([oldRelease]),
      admittedEndpointIds: admitted,
      now: 1_000,
    });

    assert.ok(
      rolling.actions.some(
        (item) => item.type === 'create-instance' && item.replaces === 'web-old',
      ),
    );
    assert.ok(
      !rolling.actions.some(
        (item) => item.type === 'withdraw-endpoint' && item.endpointId === 'web-old-endpoint',
      ),
    );
    assert.equal(rolling.components.web.state, 'degraded');

    const replacement = instance({
      id: 'web-new',
      component: 'web',
      slot: 'notes/web/1',
    });
    const cutover = reconcileApplication(execution, [db, old, replacement, web2], {
      configurationDigest,
      acceptedReleaseDigests: new Set([oldRelease]),
      admittedEndpointIds: admitted,
      now: 1_000,
    });
    assert.ok(
      cutover.actions.some((item) => item.type === 'begin-drain' && item.instanceId === 'web-old'),
    );
    assert.ok(
      cutover.actions.some(
        (item) => item.type === 'admit-endpoint' && item.endpoint.id === 'web-new-endpoint',
      ),
    );
  });

  it('withdraws unready endpoints before replacing failed instances', () => {
    const db = instance({ id: 'db-1', component: 'db', slot: 'notes/db/1' });
    const failed = instance({
      id: 'web-failed',
      component: 'web',
      slot: 'notes/web/1',
      status: 'failed',
    });
    const plan = reconcileApplication(execution, [db, failed], {
      configurationDigest,
      admittedEndpointIds: new Set(['web-failed-endpoint']),
    });
    assert.ok(plan.actions.some((item) => item.type === 'withdraw-endpoint'));
    assert.ok(plan.actions.some((item) => item.type === 'remove-instance'));
    assert.ok(plan.actions.some((item) => item.type === 'create-instance'));
  });

  it('honors rolling surge and stop-before-start rollout strategies', () => {
    const oldRelease = 'sha256:previous';
    const db = instance({ id: 'db-1', component: 'db', slot: 'notes/db/1' });
    const oldOne = instance({
      id: 'web-old-1',
      component: 'web',
      slot: 'notes/web/1',
      releaseDigest: oldRelease,
    });
    const oldTwo = instance({
      id: 'web-old-2',
      component: 'web',
      slot: 'notes/web/2',
      releaseDigest: oldRelease,
    });
    const rollingExecution = structuredClone(execution);
    rollingExecution.components.web.rollout.maxSurge = 1;
    const rolling = reconcileApplication(rollingExecution, [db, oldOne, oldTwo], {
      configurationDigest,
      acceptedReleaseDigests: new Set([oldRelease]),
    });
    assert.equal(
      rolling.actions.filter((item) => item.type === 'create-instance').length,
      1,
      'maxSurge bounds concurrent replacement creation',
    );
    assert.equal(
      rolling.actions.some((item) => item.type === 'begin-drain' && item.component === 'web'),
      false,
    );

    for (const strategy of ['recreate', 'maintenance'] as const) {
      const stopFirst = structuredClone(execution);
      stopFirst.components.web.rollout.strategy = strategy;
      const plan = reconcileApplication(stopFirst, [db, oldOne, oldTwo], {
        configurationDigest,
      });
      assert.equal(
        plan.actions.some((item) => item.type === 'create-instance' && item.component === 'web'),
        false,
      );
      assert.equal(
        plan.actions.filter((item) => item.type === 'begin-drain' && item.component === 'web')
          .length,
        2,
      );
    }
  });

  it('does not spend unavailable capacity below minimumReady', () => {
    const oldRelease = 'sha256:previous';
    const db = instance({ id: 'db-1', component: 'db', slot: 'notes/db/1' });
    const oldOne = instance({
      id: 'web-old-1',
      component: 'web',
      slot: 'notes/web/1',
      releaseDigest: oldRelease,
    });
    const oldTwo = instance({
      id: 'web-old-2',
      component: 'web',
      slot: 'notes/web/2',
      releaseDigest: oldRelease,
    });
    const noSurge = structuredClone(execution);
    noSurge.components.web.minimumReady = 2;
    noSurge.components.web.rollout.maxSurge = 0;
    noSurge.components.web.rollout.maxUnavailable = 1;

    const plan = reconcileApplication(noSurge, [db, oldOne, oldTwo], {
      configurationDigest,
      acceptedReleaseDigests: new Set([oldRelease]),
    });
    assert.equal(
      plan.actions.some((item) => item.type === 'begin-drain' && item.component === 'web'),
      false,
    );
    assert.equal(
      plan.actions.some((item) => item.type === 'create-instance' && item.component === 'web'),
      false,
    );
  });
});
