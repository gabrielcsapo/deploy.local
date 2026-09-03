import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { compileDeployYaml } from './application-spec.ts';

const dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-runtime-'));
process.env.DEPLOY_DATA_DIR = dataDirectory;
const store = await import('./store.ts');
const configuration = await import('./application-configuration.ts');
const runtime = await import('./application-runtime.ts');

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

const compiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  token:
    type: secret
    required: true
    scope: site
components:
  web:
    build: { context: . }
    interfaces:
      http: { port: 3000, protocol: http }
    environment:
      TOKEN: { from: configuration.token }
routes:
  public: { to: web.http }
`);

const graphCompiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  database:
    image: postgres:18
    profile: deploy.local/postgres@1
    interfaces:
      postgres: { port: 5432, protocol: postgres }
    mounts:
      /var/lib/postgresql/data: { resource: database }
  web:
    build: { context: . }
    instances: 2
    environment:
      DATABASE: { from: database.postgres }
    interfaces:
      http: { port: 3000, protocol: http }
resources:
  database:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
routes:
  public: { to: web.http }
`);

describe('active application runtime resolution', () => {
  it('gates missing site configuration and resolves encrypted values from the active spec', () => {
    store.saveDeployment({ name: 'notes', username: 'alice', activeNodeId: 'coordinator' });
    store.saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: 'notes',
      apiVersion: compiled.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.canonicalJson,
      createdBy: 'alice',
    });
    store.activateDesiredApplicationSpec('notes', compiled.digest);

    let resolved = runtime.resolveDeploymentRuntime(store.getDeployment('notes')!);
    assert.equal(resolved.ready, false);
    assert.deepEqual(resolved.missing, ['token']);
    assert.deepEqual(resolved.environment, {});

    configuration.setDeclaredConfigurationValue({
      deploymentName: 'notes',
      specDigest: compiled.digest,
      declarations: compiled.spec.configuration,
      key: 'token',
      value: 'portable-secret',
      siteId: 'coordinator',
      updatedBy: 'alice',
    });
    resolved = runtime.resolveDeploymentRuntime(store.getDeployment('notes')!);
    assert.equal(resolved.ready, true);
    assert.deepEqual(resolved.environment, { TOKEN: 'portable-secret' });
    assert.equal(resolved.format, 'deploy.yaml');
    assert.match(resolved.configurationDigest || '', /^sha256:/);
  });

  it('resolves a multi-component image/build graph without the legacy adapter boundary', () => {
    store.saveDeployment({ name: 'graph-notes', username: 'alice', activeNodeId: 'coordinator' });
    store.saveDesiredApplicationSpec({
      digest: graphCompiled.digest,
      deploymentName: 'graph-notes',
      apiVersion: graphCompiled.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: graphCompiled.canonicalJson,
      createdBy: 'alice',
    });
    store.activateDesiredApplicationSpec('graph-notes', graphCompiled.digest);

    const resolved = runtime.resolveApplicationGraphRuntime(store.getDeployment('graph-notes')!);
    assert.equal(resolved.ready, true);
    assert.deepEqual(resolved.execution.componentOrder, ['database', 'web']);
    assert.equal(resolved.execution.components.web.desiredInstances, 2);
    assert.equal(resolved.componentEnvironment.web.DATABASE, 'database.graph-notes.internal:5432');
  });
});
