import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { planApplicationExecution } from './application-execution.ts';
import {
  executeAgentApplicationGraph,
  validateAgentGraphPayload,
  type AgentApplicationGraphPayload,
  type AgentGraphCommandResult,
  type AgentGraphDocker,
} from './agent-graph-runtime.ts';
import { compileDeployYaml } from './application-spec.ts';

const compiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  api:
    image: example/api:1
    instances: 2
    interfaces:
      http: { port: 4000, protocol: http }
    mounts:
      /srv/uploads: { resource: uploads }
  web:
    build: { context: . }
    dependsOn: [api]
    interfaces:
      http: { port: 3000, protocol: http }
    environment:
      API_URL: { from: api.http }
routes:
  public: { to: web.http, path: / }
resources:
  uploads:
    type: volume
    durability: durable
    dataRole: files
    access: sharedWriters
jobs:
  prepare:
    component: api
    command: [sh, -c, prepare]
    execution: perSite
`);

function graphPayload(): AgentApplicationGraphPayload {
  const execution = planApplicationExecution('graph-notes', compiled.spec, {
    specDigest: compiled.digest,
    volumeCapabilities: { sharedWriterResources: new Set(['uploads']) },
  });
  assert.equal(execution.blocked, false);
  return {
    version: 1,
    applicationId: 'graph-notes',
    siteId: 'node-away',
    writerSiteId: 'node-away',
    specDigest: compiled.digest,
    configurationDigest: `sha256:${'1'.repeat(64)}`,
    spec: compiled.spec,
    execution,
    configurationValues: {},
    componentEnvironment: { api: {}, web: {} },
    profileValues: {},
    runtimeVolumeMounts: [
      {
        component: 'api',
        hostPath: '/Volumes/library',
        containerPath: '/srv/library',
        readOnly: true,
      },
    ],
  };
}

class FakeDocker implements AgentGraphDocker {
  commands: string[][] = [];
  containers = new Map<string, string>();

  async run(args: readonly string[]): Promise<AgentGraphCommandResult> {
    const command = [...args];
    this.commands.push(command);
    if (command[0] === 'network' && command[1] === 'inspect') return failure();
    if (command[0] === 'image' && command[1] === 'inspect') return success('image\n');
    if (command[0] === 'ps') {
      return success(
        [...this.containers].map(([name, component]) => `${name}\t${component}`).join('\n'),
      );
    }
    if (command[0] === 'create') {
      const name = command[command.indexOf('--name') + 1];
      const componentLabel = command.find((value) => value.startsWith('deploy-sh.component='));
      this.containers.set(name, componentLabel?.split('=')[1] ?? '');
      return success(`container-${this.containers.size}\n`);
    }
    if (command[0] === 'inspect') return success('true\n');
    if (command[0] === 'port') {
      const containerPort = Number(command[2].split('/')[0]);
      return success(`127.0.0.1:${40_000 + containerPort}\n`);
    }
    if (command[0] === 'rm') {
      for (const name of command.slice(command[1] === '-f' ? 2 : 1)) this.containers.delete(name);
    }
    return success();
  }
}

function success(stdout = ''): AgentGraphCommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function failure(): AgentGraphCommandResult {
  return { exitCode: 1, stdout: '', stderr: 'missing' };
}

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('connected-agent application graph executor', () => {
  it('materializes components, fixed instances, private discovery, volumes, jobs, and routing', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'deploy-agent-graph-'));
    temporary.push(root);
    const source = resolve(root, 'source');
    const volumes = resolve(root, 'volumes');
    mkdirSync(source, { recursive: true });
    const docker = new FakeDocker();
    const execute = (jobId: string) =>
      executeAgentApplicationGraph(
        {
          deploymentName: 'graph-notes',
          jobId,
          sourceDirectory: source,
          volumeDirectory: volumes,
          statePath: resolve(root, 'graph-state.json'),
          artifactSpecDigest: compiled.digest,
          artifactSpec: compiled.spec,
          graph: JSON.parse(JSON.stringify(graphPayload())) as AgentApplicationGraphPayload,
          probePort: async () => true,
        },
        docker,
      );

    const first = await execute('job-00000001');
    assert.equal(first.instances.length, 3);
    assert.equal(first.routes.length, 1);
    assert.equal(first.primaryRoute?.component, 'web');
    assert.equal(first.primaryDockerPort, 43_000);
    assert.equal(first.jobs.length, 1);
    assert.equal(first.jobs[0].executed, true);
    assert.ok(
      docker.commands.some(
        (command) =>
          command[0] === 'create' &&
          command.includes('--network-alias') &&
          command.includes('api.graph-notes.internal'),
      ),
    );
    assert.ok(
      docker.commands.some(
        (command) =>
          command[0] === 'create' &&
          command.includes('type=bind,src=/Volumes/library,dst=/srv/library,readonly'),
      ),
    );
    assert.ok(
      docker.commands.some(
        (command) =>
          command[0] === 'create' &&
          command.some(
            (argument) =>
              argument.includes('/volumes/uploads') && argument.includes('dst=/srv/uploads'),
          ),
      ),
    );
    assert.ok(docker.commands.some((command) => command[0] === 'build'));
    assert.ok(
      docker.commands.some(
        (command) => command[0] === 'run' && command.includes('deploy-sh.job=prepare'),
      ),
    );

    const jobRunsBefore = docker.commands.filter(
      (command) => command[0] === 'run' && command.includes('deploy-sh.job=prepare'),
    ).length;
    const second = await execute('job-00000002');
    assert.equal(second.jobs.length, 1);
    assert.equal(second.jobs[0].executed, false);
    assert.equal(
      docker.commands.filter(
        (command) => command[0] === 'run' && command.includes('deploy-sh.job=prepare'),
      ).length,
      jobRunsBefore,
    );
    assert.equal(docker.containers.size, 3);
  });

  it('rejects a graph contract that does not match the authenticated source artifact', () => {
    assert.throws(
      () => validateAgentGraphPayload(graphPayload(), `sha256:${'f'.repeat(64)}`),
      /does not match the downloaded deploy.yaml revision/,
    );
    const tampered = structuredClone(graphPayload());
    tampered.spec.components.api.instances = 1;
    assert.throws(
      () => validateAgentGraphPayload(tampered, compiled.digest, compiled.spec),
      /specification does not match/,
    );
  });
});
