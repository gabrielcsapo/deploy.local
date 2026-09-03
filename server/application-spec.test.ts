import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApplicationManifestError,
  compileApplicationManifest,
  compileDeployYaml,
  parseApplicationManifest,
  parseRepositoryBaseDigest,
  renderDeployYaml,
  renderRepositoryDeployYaml,
} from './application-spec.ts';

const GRAPH_MANIFEST = `
apiVersion: deploy.local/v1
kind: Application

metadata:
  name: notes
  labels:
    tier: personal

configuration:
  adminPassword:
    type: secret
    required: true
  logLevel:
    type: string
    default: info
    allowedValues: [warn, info, debug]

components:
  web:
    build:
      context: .
    role: web
    instances: 2
    interfaces:
      http:
        port: 3000
        protocol: http
    environment:
      ADMIN_PASSWORD:
        from: configuration.adminPassword
      DATABASE_URL:
        from: db.postgres
    mounts:
      /app/uploads:
        resource: uploads
    health:
      interface: http
      path: /health
  db:
    image: postgres:18
    profile: deploy.local/postgres@1
    interfaces:
      postgres:
        port: 5432
        protocol: postgres
    mounts:
      /var/lib/postgresql/data:
        resource: database

resources:
  uploads:
    type: volume
  database:
    type: volume
    dataRole: database

jobs:
  migrate:
    component: web
    command: [npm, run, migrate]
    environment:
      DATABASE_URL:
        from: db.postgres
    beforeTraffic: true

routes:
  public:
    hostname: notes.local
    to: web.http
`;

describe('deploy.yaml application graph', () => {
  it('parses references and compiles a fully-defaulted ApplicationSpec', () => {
    const result = compileDeployYaml(GRAPH_MANIFEST);

    assert.equal(result.spec.apiVersion, 'deploy.local/v1');
    assert.equal(result.spec.components.web.instances, 2);
    assert.equal(result.spec.components.db.instances, 1);
    assert.deepEqual(result.spec.components.web.environment.ADMIN_PASSWORD, {
      from: 'configuration.adminPassword',
    });
    assert.deepEqual(result.spec.configuration.adminPassword, {
      type: 'secret',
      required: true,
      scope: 'application',
    });
    assert.deepEqual(result.spec.configuration.logLevel.allowedValues, ['debug', 'info', 'warn']);
    assert.deepEqual(result.spec.resources.database, {
      type: 'volume',
      durability: 'durable',
      dataRole: 'database',
      access: 'singleWriter',
      consistencyGroup: 'application',
      ownership: 'application',
      backup: { policy: 'include', retentionCopies: 1 },
      suitcase: {
        allowedDataModes: ['follows-one-site', 'site-local', 'syncs-across-sites'],
      },
    });
    assert.deepEqual(result.spec.routes.public, {
      to: 'web.http',
      hostname: 'notes.local',
      path: '/',
      discoverable: false,
    });
    assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.canonicalJson.includes('adminPassword'), true);
    assert.equal(result.canonicalJson.includes('password-value'), false);
  });

  it('produces the same digest regardless of YAML comments and map ordering', () => {
    const reordered = `
kind: Application
components:
  db:
    mounts:
      /var/lib/postgresql/data: { resource: database }
    interfaces:
      postgres: { protocol: postgres, port: 5432 }
    profile: deploy.local/postgres@1
    image: postgres:18
  web:
    health: { path: /health, interface: http }
    mounts:
      /app/uploads: { resource: uploads }
    environment:
      DATABASE_URL: { from: db.postgres }
      ADMIN_PASSWORD: { from: configuration.adminPassword }
    interfaces:
      http: { protocol: http, port: 3000 }
    instances: 2
    role: web
    build: { context: . }
apiVersion: deploy.local/v1
configuration:
  logLevel: { allowedValues: [debug, warn, info], default: info, type: string }
  adminPassword: { required: true, type: secret }
metadata:
  labels: { tier: personal }
  name: notes
resources:
  database: { dataRole: database, type: volume }
  uploads: { type: volume }
routes:
  public: { to: web.http, hostname: notes.local }
jobs:
  migrate:
    beforeTraffic: true
    environment: { DATABASE_URL: { from: db.postgres } }
    command: [npm, run, migrate]
    component: web
# Comments and formatting are not application identity.
`;

    assert.equal(compileDeployYaml(reordered).digest, compileDeployYaml(GRAPH_MANIFEST).digest);
  });

  it('exports a normalized revision as digest-equivalent deploy.yaml', () => {
    const compiled = compileDeployYaml(GRAPH_MANIFEST);
    const exported = renderDeployYaml(compiled.spec);
    const roundTrip = compileDeployYaml(exported);

    assert.equal(roundTrip.digest, compiled.digest);
    assert.match(exported, /^apiVersion: deploy\.local\/v1/m);
  });

  it('retains explicit reconciliation exclusions and conflict policy as portable intent', () => {
    const compiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/notes
    mounts:
      /app/data: { resource: data }
resources:
  data:
    type: volume
    dataRole: database
    reconciliation:
      excludeTables: [sessions, local_cache]
      excludePaths: [thumbnails, tmp/previews]
      conflictPolicy: prefer-home
`);
    assert.deepEqual(compiled.spec.resources.data.reconciliation, {
      excludeTables: ['local_cache', 'sessions'],
      excludePaths: ['thumbnails', 'tmp/previews'],
      conflictPolicy: 'prefer-home',
    });
    assert.equal(compileDeployYaml(renderDeployYaml(compiled.spec)).digest, compiled.digest);

    assert.throws(
      () =>
        compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components: { web: { image: example/notes } }
resources:
  data:
    type: volume
    reconciliation: { excludePaths: [/host/path, ../escape] }
`),
      /relative path without "\.\."/,
    );
  });

  it('normalizes the public component and volume portability contracts', () => {
    const result = compileApplicationManifest({
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      components: {
        api: {
          displayName: 'Public API',
          image: 'example.invalid/api:v1',
          instances: 3,
          minimumReady: 2,
          rollout: {
            strategy: 'rolling',
            maxSurge: 2,
            maxUnavailable: 1,
            schemaOverlap: 'compatible',
          },
          siteOverrides: { allowed: true, minimum: 1, maximum: 6 },
          capacity: {
            memoryBytes: 536_870_912,
            cpuMillicores: 750,
            ephemeralStorageBytes: 1_073_741_824,
            buildMemoryBytes: 805_306_368,
          },
          placement: { intent: 'spread', requiredLabels: { storage: 'ssd', zone: 'inside' } },
          mounts: { '/srv/uploads': { resource: 'uploads' } },
        },
      },
      resources: {
        uploads: {
          displayName: 'Uploaded files',
          type: 'volume',
          durability: 'durable',
          dataRole: 'files',
          consistencyGroup: 'user-content',
          ownership: 'application',
          backup: { policy: 'required', retentionCopies: 7 },
          suitcase: { allowedDataModes: ['site-local', 'syncs-across-sites'] },
        },
      },
    }).spec;

    assert.deepEqual(result.components.api.rollout, {
      strategy: 'rolling',
      maxSurge: 2,
      maxUnavailable: 1,
      schemaOverlap: 'compatible',
    });
    assert.deepEqual(result.components.api.siteOverrides, {
      allowed: true,
      minimum: 1,
      maximum: 6,
    });
    assert.deepEqual(result.components.api.capacity, {
      memoryBytes: 536_870_912,
      cpuMillicores: 750,
      ephemeralStorageBytes: 1_073_741_824,
      buildMemoryBytes: 805_306_368,
    });
    assert.deepEqual(result.components.api.placement, {
      intent: 'spread',
      requiredLabels: { storage: 'ssd', zone: 'inside' },
    });
    assert.deepEqual(result.resources.uploads, {
      displayName: 'Uploaded files',
      type: 'volume',
      durability: 'durable',
      dataRole: 'files',
      access: 'singleWriter',
      consistencyGroup: 'user-content',
      ownership: 'application',
      backup: { policy: 'required', retentionCopies: 7 },
      suitcase: { allowedDataModes: ['site-local', 'syncs-across-sites'] },
    });
  });

  it('requires safe schema overlap for an explicitly rolling component', () => {
    assert.throws(
      () =>
        compileApplicationManifest({
          apiVersion: 'deploy.local/v1',
          kind: 'Application',
          components: {
            api: {
              image: 'example.invalid/api:v1',
              rollout: { strategy: 'rolling' },
            },
          },
        }),
      /schemaOverlap must be "compatible"/,
    );
  });

  it('carries repository ancestry outside the normalized application digest', () => {
    const compiled = compileDeployYaml(GRAPH_MANIFEST);
    const exported = renderRepositoryDeployYaml(compiled.spec, compiled.digest);

    assert.equal(parseRepositoryBaseDigest(exported), compiled.digest);
    assert.equal(compileDeployYaml(exported).digest, compiled.digest);
  });

  it('normalizes Unicode allowed values without using the host locale', () => {
    const result = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  language:
    type: string
    allowedValues: [ä, z, A]
components:
  web: { image: example/web }
`);

    assert.deepEqual(result.spec.configuration.language.allowedValues, ['A', 'z', 'ä']);
  });

  it('validates rich configuration types and read-only file projections', () => {
    const result = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  retries: { type: integer, default: 3 }
  endpoint: { type: url, default: https://example.test/api }
  mode: { type: enum, allowedValues: [safe, fast], default: safe }
  policy: { type: file, required: true }
components:
  web:
    image: example/web
    environment:
      RETRIES: { from: configuration.retries }
      ENDPOINT: { from: configuration.endpoint }
      MODE: { from: configuration.mode }
    configurationFiles:
      /run/deploy/policy.json: { from: configuration.policy }
`);

    assert.equal(result.spec.configuration.retries.type, 'integer');
    assert.equal(result.spec.configuration.endpoint.type, 'url');
    assert.deepEqual(result.spec.configuration.mode.allowedValues, ['fast', 'safe']);
    assert.deepEqual(result.spec.components.web.configurationFiles, {
      '/run/deploy/policy.json': { from: 'configuration.policy' },
    });

    assert.throws(
      () =>
        compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  mode: { type: enum }
  endpoint: { type: url, default: not-a-url }
components:
  web:
    image: example/web
    configurationFiles:
      relative.txt: { from: other.http }
`),
      /allowedValues is required|absolute URL|must be absolute|must reference declared configuration/,
    );
  });

  it('rejects unknown fields and invalid graph references', () => {
    assert.throws(
      () =>
        compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/web
    magic: true
    environment:
      DATABASE_URL: { from: missing.postgres }
routes:
  public: { to: web.http }
`),
      (error: unknown) => {
        assert(error instanceof ApplicationManifestError);
        assert.match(error.message, /unknown field "magic"/);
        assert.match(error.message, /unknown component "missing"/);
        assert.match(error.message, /unknown interface "web.http"/);
        return true;
      },
    );
  });

  it('rejects object-prototype keys in user-defined maps', () => {
    assert.throws(
      () =>
        compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  __proto__: { type: string }
components:
  web:
    image: example/web
    environment:
      constructor: { from: configuration.__proto__ }
`),
      /reserved configuration name "__proto__"|invalid variable name "constructor"/,
    );
    assert.throws(
      () =>
        compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/web
    environment:
      PASSWORD: { from: configuration.__proto__ }
`),
      /unknown configuration "__proto__"/,
    );
  });

  it('rejects secret values in the manifest', () => {
    assert.throws(
      () =>
        compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
configuration:
  password:
    type: secret
    default: password-value
components:
  web: { image: example/web }
`),
      /default is not allowed for secret configuration/,
    );
  });

  it('normalizes explicit host privilege and devices while rejecting escape-hatch equivalents', () => {
    const compiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  assistant:
    image: example/assistant
    runtime:
      networkMode: host
      privileged: true
      devices:
        - hostPath: /dev/ttyUSB0
          containerPath: /dev/zigbee
          permissions: rw
`);

    assert.equal(compiled.spec.components.assistant.runtime.networkMode, 'host');
    assert.equal(compiled.spec.components.assistant.runtime.privileged, true);
    assert.deepEqual(compiled.spec.components.assistant.runtime.devices, [
      {
        hostPath: '/dev/ttyUSB0',
        containerPath: '/dev/zigbee',
        permissions: 'rw',
      },
    ]);

    assert.throws(
      () =>
        compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  assistant:
    image: example/assistant
    runtime:
      runArgs: [--privileged]
`),
      /use typed runtime fields/,
    );
  });
});

describe('restricted YAML parsing', () => {
  const document = (body: string) => `
apiVersion: deploy.local/v1
kind: Application
components:
${body}
`;

  it('rejects duplicate mapping keys', () => {
    assert.throws(
      () => parseApplicationManifest(document('  web: { image: one }\n  web: { image: two }')),
      /Map keys must be unique/,
    );
  });

  it('rejects custom tags', () => {
    assert.throws(
      () => parseApplicationManifest(document('  web: { image: !include image.txt }')),
      /Unresolved tag/,
    );
  });

  it('rejects YAML 1.1 and custom tag directives', () => {
    assert.throws(
      () =>
        parseApplicationManifest(
          `%YAML 1.1\n---\n${document('  web: { image: example/web }').trimStart()}`,
        ),
      /only YAML 1.2 documents are supported/,
    );
    assert.throws(
      () =>
        parseApplicationManifest(
          `%TAG !example! tag:example.com,2026:\n---\n${document('  web: { image: example/web }').trimStart()}`,
        ),
      /custom YAML tag directives are not supported/,
    );
  });

  it('rejects anchors, aliases, and merge keys', () => {
    assert.throws(
      () => parseApplicationManifest(document('  web: &web { image: example/web }')),
      /anchors are not supported/,
    );
    assert.throws(
      () =>
        parseApplicationManifest(
          document('  base: &base { image: example/base }\n  web:\n    <<: *base'),
        ),
      /anchors are not supported|aliases are not supported/,
    );
  });

  it('rejects component dependency cycles', () => {
    assert.throws(
      () =>
        compileDeployYaml(
          document(
            '  web: { image: example/web, dependsOn: [worker] }\n  worker: { image: example/worker, dependsOn: [web] }',
          ),
        ),
      /dependency cycle: web -> worker -> web/,
    );
  });
});
