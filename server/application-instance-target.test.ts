import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let dataDirectory: string;
let store: typeof import('./store.ts');
let specs: typeof import('./application-spec.ts');
let targets: typeof import('./application-instance-target.ts');

before(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-instance-target-'));
  process.env.DEPLOY_DATA_DIR = dataDirectory;
  store = await import('./store.ts');
  specs = await import('./application-spec.ts');
  targets = await import('./application-instance-target.ts');
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('application instance target resolution', () => {
  it('preserves legacy targeting and rejects graph-only or foreign-site selectors', () => {
    store.saveDeployment({
      name: 'legacy-notes',
      username: 'alice',
      activeNodeId: 'node-legacy',
      containerName: 'deploy-sh-legacy-notes',
    });

    assert.deepEqual(targets.resolveApplicationInstanceTarget('legacy-notes'), {
      deploymentName: 'legacy-notes',
      siteId: 'node-legacy',
      nodeId: 'node-legacy',
      component: 'main',
      instanceId: 'legacy',
      slot: 'main',
      containerName: 'deploy-sh-legacy-notes',
      graph: false,
    });
    assert.throws(
      () => targets.resolveApplicationInstanceTarget('legacy-notes', { component: 'web' }),
      /require an application graph/,
    );
    assert.throws(
      () => targets.resolveApplicationInstanceTarget('legacy-notes', { siteId: 'node-other' }),
      /not materialized on site node-other/,
    );
  });

  it('resolves component and instance selectors to exact durable container names', () => {
    const compiled = specs.compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: nginx:1.27
    instances: 2
  worker:
    image: busybox:1.37
    role: worker
`);
    store.saveDeployment({
      name: 'graph-notes',
      username: 'alice',
      activeNodeId: 'site-away',
      containerName: 'deploy-sh-graph-notes-web-2-primary',
    });
    store.saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: 'graph-notes',
      apiVersion: compiled.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.canonicalJson,
      createdBy: 'alice',
    });
    store.activateDesiredApplicationSpec('graph-notes', compiled.digest);
    store
      .getSqlite()!
      .prepare('UPDATE deployments SET app_id = ? WHERE name = ?')
      .run('app-graph-notes', 'graph-notes');
    store._invalidateDeploymentsCache();

    const insert = store.getSqlite()!.prepare(
      `INSERT INTO component_instances
        (id, app_id, deployment_name, site_id, component_key, slot_key, node_id,
         release_digest, configuration_digest, image, container_id, container_name,
         status, health, ready_at, created_at, updated_at)
       VALUES (?, 'app-graph-notes', 'graph-notes', 'site-away', ?, ?, 'node-away',
               ?, 'sha256:config', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insert.run(
      'instance-web-1',
      'web',
      'web/1',
      compiled.digest,
      'nginx:1.27',
      'container-web-1',
      'deploy-sh-graph-notes-web-1-ready',
      'ready',
      'healthy',
      now,
      now,
      now,
    );
    insert.run(
      'instance-web-2',
      'web',
      'web/2',
      compiled.digest,
      'nginx:1.27',
      'container-web-2',
      'deploy-sh-graph-notes-web-2-primary',
      'draining',
      'healthy',
      now,
      now,
      now,
    );
    insert.run(
      'instance-worker-1',
      'worker',
      'worker/1',
      compiled.digest,
      'busybox:1.37',
      'container-worker-1',
      'deploy-sh-graph-notes-worker-1-ready',
      'ready',
      'healthy',
      now,
      now,
      now,
    );

    assert.equal(
      targets.resolveApplicationInstanceTarget('graph-notes').containerName,
      'deploy-sh-graph-notes-web-2-primary',
    );
    const worker = targets.resolveApplicationInstanceTarget('graph-notes', {
      siteId: 'site-away',
      component: 'worker',
    });
    assert.deepEqual(
      {
        nodeId: worker.nodeId,
        component: worker.component,
        instanceId: worker.instanceId,
        slot: worker.slot,
        containerName: worker.containerName,
      },
      {
        nodeId: 'node-away',
        component: 'worker',
        instanceId: 'instance-worker-1',
        slot: 'worker/1',
        containerName: 'deploy-sh-graph-notes-worker-1-ready',
      },
    );
    assert.equal(
      targets.resolveApplicationInstanceTarget('graph-notes', {
        instanceId: 'instance-web-1',
      }).containerName,
      'deploy-sh-graph-notes-web-1-ready',
    );
    assert.throws(
      () =>
        targets.resolveApplicationInstanceTarget('graph-notes', {
          siteId: 'site-home',
          component: 'web',
        }),
      /No component web is materialized on site site-home/,
    );
  });
});
