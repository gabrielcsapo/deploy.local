import type { CatalogArtifact, CatalogBlueprintContent } from './types.ts';
import { CATALOG_BLUEPRINT_SCHEMA } from './types.ts';

const NGINX =
  'nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10';
const WHOAMI =
  'traefik/whoami:v1.10.3@sha256:43a68d10b9dfcfc3ffbfe4dd42100dc9aeaf29b3a5636c856337a5940f1b4f1c';
const BUSYBOX =
  'busybox:1.37@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0';
const POSTGRES =
  'postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const HOME_ASSISTANT =
  'ghcr.io/home-assistant/home-assistant:stable@sha256:6340a3de3917a9b19368e767310a96dd090f6a19aca8aeadf87fd1145cec9682';

const artifact = (id: string, reference: string): CatalogArtifact => ({
  id,
  kind: 'oci-image',
  reference,
  digest: reference.slice(reference.lastIndexOf('@') + 1) as `sha256:${string}`,
  verification: 'resolved',
});

const validationEvidence = (target: string) => [
  {
    id: 'schema-contract',
    kind: 'schema' as const,
    result: 'not-run' as const,
    target,
    summary: 'Validation fixture only; no physical compatibility run is recorded.',
  },
  {
    id: 'install-contract',
    kind: 'install' as const,
    result: 'not-run' as const,
    target,
    summary:
      'Install and health behavior must pass compatibility CI before support can be claimed.',
  },
];

export const validationBlueprintContents: CatalogBlueprintContent[] = [
  {
    schema: CATALOG_BLUEPRINT_SCHEMA,
    id: 'volume-app-fixture',
    release: '1.0.0-validation.1',
    publisher: {
      id: 'deploy-local',
      name: 'deploy.local',
      trustTier: 'deploy-local',
    },
    metadata: {
      name: 'Simple volume application',
      summary: 'One web component and one durable volume.',
      description:
        'A deploy.local-owned validation fixture for the smallest persistent catalog graph. It is not a third-party application or a physical compatibility claim.',
      license: 'MIT',
      categories: ['validation', 'storage'],
    },
    support: {
      stage: 'validation',
      scope:
        'Installable contract fixture using a public multi-architecture image; physical compatibility evidence is not yet recorded.',
      evidence: validationEvidence('linux/amd64 + linux/arm64'),
    },
    compatibility: {
      deployLocalVersion: '>=1.0.0 <2.0.0',
      target: {
        operatingSystems: ['linux', 'darwin', 'windows'],
        architectures: ['amd64', 'arm64'],
        engines: ['docker-engine', 'docker-desktop'],
        minimumEngineVersion: '27.0.0',
        minimumMemoryMiB: 256,
        minimumStorageMiB: 1024,
        minimumCpuCores: 1,
        internetRequiredForInstall: true,
      },
      promises: {
        install: 'declared',
        lifecycle: 'unknown',
        offline: 'unknown',
        suitcase: 'unknown',
        reconciliation: 'not-supported',
      },
    },
    security: [],
    artifacts: [artifact('nginx', NGINX), artifact('recovery-helper', BUSYBOX)],
    questions: [],
    application: {
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      metadata: {
        name: 'volume-app-fixture',
        description: 'Simple catalog validation fixture',
      },
      components: {
        web: {
          image: NGINX,
          role: 'web',
          interfaces: { http: { protocol: 'http', port: 80 } },
          mounts: { '/var/cache/nginx': { resource: 'data' } },
          health: { interface: 'http', path: '/' },
        },
      },
      resources: {
        data: {
          type: 'volume',
          durability: 'durable',
          dataRole: 'files',
          access: 'singleWriter',
        },
      },
      routes: { web: { to: 'web.http', path: '/', discoverable: true } },
    },
    supportedCustomization: ['/metadata/name', '/routes/web/hostname'],
    upgrades: [],
  },
  {
    schema: CATALOG_BLUEPRINT_SCHEMA,
    id: 'home-assistant-container',
    release: '2026.8.0-validation.1',
    publisher: {
      id: 'deploy-local',
      name: 'deploy.local',
      trustTier: 'deploy-local',
    },
    metadata: {
      name: 'Home Assistant Container',
      summary: 'Linux home-automation container with explicit host and device access.',
      description:
        'A conditional install blueprint for Home Assistant Container. It does not provide Home Assistant OS, Supervisor, or Supervisor apps, and it is admitted only on compatible Linux targets after explicit host-access approval.',
      upstreamUrl: 'https://www.home-assistant.io/installation/linux',
      supportUrl: 'https://www.home-assistant.io/help/',
      license: 'Apache-2.0',
      trademarkNotice: 'Home Assistant is a trademark of the Open Home Foundation.',
      categories: ['validation', 'home-automation'],
    },
    support: {
      stage: 'validation',
      scope:
        'Conditional Linux container install with explicit capability gates; physical compatibility evidence is not yet recorded.',
      evidence: validationEvidence('linux/docker-engine; target devices vary'),
    },
    compatibility: {
      deployLocalVersion: '>=1.0.0 <2.0.0',
      target: {
        operatingSystems: ['linux'],
        architectures: ['amd64', 'arm64'],
        engines: ['docker-engine'],
        minimumEngineVersion: '27.0.0',
        minimumMemoryMiB: 2048,
        minimumStorageMiB: 8192,
        minimumCpuCores: 2,
        internetRequiredForInstall: true,
      },
      promises: {
        install: 'declared',
        lifecycle: 'unknown',
        offline: 'unknown',
        suitcase: 'not-supported',
        reconciliation: 'not-supported',
      },
    },
    security: [
      {
        id: 'host-network',
        kind: 'host-network',
        component: 'home-assistant',
        required: true,
        reason: 'Local discovery integrations require access to the home LAN.',
      },
      {
        id: 'privileged-container',
        kind: 'privileged-container',
        component: 'home-assistant',
        required: true,
        reason: 'This validation contract exercises the upstream privileged-container path.',
      },
      {
        id: 'lan-discovery',
        kind: 'lan-discovery',
        component: 'home-assistant',
        required: true,
        reason: 'Home integrations discover services and devices on the selected site LAN.',
      },
      {
        id: 'dbus',
        kind: 'host-path',
        component: 'home-assistant',
        required: false,
        value: '/run/dbus',
        reason: 'Optional Bluetooth integrations may need the host D-Bus socket.',
      },
      {
        id: 'radio-device',
        kind: 'device',
        component: 'home-assistant',
        required: false,
        value: '/dev/serial/by-id/*',
        reason: 'Optional Zigbee, Z-Wave, or similar radio selected by an administrator.',
      },
    ],
    artifacts: [artifact('home-assistant', HOME_ASSISTANT), artifact('recovery-helper', BUSYBOX)],
    questions: [],
    application: {
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      metadata: {
        name: 'home-assistant-container',
        description: 'Home Assistant Container validation graph',
      },
      components: {
        'home-assistant': {
          image: HOME_ASSISTANT,
          role: 'web',
          interfaces: { http: { protocol: 'http', port: 8123 } },
          mounts: { '/config': { resource: 'config' } },
          health: { interface: 'http', path: '/' },
          runtime: { networkMode: 'host', privileged: true },
        },
      },
      resources: {
        config: {
          type: 'volume',
          durability: 'durable',
          dataRole: 'files',
          access: 'singleWriter',
        },
      },
      routes: { home: { to: 'home-assistant.http', path: '/', discoverable: true } },
    },
    supportedCustomization: ['/metadata/name', '/routes/home/hostname'],
    upgrades: [],
  },
  {
    schema: CATALOG_BLUEPRINT_SCHEMA,
    id: 'postgres-service-graph-fixture',
    release: '1.0.0-validation.1',
    publisher: {
      id: 'deploy-local',
      name: 'deploy.local',
      trustTier: 'deploy-local',
    },
    metadata: {
      name: 'PostgreSQL service graph fixture',
      summary: 'Nginx, two web instances, worker, migration job, and PostgreSQL.',
      description:
        'A deploy.local-owned validation fixture for dependency order, scaling, private service bindings, migration gates, and durable database lifecycle planning.',
      license: 'MIT',
      categories: ['validation', 'database', 'service-graph'],
    },
    support: {
      stage: 'validation',
      scope:
        'Installable graph-contract fixture using public multi-architecture images; physical compatibility evidence is not yet recorded.',
      evidence: validationEvidence('linux/amd64 + linux/arm64'),
    },
    compatibility: {
      deployLocalVersion: '>=1.0.0 <2.0.0',
      target: {
        operatingSystems: ['linux', 'darwin', 'windows'],
        architectures: ['amd64', 'arm64'],
        engines: ['docker-engine', 'docker-desktop'],
        minimumEngineVersion: '27.0.0',
        minimumMemoryMiB: 4096,
        minimumStorageMiB: 16384,
        minimumCpuCores: 4,
        internetRequiredForInstall: true,
      },
      promises: {
        install: 'declared',
        lifecycle: 'declared',
        offline: 'unknown',
        suitcase: 'not-supported',
        reconciliation: 'not-supported',
      },
    },
    security: [],
    artifacts: [
      artifact('nginx', NGINX),
      artifact('web', WHOAMI),
      artifact('worker', BUSYBOX),
      artifact('postgres', POSTGRES),
    ],
    questions: [
      {
        key: 'worker-token',
        configuration: 'workerToken',
        label: 'Worker token',
        help: 'Stored server-side and projected only to the worker and migration job.',
        required: true,
        secret: true,
      },
    ],
    application: {
      apiVersion: 'deploy.local/v1',
      kind: 'Application',
      metadata: {
        name: 'postgres-service-graph-fixture',
        description: 'Complex catalog validation graph',
      },
      configuration: {
        workerToken: {
          type: 'secret',
          required: true,
          description: 'Fixture worker authentication token',
        },
      },
      components: {
        nginx: {
          image: NGINX,
          role: 'web',
          command: [
            'sh',
            '-c',
            "printf 'server { listen 80; location / { proxy_pass %s; } }' \"$UPSTREAM\" > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'",
          ],
          interfaces: { http: { protocol: 'http', port: 80 } },
          environment: { UPSTREAM: { from: 'web.http' } },
          dependsOn: ['web'],
          health: { interface: 'http', path: '/' },
        },
        web: {
          image: WHOAMI,
          role: 'web',
          instances: 2,
          interfaces: { http: { protocol: 'http', port: 80 } },
          environment: {
            DATABASE_URL: { from: 'postgres.postgres' },
          },
          dependsOn: ['postgres'],
          health: { interface: 'http', path: '/' },
        },
        worker: {
          image: BUSYBOX,
          role: 'worker',
          command: ['sh', '-c', 'while true; do sleep 3600; done'],
          environment: {
            DATABASE_URL: { from: 'postgres.postgres' },
            WORKER_TOKEN: { from: 'configuration.workerToken' },
          },
          dependsOn: ['postgres'],
        },
        postgres: {
          image: POSTGRES,
          role: 'service',
          profile: 'deploy.local/postgres@1',
          interfaces: { postgres: { protocol: 'postgres', port: 5432 } },
          mounts: { '/var/lib/postgresql/data': { resource: 'database' } },
          health: { interface: 'postgres' },
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
      routes: { public: { to: 'nginx.http', path: '/', discoverable: true } },
      jobs: {
        migrate: {
          component: 'worker',
          command: ['sh', '-c', 'true'],
          environment: {
            DATABASE_URL: { from: 'postgres.postgres' },
            WORKER_TOKEN: { from: 'configuration.workerToken' },
          },
          execution: 'writerSite',
          beforeTraffic: true,
        },
      },
    },
    supportedCustomization: [
      '/metadata/name',
      '/components/web/instances',
      '/routes/public/hostname',
    ],
    upgrades: [],
  },
];

// Keep at least one real upgrade edge for each graph shape we advertise. These
// remain validation releases: the contracts exercise recovery, migration, health,
// commit, and rollback without claiming that physical-device evidence exists.
const volumeUpgrade = structuredClone(
  validationBlueprintContents.find((release) => release.id === 'volume-app-fixture')!,
);
volumeUpgrade.release = '1.1.0-validation.1';
volumeUpgrade.metadata.summary = 'One web component and one durable volume, revision two.';
volumeUpgrade.support.scope =
  'Upgrade-contract fixture for recovery, health-gated commit, and rollback; physical compatibility evidence is not yet recorded.';
volumeUpgrade.upgrades = [
  {
    fromRelease: '1.0.0-validation.1',
    recoveryPointRequired: true,
    rollback: 'supported',
    migrationJobs: [],
    notes: 'Exercises a non-migrating, recovery-gated application upgrade.',
  },
];

const postgresUpgrade = structuredClone(
  validationBlueprintContents.find((release) => release.id === 'postgres-service-graph-fixture')!,
);
postgresUpgrade.release = '1.1.0-validation.1';
postgresUpgrade.metadata.summary =
  'Nginx, three web instances, worker, migration job, and PostgreSQL.';
postgresUpgrade.application.components.web.instances = 3;
postgresUpgrade.support.scope =
  'Upgrade-contract fixture for recovery, migration ordering, health-gated commit, and rollback; physical compatibility evidence is not yet recorded.';
postgresUpgrade.upgrades = [
  {
    fromRelease: '1.0.0-validation.1',
    recoveryPointRequired: true,
    rollback: 'supported',
    migrationJobs: ['migrate'],
    notes: 'Runs the declared migration job before traffic moves to the three-instance revision.',
  },
];

validationBlueprintContents.push(volumeUpgrade, postgresUpgrade);
