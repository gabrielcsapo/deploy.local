import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planApplicationExecution } from './application-execution.ts';
import { planPostgresVersionTransition } from './component-profile-postgres.ts';
import { compileApplicationManifest } from './application-spec.ts';

function postgres(image: string, instances = 1) {
  return compileApplicationManifest({
    apiVersion: 'deploy.local/v1',
    kind: 'Application',
    components: {
      db: {
        image,
        instances,
        profile: 'deploy.local/postgres@1',
        interfaces: { postgres: { port: 5432, protocol: 'postgres' } },
        mounts: { '/var/lib/postgresql/data': { resource: 'database' } },
      },
    },
    resources: {
      database: {
        type: 'volume',
        durability: 'durable',
        dataRole: 'database',
        access: 'singleWriter',
      },
    },
  }).spec;
}

describe('PostgreSQL lifecycle profile', () => {
  it('adds portable lifecycle contracts without changing component execution', () => {
    const plan = planApplicationExecution('notes', postgres('postgres:18'));
    const component = plan.components.db;
    assert.equal(plan.blocked, false);
    assert.equal(component.source.kind, 'image');
    assert.deepEqual(component.profile?.capabilities, [
      'provision',
      'generated-bindings',
      'health',
      'backup',
      'restore',
      'upgrade',
    ]);
    assert.ok(component.profile?.operations.some((item) => item.id === 'logical-export'));
    assert.deepEqual(
      component.profile?.provisionedValues.map((item) => item.name),
      [
        'database',
        'ownerUsername',
        'ownerPassword',
        'appUsername',
        'appPassword',
        'migrationUsername',
        'migrationPassword',
        'backupUsername',
        'backupPassword',
      ],
    );
    assert.deepEqual(
      component.profile?.generatedBindings.map((binding) => [
        binding.scope,
        binding.connection?.usernameValue,
        binding.connection?.passwordValue,
      ]),
      [
        ['runtime', 'appUsername', 'appPassword'],
        ['migration', 'migrationUsername', 'migrationPassword'],
        ['backup-restore', 'backupUsername', 'backupPassword'],
      ],
    );
    assert.match(component.profile?.provisioning?.command.join(' ') ?? '', /CREATE ROLE/);
    assert.match(component.profile?.provisioning?.verificationCommand.join(' ') ?? '', /count/);
    assert.deepEqual(
      Object.fromEntries(
        (component.profile?.operations ?? []).map((operation) => [
          operation.id,
          operation.workflow ?? 'command',
        ]),
      ),
      {
        'logical-export': 'logical-backup',
        'verified-restore': 'logical-restore',
        'major-upgrade': 'logical-major-upgrade',
        rollback: 'logical-rollback',
        readiness: 'command',
      },
    );
    assert.deepEqual(component.profile?.managedData, {
      resourceRole: 'database',
      mountPath: '/var/lib/postgresql/data',
    });
    assert.equal(component.profile?.versionIdentity?.value, '18');
    assert.equal(component.profile?.backup?.portable, true);
  });

  it('rejects generic multi-writer admission and makes major upgrades explicit', () => {
    const scaled = planApplicationExecution('notes', postgres('postgres:18', 2));
    assert.equal(scaled.blocked, true);
    assert.ok(
      scaled.findings.some((item) => item.code === 'POSTGRES_SINGLE_WRITER_INSTANCE_REQUIRED'),
    );
    assert.equal(
      planPostgresVersionTransition(
        postgres('postgres:17').components.db,
        postgres('postgres:18').components.db,
      ),
      'logical-export-restore-required',
    );
  });
});
