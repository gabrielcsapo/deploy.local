import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { compileDeployYaml, type ApplicationSpec } from './application-spec.ts';

const dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-configuration-'));
process.env.DEPLOY_DATA_DIR = dataDirectory;
const configuration = await import('./application-configuration.ts');
const store = await import('./store.ts');
const SPEC_DIGEST = 'sha256:configuration-test';

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

const declarations: ApplicationSpec['configuration'] = {
  adminPassword: {
    type: 'secret',
    required: true,
    scope: 'application',
  },
  logLevel: {
    type: 'string',
    required: false,
    default: 'info',
    allowedValues: ['debug', 'info'],
    scope: 'application',
  },
  deviceToken: {
    type: 'secret',
    required: true,
    scope: 'site',
  },
};

describe('declared application configuration', () => {
  it('gates readiness until application and site values resolve', () => {
    store.saveDeployment({ name: 'notes', username: 'alice' });
    let resolved = configuration.resolveApplicationConfiguration({
      deploymentName: 'notes',
      specDigest: SPEC_DIGEST,
      declarations,
      siteId: 'suitcase-a',
    });
    assert.deepEqual(resolved.missing, ['adminPassword', 'deviceToken']);
    assert.equal(resolved.values.logLevel, 'info');

    configuration.setDeclaredConfigurationValue({
      deploymentName: 'notes',
      specDigest: SPEC_DIGEST,
      declarations,
      key: 'adminPassword',
      value: 'home-secret',
      updatedBy: 'alice',
    });
    configuration.setDeclaredConfigurationValue({
      deploymentName: 'notes',
      specDigest: SPEC_DIGEST,
      declarations,
      key: 'deviceToken',
      value: 'suitcase-secret',
      siteId: 'suitcase-a',
      updatedBy: 'alice',
    });
    resolved = configuration.resolveApplicationConfiguration({
      deploymentName: 'notes',
      specDigest: SPEC_DIGEST,
      declarations,
      siteId: 'suitcase-a',
    });

    assert.equal(resolved.ready, true);
    assert.equal(resolved.values.adminPassword, 'home-secret');
    assert.equal(resolved.values.deviceToken, 'suitcase-secret');
    assert.equal(
      store.getDeployment('notes')?.configurationDigest,
      null,
      'resolving configuration must not mutate the applied runtime digest',
    );
    const stored = store.getApplicationConfigurationValues('notes', SPEC_DIGEST)[0];
    assert.equal(stored.value.includes('home-secret'), false);
  });

  it('rejects undeclared, mistyped, and incorrectly scoped values', () => {
    assert.throws(
      () =>
        configuration.setDeclaredConfigurationValue({
          deploymentName: 'notes',
          specDigest: SPEC_DIGEST,
          declarations,
          key: 'unknown',
          value: 'value',
          updatedBy: 'alice',
        }),
      /Unknown declared configuration/,
    );
    assert.throws(
      () =>
        configuration.setDeclaredConfigurationValue({
          deploymentName: 'notes',
          specDigest: SPEC_DIGEST,
          declarations,
          key: 'logLevel',
          value: 'trace',
          updatedBy: 'alice',
        }),
      /allowed values/,
    );
    assert.throws(
      () =>
        configuration.setDeclaredConfigurationValue({
          deploymentName: 'notes',
          specDigest: SPEC_DIGEST,
          declarations,
          key: 'deviceToken',
          value: 'token',
          updatedBy: 'alice',
        }),
      /requires a site/,
    );
    assert.throws(
      () =>
        configuration.setDeclaredConfigurationValue({
          deploymentName: 'notes',
          specDigest: SPEC_DIGEST,
          declarations,
          key: 'adminPassword',
          value: 'x'.repeat(64 * 1024),
          updatedBy: 'alice',
        }),
      /64 KiB value limit/,
    );
  });

  it('validates integer, URL, enum, and file values at the server boundary', () => {
    const rich = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  retries: { type: integer, required: true }
  endpoint: { type: url, required: true }
  mode: { type: enum, required: true, allowedValues: [safe, fast] }
  policy: { type: file, required: true }
components:
  web: { image: example/web }
`).spec.configuration;
    const values = {
      retries: 3,
      endpoint: 'https://example.test/api',
      mode: 'safe',
      policy: '{"enabled":true}',
    } as const;
    for (const [key, value] of Object.entries(values)) {
      configuration.setDeclaredConfigurationValue({
        deploymentName: 'rich-config',
        specDigest: SPEC_DIGEST,
        declarations: rich,
        key,
        value,
        updatedBy: 'alice',
      });
    }
    assert.deepEqual(
      configuration.resolveApplicationConfiguration({
        deploymentName: 'rich-config',
        specDigest: SPEC_DIGEST,
        declarations: rich,
      }).values,
      values,
    );
    assert.throws(
      () =>
        configuration.setDeclaredConfigurationValue({
          deploymentName: 'rich-config',
          specDigest: SPEC_DIGEST,
          declarations: rich,
          key: 'retries',
          value: 1.5,
          updatedBy: 'alice',
        }),
      /must be integer/,
    );
    assert.throws(
      () =>
        configuration.setDeclaredConfigurationValue({
          deploymentName: 'rich-config',
          specDigest: SPEC_DIGEST,
          declarations: rich,
          key: 'endpoint',
          value: 'relative/path',
          updatedBy: 'alice',
        }),
      /must be url/,
    );
  });

  it('omits optional unset values from a component environment', () => {
    const spec = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  optionalToken:
    type: secret
components:
  web:
    image: example/web
    environment:
      OPTIONAL_TOKEN: { from: configuration.optionalToken }
`).spec;
    const resolved = configuration.resolveApplicationConfiguration({
      deploymentName: 'optional-app',
      specDigest: SPEC_DIGEST,
      declarations: spec.configuration,
    });

    assert.equal(resolved.ready, true);
    assert.deepEqual(
      configuration.resolveComponentEnvironment({
        spec,
        component: 'web',
        configuration: resolved.values,
      }).environment,
      {},
    );
  });

  it('isolates releases and carries values only across compatible declarations', () => {
    const source = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
metadata: { description: first }
configuration:
  mode: { type: string, required: true, allowedValues: [safe, fast] }
  token: { type: secret, required: true }
components:
  web:
    build: { context: . }
    interfaces: { http: { port: 3000, protocol: http } }
routes: { public: { to: web.http } }
`);
    const compatible = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
metadata: { description: second }
configuration:
  mode: { type: string, required: true, allowedValues: [safe, fast] }
  token: { type: secret, required: true, description: rotated later }
components:
  web:
    build: { context: . }
    interfaces: { http: { port: 3000, protocol: http } }
routes: { public: { to: web.http } }
`);
    const incompatible = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
metadata: { description: third }
configuration:
  mode: { type: string, required: true, allowedValues: [slow] }
  token: { type: number, required: true }
components:
  web:
    build: { context: . }
    interfaces: { http: { port: 3000, protocol: http } }
routes: { public: { to: web.http } }
`);

    for (const [key, value] of [
      ['mode', 'safe'],
      ['token', 'release-secret'],
    ] as const) {
      configuration.setDeclaredConfigurationValue({
        deploymentName: 'revisioned',
        specDigest: source.digest,
        declarations: source.spec.configuration,
        key,
        value,
        updatedBy: 'alice',
      });
    }

    assert.equal(
      configuration.carryForwardCompatibleConfiguration({
        deploymentName: 'revisioned',
        fromSpec: source.spec,
        fromDigest: source.digest,
        toSpec: compatible.spec,
        toDigest: compatible.digest,
        updatedBy: 'alice',
      }),
      2,
    );
    assert.deepEqual(
      configuration.resolveApplicationConfiguration({
        deploymentName: 'revisioned',
        specDigest: compatible.digest,
        declarations: compatible.spec.configuration,
      }).values,
      { mode: 'safe', token: 'release-secret' },
    );

    assert.equal(
      configuration.carryForwardCompatibleConfiguration({
        deploymentName: 'revisioned',
        fromSpec: compatible.spec,
        fromDigest: compatible.digest,
        toSpec: incompatible.spec,
        toDigest: incompatible.digest,
        updatedBy: 'alice',
      }),
      0,
    );
    assert.deepEqual(
      configuration.resolveApplicationConfiguration({
        deploymentName: 'revisioned',
        specDigest: incompatible.digest,
        declarations: incompatible.spec.configuration,
      }).missing,
      ['mode', 'token'],
    );
    assert.equal(
      configuration.resolveApplicationConfiguration({
        deploymentName: 'revisioned',
        specDigest: source.digest,
        declarations: source.spec.configuration,
      }).ready,
      true,
      'editing desired declarations must not damage the active release values',
    );
  });
});
