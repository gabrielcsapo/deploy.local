import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readDeployConfig, readDeploymentDefinition } from './deploy-config.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-config-'));
  dirs.push(dir);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  return dir;
}

const SIMPLE_YAML = `apiVersion: deploy.local/v1
kind: Application
components:
  web:
    build:
      context: .
    role: web
    interfaces:
      http:
        port: 8080
        protocol: http
routes:
  public:
    to: web.http
`;

describe('deployment definition discovery', () => {
  it('discovers and compiles deploy.yaml', () => {
    const definition = readDeploymentDefinition(project({ 'deploy.yaml': SIMPLE_YAML }));

    assert.equal(definition.format, 'deploy.yaml');
    assert.equal(definition.source, SIMPLE_YAML);
    assert.equal(definition.compiled.spec.apiVersion, 'deploy.local/v1');
    assert.equal(definition.compiled.spec.components.web.interfaces.http.port, 8080);
    assert.match(definition.compiled.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(definition.legacyRuntime?.deployConfig.port, 8080);
  });

  it('requires deploy.yaml', () => {
    assert.throws(
      () => readDeploymentDefinition(project({ 'index.js': '' })),
      /deploy\.yaml is required/,
    );
  });

  it('does not accept the retired JSON manifest', () => {
    assert.throws(
      () => readDeploymentDefinition(project({ 'deploy.json': '{"port":3000}' })),
      /deploy\.yaml is required/,
    );
  });
});

describe('deploy.yaml single-container runtime adapter', () => {
  it('adapts a simple build component without dropping supported intent', () => {
    const definition = readDeploymentDefinition(
      project({
        'deploy.yaml': `apiVersion: deploy.local/v1
kind: Application
configuration:
  apiToken:
    type: secret
    required: true
components:
  app:
    build:
      context: .
      ignore: [docs]
    role: web
    interfaces:
      http:
        port: 8080
        protocol: http
      metrics:
        port: 9090
        protocol: tcp
      dns:
        port: 5353
        protocol: udp
    environment:
      API_TOKEN:
        from: configuration.apiToken
    mounts:
      /srv/files:
        resource: files
        readOnly: true
    runtime:
      gpus: true
      privilegedDocker: true
      runArgs: [--dns, 172.30.0.10]
      networks:
        - name: app-network
          subnet: 172.30.0.0/24
          labels:
            com.example.scope: private
resources:
  files:
    type: volume
    source:
      type: bind
      hostPath: /srv/app-files
routes:
  public:
    to: app.http
    discoverable: true
    cache:
      paths: [/assets/*]
`,
      }),
    );

    assert.deepEqual(definition.legacyRuntime, {
      componentName: 'app',
      environment: { API_TOKEN: { from: 'configuration.apiToken' } },
      deployConfig: {
        port: 8080,
        ports: [
          { container: 5353, protocol: 'udp' },
          { container: 9090, protocol: 'tcp' },
        ],
        discoverable: true,
        volumes: [{ hostPath: '/srv/app-files', containerPath: '/srv/files', readOnly: true }],
        ignore: ['docs'],
        cache: {
          enabled: true,
          maxAge: 60,
          paths: ['/assets/*'],
          maxObjectBytes: 2 * 1024 * 1024,
        },
        gpus: true,
        privilegedDocker: true,
        docker: {
          runArgs: ['--dns', '172.30.0.10'],
          networks: [
            {
              name: 'app-network',
              subnet: '172.30.0.0/24',
              labels: { 'com.example.scope': 'private' },
            },
          ],
        },
      },
    });
    assert.deepEqual(readDeployConfig(project({ 'deploy.yaml': SIMPLE_YAML })), {
      port: 8080,
      discoverable: false,
      gpus: false,
      privilegedDocker: false,
    });
  });

  it('routes graph features to the graph executor while still rejecting unsafe Docker overrides', () => {
    const graphManifests = [
      {
        source: `apiVersion: deploy.local/v1
kind: Application
components:
  web:
    build: { context: . }
    interfaces:
      http: { port: 3000, protocol: http }
  worker:
    build: { context: . }
routes:
  public: { to: web.http }
`,
      },
      {
        source: SIMPLE_YAML.replace('role: web', 'role: web\n    instances: 2'),
      },
      {
        source: SIMPLE_YAML.replace('build:\n      context: .', 'image: example/app:1'),
      },
      {
        source: SIMPLE_YAML.replace('role: web', 'role: web\n    profile: deploy.local/example@1'),
      },
      {
        source: SIMPLE_YAML.replace(
          'routes:',
          'jobs:\n  migrate:\n    component: web\n    command: [npm, run, migrate]\nroutes:',
        ),
      },
      {
        source: SIMPLE_YAML.replace(
          'routes:\n  public:',
          'resources:\n  data:\n    type: volume\nroutes:\n  public:',
        ),
      },
      {
        source: SIMPLE_YAML.replace('public:', 'internal:'),
      },
    ];

    for (const { source } of graphManifests) {
      const definition = readDeploymentDefinition(project({ 'deploy.yaml': source }));
      assert.equal(definition.format, 'deploy.yaml');
      assert.equal(definition.legacyRuntime, null);
    }
    assert.throws(
      () =>
        readDeploymentDefinition(
          project({
            'deploy.yaml': SIMPLE_YAML.replace(
              'role: web',
              'role: web\n    runtime:\n      runArgs: [--name, unsafe]',
            ),
          }),
        ),
      /cannot use Docker argument "--name"/,
    );
  });
});
