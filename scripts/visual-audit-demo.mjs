import { generateKeyPairSync } from 'node:crypto';

const DEMO_USER = 'audit-admin';
const DEMO_PASSWORD = 'deploy-local-visual-audit';

const DEMO_APPLICATIONS = [
  {
    name: 'family-hub',
    port: 4101,
    cpuPercent: 31,
    memoryMiB: 864,
    requestCount: 420,
    manifest: `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: family-hub
  description: Shared family dashboard
configuration:
  homeLabel:
    type: string
    default: Home
    description: Name shown to family members
  weatherApiKey:
    type: secret
    description: Optional key for local weather cards
components:
  gateway:
    image: nginx:1.27-alpine
    role: web
    interfaces:
      http: { port: 80, protocol: http }
    environment:
      UPSTREAM: { from: web.http }
    dependsOn: [web]
  web:
    image: ghcr.io/example/family-hub:1.4.0
    role: web
    instances: 2
    interfaces:
      http: { port: 3000, protocol: http }
    environment:
      DATABASE_URL: { from: database.postgres }
      HOME_LABEL: { from: configuration.homeLabel }
      WEATHER_API_KEY: { from: configuration.weatherApiKey }
    mounts:
      /app/uploads: { resource: uploads }
    dependsOn: [database]
  database:
    image: postgres:17-alpine
    role: service
    profile: deploy.local/postgres@1
    interfaces:
      postgres: { port: 5432, protocol: postgres }
    mounts:
      /var/lib/postgresql/data: { resource: database-data }
resources:
  uploads:
    type: volume
    durability: durable
    dataRole: files
    access: singleWriter
  database-data:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
routes:
  public: { to: gateway.http, discoverable: true }
`,
  },
  {
    name: 'travel-notes',
    port: 4102,
    cpuPercent: 18,
    memoryMiB: 448,
    requestCount: 230,
    manifest: `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: travel-notes
  description: Offline-first shared notes
components:
  web:
    image: ghcr.io/example/travel-notes:2.1.0
    role: web
    interfaces:
      http: { port: 3000, protocol: http }
    mounts:
      /app/data: { resource: notes-data }
      /app/uploads: { resource: attachments }
resources:
  notes-data:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
  attachments:
    type: volume
    durability: durable
    dataRole: files
    access: singleWriter
routes:
  public: { to: web.http, discoverable: true }
`,
  },
  {
    name: 'media-room',
    port: 4103,
    cpuPercent: 56,
    memoryMiB: 1536,
    requestCount: 150,
    manifest: `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: media-room
  description: Personal media library
components:
  web:
    image: ghcr.io/example/media-room:3.2.1
    role: web
    interfaces:
      http: { port: 8096, protocol: http }
    mounts:
      /config: { resource: config }
      /media: { resource: library, readOnly: true }
resources:
  config:
    type: volume
    durability: durable
    dataRole: files
    access: singleWriter
  library:
    type: volume
    durability: durable
    dataRole: files
    access: multipleReaders
routes:
  public: { to: web.http, discoverable: true }
`,
  },
];

export async function seedVisualAuditDemo(dataDirectory) {
  process.env.DEPLOY_DATA_DIR = dataDirectory;
  process.env.DEPLOY_NODE_NAME = 'Home gateway';

  const store = await import('../server/store.ts');
  const multisite = await import('../server/multisite.ts');
  const { compileDeployYaml } = await import('../server/application-spec.ts');

  const registration = store.registerUser(DEMO_USER, DEMO_PASSWORD);
  if ('error' in registration) throw new Error(registration.error);
  store.ensureCoordinatorNode();

  const enrollment = store.createNodeEnrollment('Studio node', DEMO_USER);
  const enrolled = store.redeemNodeEnrollment({
    code: enrollment.code,
    platform: 'linux',
    architecture: 'arm64',
    agentVersion: '1.0.0',
    address: '192.168.1.42',
    capabilities: {
      cpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
      docker: true,
      labels: { location: 'home', storage: 'ssd' },
    },
  });
  if ('error' in enrolled) throw new Error(enrolled.error);

  const appRecords = [];
  for (const [index, application] of DEMO_APPLICATIONS.entries()) {
    store.saveDeployment({
      name: application.name,
      type: 'application-graph',
      username: DEMO_USER,
      port: application.port,
      containerId: `audit-${application.name}`,
      containerName: `deploy-${application.name}`,
      desiredNodeId: enrolled.nodeId,
      activeNodeId: enrolled.nodeId,
      createdAt: new Date(Date.now() - (index + 2) * 86_400_000).toISOString(),
    });
    store.updateDeploymentStatus(application.name, 'running');
    store.recordContainerStart(application.name);

    const compiled = compileDeployYaml(application.manifest, `${application.name}/deploy.yaml`);
    store.saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: application.name,
      apiVersion: compiled.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.canonicalJson,
      originalSource: application.manifest,
      originalMediaType: 'application/yaml',
      createdBy: DEMO_USER,
    });
    store.activateDesiredApplicationSpec(application.name, compiled.digest);
    const appId = multisite.registerApplicationIdentity(application.name);
    store.addDeployEvent(application.name, {
      action: 'deploy',
      username: DEMO_USER,
      type: 'application-graph',
      port: application.port,
      containerId: `audit-${application.name}`,
      durationMs: 18_000 + index * 7_500,
      source: 'cli',
    });
    appRecords.push({ ...application, appId, digest: compiled.digest });
  }

  const keyPair = generateKeyPairSync('ed25519');
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const carryOnIntent = multisite.createSuitcasePairing({
    name: 'Carry-on cloud',
    defaultDataPolicy: 'automatic',
    accessMode: 'linux-access-point',
    createdBy: DEMO_USER,
  });
  const carryOn = multisite.redeemSuitcasePairing({
    code: carryOnIntent.code,
    publicKey,
    platform: 'linux',
    architecture: 'arm64',
    version: '1.0.0',
    capabilities: {
      dockerTarget: true,
      cpuCount: 8,
      memoryBytes: 8 * 1024 ** 3,
      freeStorageBytes: 180 * 1024 ** 3,
    },
  });
  multisite.updateSitePresence({
    siteId: carryOn.siteId,
    mode: 'away',
    readiness: { status: 'ready', lastSync: '4 minutes ago' },
  });

  const studioIntent = multisite.createSuitcasePairing({
    name: 'Workshop suitcase',
    defaultDataPolicy: 'manual',
    createdBy: DEMO_USER,
  });
  const workshop = multisite.redeemSuitcasePairing({
    code: studioIntent.code,
    publicKey,
    platform: 'linux',
    architecture: 'amd64',
    version: '1.0.0',
    capabilities: {
      dockerTarget: true,
      cpuCount: 4,
      memoryBytes: 8 * 1024 ** 3,
      freeStorageBytes: 96 * 1024 ** 3,
    },
  });

  const sqlite = store.getSqlite();
  const now = Date.now();
  const replicaInsert = sqlite.prepare(
    `INSERT OR IGNORE INTO app_replicas
      (id, app_id, site_id, active_release_digest, desired_release_digest,
       runtime_status, data_mode, sync_policy, shared_lineage, pending_changesets,
       pending_blobs, readiness, last_contact_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const createdAt = new Date(now - 3_600_000).toISOString();
  replicaInsert.run(
    'audit-replica-family-carry-on',
    appRecords[0].appId,
    carryOn.siteId,
    appRecords[0].digest,
    appRecords[0].digest,
    'running',
    'replicated',
    'automatic',
    1,
    0,
    0,
    JSON.stringify({ status: 'ready' }),
    now - 240_000,
    createdAt,
    createdAt,
  );
  replicaInsert.run(
    'audit-replica-notes-carry-on',
    appRecords[1].appId,
    carryOn.siteId,
    appRecords[1].digest,
    appRecords[1].digest,
    'running',
    'replicated',
    'automatic',
    1,
    3,
    1,
    JSON.stringify({ status: 'ready', note: 'Changes queued while away' }),
    now - 240_000,
    createdAt,
    createdAt,
  );
  replicaInsert.run(
    'audit-replica-media-workshop',
    appRecords[2].appId,
    workshop.siteId,
    appRecords[2].digest,
    appRecords[2].digest,
    'running',
    'site-local',
    'none',
    0,
    0,
    0,
    JSON.stringify({ status: 'ready' }),
    now - 30_000,
    createdAt,
    createdAt,
  );

  const requestInsert = sqlite.prepare(
    `INSERT INTO request_logs
      (deployment_name, method, path, status, duration, timestamp, ip, user_agent,
       response_size, username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const metricsInsert = sqlite.prepare(
    `INSERT INTO resource_metrics
      (deployment_name, cpu_percent, mem_usage_bytes, mem_limit_bytes, mem_percent,
       net_rx_bytes, net_tx_bytes, block_read_bytes, block_write_bytes, pids, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rollupInsert = sqlite.prepare(
    `INSERT INTO request_logs_1m
      (deployment_name, bucket_ms, count, errors_4xx, errors_5xx,
       duration_sum, duration_min, duration_max)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const seedTelemetry = sqlite.transaction(() => {
    for (const [appIndex, application] of appRecords.entries()) {
      const memLimit = 4 * 1024 ** 3;
      const memUsage = application.memoryMiB * 1024 ** 2;
      metricsInsert.run(
        application.name,
        application.cpuPercent,
        memUsage,
        memLimit,
        (memUsage / memLimit) * 100,
        18_000_000 + appIndex * 4_000_000,
        9_000_000 + appIndex * 2_000_000,
        2_000_000,
        1_000_000,
        12 + appIndex * 4,
        now - 5_000,
      );

      const perMinute = Math.ceil(application.requestCount / 10);
      for (let minute = 0; minute < 10; minute++) {
        const bucket = Math.floor((now - minute * 60_000) / 60_000) * 60_000;
        let errors = 0;
        let durationSum = 0;
        let durationMin = Number.POSITIVE_INFINITY;
        let durationMax = 0;
        for (let requestIndex = 0; requestIndex < perMinute; requestIndex++) {
          const isError = appIndex === 2 && requestIndex === 0 && minute < 2;
          const duration = 24 + appIndex * 19 + ((minute * 7 + requestIndex * 11) % 120);
          const timestamp = bucket + Math.min(59_000, requestIndex * 900);
          requestInsert.run(
            application.name,
            requestIndex % 7 === 0 ? 'POST' : 'GET',
            requestIndex % 5 === 0 ? '/api/items' : requestIndex % 3 === 0 ? '/library' : '/',
            isError ? 502 : 200,
            duration,
            timestamp,
            `192.168.1.${20 + (requestIndex % 6)}`,
            'deploy.local visual audit',
            4_096 + requestIndex * 32,
            requestIndex % 4 === 0 ? 'family' : null,
          );
          if (isError) errors++;
          durationSum += duration;
          durationMin = Math.min(durationMin, duration);
          durationMax = Math.max(durationMax, duration);
        }
        rollupInsert.run(
          application.name,
          bucket,
          perMinute,
          0,
          errors,
          durationSum,
          durationMin,
          durationMax,
        );
      }
    }
  });
  seedTelemetry.immediate();

  store._resetDb();
  return {
    username: DEMO_USER,
    password: DEMO_PASSWORD,
    token: registration.token,
    applications: appRecords.map((application) => application.name),
  };
}
