import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planApplicationExecution } from './application-execution.ts';
import { recordAgentGraphMaterialization } from './agent-graph-recording.ts';
import type { AgentGraphExecutionResult } from './agent-graph-runtime.ts';
import { compileDeployYaml } from './application-spec.ts';
import type { GraphRuntimeStateStore } from './graph-runtime-store.ts';

describe('connected-agent graph actual state', () => {
  it('admits exact instances and exposes the primary relay as the published endpoint', () => {
    const compiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  web:
    image: example/web:1
    interfaces:
      http: { port: 3000, protocol: http }
routes:
  public: { to: web.http }
`);
    const execution = planApplicationExecution('notes', compiled.spec, {
      specDigest: compiled.digest,
    });
    const placements: unknown[] = [];
    const instances: any[] = [];
    const services: unknown[] = [];
    const endpoints: any[] = [];
    const state = {
      upsertPlacement(value: unknown) {
        placements.push(value);
      },
      listInstances() {
        return instances;
      },
      putInstance(value: any) {
        instances.push(value);
      },
      patchInstance() {},
      upsertService(value: unknown) {
        services.push(value);
      },
      replaceReadyEndpoints(_deployment: string, _service: string, value: unknown[]) {
        endpoints.push(...value);
        return 1;
      },
      replaceVolumeAttachments() {},
      getJobRecords() {
        return [];
      },
      startJob() {},
      finishJob() {},
    } as unknown as GraphRuntimeStateStore;
    const result: AgentGraphExecutionResult = {
      type: 'application-graph',
      applicationId: 'notes',
      specDigest: compiled.digest,
      configurationDigest: `sha256:${'1'.repeat(64)}`,
      network: 'deploy-sh-notes-private',
      primaryContainerId: 'container-1',
      primaryContainerName: 'deploy-sh-notes-web-1-abcd1234',
      primaryDockerPort: 43000,
      primaryRoute: {
        name: 'public',
        component: 'web',
        interface: 'http',
        protocol: 'http',
        path: '/',
        discoverable: true,
        containerPort: 3000,
        endpoints: [
          {
            instanceId: 'web/1/abcd1234',
            containerName: 'deploy-sh-notes-web-1-abcd1234',
            dockerPort: 43000,
          },
        ],
      },
      instances: [
        {
          id: 'web/1/abcd1234',
          component: 'web',
          slot: 'notes/web/1',
          containerId: 'container-1',
          containerName: 'deploy-sh-notes-web-1-abcd1234',
          image: 'example/web:1',
          hostPorts: { 3000: 43000 },
          releaseDigest: `sha256:${'2'.repeat(64)}`,
          configurationDigest: `sha256:${'3'.repeat(64)}`,
        },
      ],
      routes: [],
      jobs: [],
    };
    recordAgentGraphMaterialization(
      {
        deploymentName: 'notes',
        applicationId: 'notes',
        siteId: 'node-away',
        nodeId: 'node-away',
        nodeAddress: '192.168.1.30',
        relayPort: 45678,
        runtime: {
          format: 'application-spec',
          spec: compiled.spec,
          execution,
          configurationDigest: result.configurationDigest,
          configurationValues: {},
          componentEnvironment: { web: {} },
          ready: true,
          missing: [],
        },
        result,
      },
      state,
    );

    assert.equal(placements.length, 1);
    assert.equal(instances.length, 1);
    assert.equal(services.length, 1);
    assert.deepEqual(
      { host: endpoints[0].host, port: endpoints[0].port },
      { host: '192.168.1.30', port: 45678 },
    );
  });
});
