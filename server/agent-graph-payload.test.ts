import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planApplicationExecution } from './application-execution.ts';
import { createAgentGraphPayload } from './agent-graph-payload.ts';
import { compileDeployYaml } from './application-spec.ts';

describe('connected-agent graph payload', () => {
  it('projects generated profile values through the encrypted job boundary', () => {
    const compiled = compileDeployYaml(`
apiVersion: deploy.local/v1
kind: Application
components:
  database:
    image: postgres:18
    profile: deploy.local/postgres@1
    interfaces:
      postgres: { port: 5432, protocol: postgres }
    mounts:
      /var/lib/postgresql/data: { resource: data }
resources:
  data:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
`);
    const execution = planApplicationExecution('notes', compiled.spec, {
      specDigest: compiled.digest,
    });
    assert.equal(execution.blocked, false);
    const requested: string[] = [];
    const payload = createAgentGraphPayload(
      {
        deploymentName: 'notes',
        applicationId: 'notes',
        siteId: 'node-away',
        writerSiteId: 'node-away',
        runtime: {
          format: 'application-spec',
          spec: compiled.spec,
          execution,
          configurationDigest: `sha256:${'1'.repeat(64)}`,
          configurationValues: {},
          componentEnvironment: { database: {} },
          ready: true,
          missing: [],
        },
      },
      {
        getOrCreateProfileValue(input) {
          requested.push(`${input.componentKey}.${input.key}`);
          return input.secret ? `secret-${input.key}` : input.create();
        },
      },
    );

    assert.ok(requested.includes('database.ownerPassword'));
    assert.equal(payload.profileValues.database.database, 'notes');
    assert.equal(payload.profileValues.database.ownerPassword, 'secret-ownerPassword');
    assert.equal(payload.siteId, 'node-away');
  });
});
