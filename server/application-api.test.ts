import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { pack, type Headers } from 'tar-stream';
import { compileDeployYaml, parseRepositoryBaseDigest } from './application-spec.ts';

const APPLICATION_NAME = 'notes';
const ADMIN_SECRET = 'home-admin-password-do-not-echo';
const HOME_SITE_SECRET = 'home-site-token-do-not-echo';

const manifestSource = `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: notes
configuration:
  adminPassword:
    type: secret
    required: true
    description: Administrator password
  siteAccessToken:
    type: secret
    required: true
    scope: site
    description: Site-specific access token
  theme:
    type: string
    default: dark
    allowedValues: [dark, light]
components:
  web:
    build:
      context: .
    role: web
    instances: 2
    siteOverrides:
      allowed: true
      minimum: 1
      maximum: 4
    interfaces:
      http:
        port: 3000
        protocol: http
    environment:
      ADMIN_PASSWORD:
        from: configuration.adminPassword
      SITE_ACCESS_TOKEN:
        from: configuration.siteAccessToken
      THEME:
        from: configuration.theme
routes:
  public:
    to: web.http
`;

const compiledManifest = compileDeployYaml(manifestSource);

const suitcaseProfileManifest = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: suitcase-db
components:
  database:
    image: postgres:18
    role: service
    profile: deploy.local/postgres@1
    interfaces:
      postgres:
        port: 5432
        protocol: postgres
    mounts:
      /var/lib/postgresql/data:
        resource: database-data
resources:
  database-data:
    type: volume
    durability: durable
    dataRole: database
    access: singleWriter
`);

async function getPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startServer(
  port: number,
  dataDir: string,
  environment: Record<string, string> = {},
): Promise<ChildProcess> {
  const httpsPort = await getPort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'server.ts')], {
      env: {
        ...process.env,
        PORT: String(port),
        HTTPS_PORT: String(httpsPort),
        DEPLOY_DATA_DIR: dataDir,
        DEPLOY_MAX_UPLOAD_ARCHIVE_BYTES: '1024',
        ...environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    let stderr = '';
    const timeout = setTimeout(() => {
      if (!started) {
        child.kill();
        reject(new Error(`Server did not start within 60s: ${stderr}`));
      }
    }, 60_000);

    child.stdout!.on('data', (data: Buffer) => {
      if (started || !data.toString().includes('running on')) return;
      started = true;
      clearTimeout(timeout);
      resolve(child);
    });
    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      if (started) return;
      clearTimeout(timeout);
      reject(new Error(`Server exited with code ${code}: ${stderr}`));
    });
  });
}

async function stopServer(server: ChildProcess | undefined) {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    server.once('exit', () => resolve());
    server.kill();
  });
}

async function request(port: number, path: string, options: RequestInit = {}) {
  const response = await fetch(`http://localhost:${port}${path}`, options);
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // YAML and other non-JSON responses remain text.
  }
  return { status: response.status, body, text, headers: response.headers };
}

function authHeaders(username: string, token: string) {
  return {
    'x-deploy-username': username,
    'x-deploy-token': token,
  };
}

async function upload(
  port: number,
  name: string,
  username: string,
  token: string,
  contents: string | Uint8Array = 'not-a-tarball',
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  form.append('name', name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  let blobPart: BlobPart;
  if (typeof contents === 'string') {
    blobPart = contents;
  } else {
    const copy = new Uint8Array(new ArrayBuffer(contents.byteLength));
    copy.set(contents);
    blobPart = copy.buffer;
  }
  form.append('file', new Blob([blobPart]), 'source.tar.gz');
  return request(port, '/api/upload', {
    method: 'POST',
    headers: authHeaders(username, token),
    body: form,
  });
}

async function tarGzip(entries: Array<{ header: Headers; body?: string }>) {
  const archive = pack();
  for (const entry of entries) archive.entry(entry.header, entry.body || '');
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return Uint8Array.from(gzipSync(Buffer.concat(chunks)));
}

async function register(port: number, username: string) {
  const response = await request(port, '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'test-password' }),
  });
  assert.equal(response.status, 201);
  return response.body.token as string;
}

function seedApplication(dataDir: string) {
  const sqlite = new Database(join(dataDir, 'deploy.db'));
  sqlite.pragma('busy_timeout = 5000');
  const now = new Date().toISOString();
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO deployments (
          name, type, username, status, desired_spec_digest, active_spec_digest,
          spec_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        APPLICATION_NAME,
        'node',
        'alice',
        'stopped',
        compiledManifest.digest,
        compiledManifest.digest,
        'repository',
        now,
        now,
      );
    sqlite
      .prepare('UPDATE deployments SET app_id = ?, directory = ? WHERE name = ?')
      .run('app-notes', dataDir, APPLICATION_NAME);
    sqlite
      .prepare(
        `INSERT INTO deployments (
          name, type, username, status, desired_spec_digest, active_spec_digest,
          spec_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bob-notes',
        'node',
        'bob',
        'stopped',
        compiledManifest.digest,
        compiledManifest.digest,
        'repository',
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO application_spec_revisions (
          digest, deployment_name, parent_digest, api_version, source,
          manifest_format, normalized_spec, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        compiledManifest.digest,
        APPLICATION_NAME,
        null,
        'deploy.local/v1',
        'repository',
        'deploy.yaml',
        compiledManifest.canonicalJson,
        'alice',
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO application_spec_revisions (
          digest, deployment_name, parent_digest, api_version, source,
          manifest_format, normalized_spec, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        compiledManifest.digest,
        'bob-notes',
        null,
        'deploy.local/v1',
        'repository',
        'deploy.yaml',
        compiledManifest.canonicalJson,
        'bob',
        now,
      );
    const insertSite = sqlite.prepare(
      `INSERT INTO nodes (
        id, name, kind, platform, architecture, capabilities, enrolled_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSite.run('home', 'Home', 'agent', 'linux', 'arm64', '{}', now, Date.now());
    insertSite.run('travel', 'Travel', 'agent', 'linux', 'arm64', '{}', now, Date.now());
    sqlite
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ('default_node_id', 'home', ?)`,
      )
      .run(now);
  })();
  sqlite.close();
}

function seedLocalSuitcaseProfileApplication(dataDir: string, siteId: string) {
  const sqlite = new Database(join(dataDir, 'deploy.db'));
  sqlite.pragma('busy_timeout = 5000');
  const now = new Date().toISOString();
  const fleet = sqlite.prepare('SELECT id, home_site_id FROM fleets LIMIT 1').get() as
    | { id: string; home_site_id: string }
    | undefined;
  const fleetId = fleet?.id ?? 'fleet_api_locality';
  const homeSiteId = fleet?.home_site_id ?? 'site_home';
  sqlite.transaction(() => {
    if (!fleet) {
      sqlite
        .prepare(
          `INSERT INTO fleets (
            id, name, protocol_version, root_public_identity, home_site_id, created_at
          ) VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(fleetId, 'API locality fleet', 'test-home-public-key', homeSiteId, now);
    }
    sqlite
      .prepare(
        `INSERT INTO sites (
          id, fleet_id, name, kind, public_key, credential_status, mode,
          default_data_policy, access_mode, security_profile, created_at, updated_at
        ) VALUES (?, ?, ?, 'suitcase', ?, 'active', 'away', 'none',
                  'existing-lan', 'isolated', ?, ?)`,
      )
      .run(siteId, fleetId, 'Local API Suitcase', 'test-suitcase-public-key', now, now);
    sqlite
      .prepare(
        `INSERT INTO deployments (
          name, app_id, type, username, status, directory,
          desired_node_id, active_node_id, desired_spec_digest, active_spec_digest,
          spec_source, created_at, updated_at
        ) VALUES (?, ?, 'docker', 'alice', 'stopped', ?, ?, ?, ?, ?,
                  'repository', ?, ?)`,
      )
      .run(
        'suitcase-db',
        'app_suitcase_db',
        dataDir,
        siteId,
        siteId,
        suitcaseProfileManifest.digest,
        suitcaseProfileManifest.digest,
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO application_spec_revisions (
          digest, deployment_name, parent_digest, api_version, source,
          manifest_format, normalized_spec, created_by, created_at
        ) VALUES (?, 'suitcase-db', NULL, 'deploy.local/v1', 'repository',
                  'deploy.yaml', ?, 'alice', ?)`,
      )
      .run(suitcaseProfileManifest.digest, suitcaseProfileManifest.canonicalJson, now);
    sqlite
      .prepare(
        `INSERT INTO component_instances (
          id, app_id, deployment_name, site_id, component_key, slot_key, node_id,
          release_digest, configuration_digest, image, container_id, container_name,
          status, health, ready_at, created_at, updated_at
        ) VALUES (?, ?, 'suitcase-db', ?, 'database', 'database:0', ?, ?, ?,
                  'postgres:18', 'container-db', 'suitcase-db-database-0',
                  'ready', 'healthy', ?, ?, ?)`,
      )
      .run(
        'instance_suitcase_db',
        'app_suitcase_db',
        siteId,
        siteId,
        suitcaseProfileManifest.digest,
        'configuration:none',
        Date.now(),
        Date.now(),
        Date.now(),
      );
  })();
  sqlite.close();
}

function storedConfiguration(
  dataDir: string,
  key: string,
  siteId = '',
  specDigest = compiledManifest.digest,
) {
  const sqlite = new Database(join(dataDir, 'deploy.db'), { readonly: true });
  const row = sqlite
    .prepare(
      `SELECT value, value_digest, value_type, revision
       FROM application_configuration_values
       WHERE deployment_name = ? AND spec_digest = ? AND key = ? AND site_id = ?`,
    )
    .get(APPLICATION_NAME, specDigest, key, siteId) as
    | { value: string; value_digest: string; value_type: string; revision: number }
    | undefined;
  sqlite.close();
  return row;
}

function setDeploymentStatus(dataDir: string, status: string) {
  const sqlite = new Database(join(dataDir, 'deploy.db'));
  sqlite.prepare('UPDATE deployments SET status = ? WHERE name = ?').run(status, APPLICATION_NAME);
  sqlite.close();
}

function assertDoesNotExposeValues(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(assertDoesNotExposeValues);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, 'value', 'API response must not contain mutable configuration values');
    assertDoesNotExposeValues(child);
  }
}

describe('application graph and configuration HTTP API', () => {
  let server: ChildProcess;
  let port: number;
  let dataDir: string;
  let aliceToken: string;
  let bobToken: string;

  before(async () => {
    port = await getPort();
    dataDir = mkdtempSync(join(tmpdir(), 'deploy-application-api-'));
    server = await startServer(port, dataDir);
    aliceToken = await register(port, 'alice');
    bobToken = await register(port, 'bob');
    await stopServer(server);
    seedApplication(dataDir);
    server = await startServer(port, dataDir);
  });

  after(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires authentication and hides applications owned by another user', async () => {
    const paths = [
      `/api/deployments/${APPLICATION_NAME}/application-spec`,
      `/api/deployments/${APPLICATION_NAME}/application-runtime?siteId=home`,
      `/api/deployments/${APPLICATION_NAME}/deploy.yaml`,
      `/api/deployments/${APPLICATION_NAME}/deploy.patch.yaml`,
      `/api/deployments/${APPLICATION_NAME}/configuration?siteId=home`,
    ];

    for (const path of paths) {
      assert.equal((await request(port, path)).status, 401);
      assert.equal(
        (await request(port, path, { headers: authHeaders('bob', bobToken) })).status,
        404,
      );
    }
  });

  it('rejects unsafe deployment names and cross-owner redeploys before extraction', async () => {
    for (const name of ['../outside', '/tmp/outside', 'contains space']) {
      const response = await upload(port, name, 'alice', aliceToken);
      assert.equal(response.status, 400);
      assert.match(response.body.error, /Deployment name must/);
    }

    const crossOwner = await upload(port, APPLICATION_NAME, 'bob', bobToken);
    assert.equal(crossOwner.status, 409);
    assert.equal(crossOwner.body.error, 'Deployment name is already in use');

    const aliceApplication = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/application-spec`,
      { headers: authHeaders('alice', aliceToken) },
    );
    assert.equal(aliceApplication.status, 200);
  });

  it('rejects unsafe or oversized archives without replacing source or retaining artifacts', async () => {
    const preservedDir = join(dataDir, 'uploads', 'preserved');
    mkdirSync(preservedDir, { recursive: true });
    writeFileSync(join(preservedDir, 'keep.txt'), 'original source');

    const malformed = await upload(
      port,
      'preserved',
      'alice',
      aliceToken,
      Uint8Array.from(gzipSync('not a tar archive')),
    );
    assert.equal(malformed.status, 400);
    assert.equal(readFileSync(join(preservedDir, 'keep.txt'), 'utf8'), 'original source');
    assert.equal(existsSync(join(dataDir, 'artifacts', 'preserved')), false);

    const traversal = await upload(
      port,
      'unsafe-archive',
      'alice',
      aliceToken,
      await tarGzip([{ header: { name: '../outside' }, body: 'escape' }]),
    );
    assert.equal(traversal.status, 400);
    assert.match(traversal.body.error, /Archive entry path/);
    assert.equal(existsSync(join(dataDir, 'uploads', 'unsafe-archive')), false);
    assert.equal(existsSync(join(dataDir, 'artifacts', 'unsafe-archive')), false);

    const oversized = await upload(port, 'oversized', 'alice', aliceToken, new Uint8Array(2048));
    assert.equal(oversized.status, 413);
    assert.match(oversized.body.error, /exceeds 1,024 bytes/);
    assert.equal(existsSync(join(dataDir, 'uploads', 'oversized')), false);

    const oversizedField = await upload(port, 'x'.repeat(17 * 1024), 'alice', aliceToken);
    assert.equal(oversizedField.status, 413);
    assert.match(oversizedField.body.error, /oversized form field/);

    const temporaryEntries = readdirSync(join(dataDir, 'uploads')).filter(
      (entry) => entry.startsWith('.upload-') || entry.startsWith('.extract-'),
    );
    assert.deepEqual(temporaryEntries, []);
  });

  it('returns an immutable application spec with declarations but no values', async () => {
    const response = await request(port, `/api/deployments/${APPLICATION_NAME}/application-spec`, {
      headers: authHeaders('alice', aliceToken),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.desiredDigest, compiledManifest.digest);
    assert.equal(response.body.activeDigest, compiledManifest.digest);
    assert.equal(response.body.sourceAligned, true);
    assert.equal(response.body.notYetInSource, false);
    assert.deepEqual(response.body.desired, compiledManifest.spec);
    assert.deepEqual(response.body.active, compiledManifest.spec);
    assert.equal(response.body.desired.configuration.adminPassword.type, 'secret');
    assertDoesNotExposeValues(response.body);
  });

  it('returns an admin-only redacted component execution plan', async () => {
    const response = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/application-runtime?siteId=home`,
      { headers: authHeaders('alice', aliceToken) },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.siteId, 'home');
    assert.equal(response.body.specDigest, compiledManifest.digest);
    assert.equal(response.body.configuration.valuesRedacted, true);
    assert.deepEqual(response.body.configuration.missing, ['adminPassword', 'siteAccessToken']);
    assert.equal(response.body.ready, false);
    assert.equal(response.body.execution.components.web.blocked, true);
    assert.doesNotMatch(response.text, new RegExp(ADMIN_SECRET));
    assert.doesNotMatch(response.text, new RegExp(HOME_SITE_SECRET));
    assertDoesNotExposeValues(response.body);

    const forbidden = await request(
      port,
      '/api/deployments/bob-notes/application-runtime?siteId=home',
      { headers: authHeaders('bob', bobToken) },
    );
    assert.equal(forbidden.status, 403);
  });

  it('exports digest-equivalent deploy.yaml containing declarations only', async () => {
    const response = await request(port, `/api/deployments/${APPLICATION_NAME}/deploy.yaml`, {
      headers: authHeaders('alice', aliceToken),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^application\/yaml/);
    assert.match(
      response.headers.get('content-disposition') || '',
      /filename="notes-deploy\.yaml"/,
    );
    const exported = compileDeployYaml(response.text, 'exported deploy.yaml');
    assert.equal(exported.digest, compiledManifest.digest);
    assert.equal(parseRepositoryBaseDigest(response.text), compiledManifest.digest);
    assert.equal(exported.spec.configuration.adminPassword.type, 'secret');
    assert.doesNotMatch(response.text, /home-admin-password-do-not-echo/);
    assertDoesNotExposeValues(exported.spec);
  });

  it('reports required application and site configuration as missing', async () => {
    const response = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration?siteId=home`,
      { headers: authHeaders('alice', aliceToken) },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.siteId, 'home');
    assert.equal(response.body.ready, false);
    assert.deepEqual(response.body.missing, ['adminPassword', 'siteAccessToken']);
    assert.equal(response.body.declarations.adminPassword.configured, false);
    assert.equal(response.body.declarations.siteAccessToken.configured, false);
    assert.equal(response.body.declarations.theme.configured, true);
    assertDoesNotExposeValues(response.body);
  });

  it('stores secrets as ciphertext, becomes ready, and isolates site-scoped values', async () => {
    const mismatchedSite = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration/siteAccessToken?siteId=home`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders('alice', aliceToken),
        },
        body: JSON.stringify({ value: HOME_SITE_SECRET, siteId: 'travel' }),
      },
    );
    assert.equal(mismatchedSite.status, 400);
    assert.match(mismatchedSite.body.error, /does not match/);
    assert.equal(storedConfiguration(dataDir, 'siteAccessToken', 'home'), undefined);

    const applicationPut = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration/adminPassword?siteId=home`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders('alice', aliceToken),
        },
        body: JSON.stringify({ value: ADMIN_SECRET }),
      },
    );
    assert.equal(applicationPut.status, 200);
    assert.equal(applicationPut.body.ready, false);
    assert.deepEqual(applicationPut.body.missing, ['siteAccessToken']);
    assert.doesNotMatch(applicationPut.text, new RegExp(ADMIN_SECRET));

    const applicationRow = storedConfiguration(dataDir, 'adminPassword');
    assert.equal(applicationRow?.value_type, 'secret');
    assert.equal(applicationRow?.revision, 1);
    assert.notEqual(applicationRow?.value, ADMIN_SECRET);
    assert.doesNotMatch(applicationRow?.value || '', new RegExp(ADMIN_SECRET));
    assert.doesNotMatch(applicationRow?.value_digest || '', new RegExp(ADMIN_SECRET));

    const sitePut = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration/siteAccessToken?siteId=home`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders('alice', aliceToken),
        },
        body: JSON.stringify({ value: HOME_SITE_SECRET }),
      },
    );
    assert.equal(sitePut.status, 200);
    assert.equal(sitePut.body.ready, true);
    assert.deepEqual(sitePut.body.missing, []);
    assert.doesNotMatch(sitePut.text, new RegExp(HOME_SITE_SECRET));

    const homeRow = storedConfiguration(dataDir, 'siteAccessToken', 'home');
    assert.equal(homeRow?.value_type, 'secret');
    assert.notEqual(homeRow?.value, HOME_SITE_SECRET);
    assert.doesNotMatch(homeRow?.value || '', new RegExp(HOME_SITE_SECRET));

    const home = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration?siteId=home`,
      { headers: authHeaders('alice', aliceToken) },
    );
    assert.equal(home.status, 200);
    assert.equal(home.body.ready, true);
    assert.equal(home.body.declarations.adminPassword.configured, true);
    assert.equal(home.body.declarations.siteAccessToken.configured, true);
    assertDoesNotExposeValues(home.body);

    const travel = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration?siteId=travel`,
      { headers: authHeaders('alice', aliceToken) },
    );
    assert.equal(travel.status, 200);
    assert.equal(travel.body.ready, false);
    assert.deepEqual(travel.body.missing, ['siteAccessToken']);
    assert.equal(travel.body.declarations.adminPassword.configured, true);
    assert.equal(travel.body.declarations.siteAccessToken.configured, false);
    assert.equal(storedConfiguration(dataDir, 'siteAccessToken', 'travel'), undefined);
    assertDoesNotExposeValues(travel.body);

    const unknownSite = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration?siteId=unknown-site`,
      { headers: authHeaders('alice', aliceToken) },
    );
    assert.equal(unknownSite.status, 404);
    assert.equal(unknownSite.body.error, 'Site not found');

    const specAfterSecrets = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/application-spec`,
      { headers: authHeaders('alice', aliceToken) },
    );
    const yamlAfterSecrets = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/deploy.yaml`,
      { headers: authHeaders('alice', aliceToken) },
    );
    for (const secret of [ADMIN_SECRET, HOME_SITE_SECRET]) {
      assert.doesNotMatch(specAfterSecrets.text, new RegExp(secret));
      assert.doesNotMatch(yamlAfterSecrets.text, new RegExp(secret));
    }
  });

  it('guards site-local reductions before persistence but not increases or resets', async () => {
    const pairing = await request(port, '/api/suitcases/pairing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('alice', aliceToken),
      },
      body: JSON.stringify({ name: 'Scale Guard Suitcase' }),
    });
    assert.equal(pairing.status, 201);

    const sqlite = new Database(join(dataDir, 'deploy.db'));
    const fleet = sqlite.prepare('SELECT id FROM fleets LIMIT 1').get() as { id: string };
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO sites
          (id, fleet_id, name, kind, public_key, credential_status, mode, created_at, updated_at)
         VALUES ('site-scale-guard', ?, 'Scale Guard Suitcase', 'suitcase',
                 'test-public-key', 'active', 'away', ?, ?)`,
      )
      .run(fleet.id, now, now);
    sqlite
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, runtime_status, data_mode, sync_policy,
           shared_lineage, readiness, created_at, updated_at)
         VALUES ('replica-scale-guard', 'app-notes', 'site-scale-guard', 'running',
                 'replicated', 'automatic', 1, '{}', ?, ?)`,
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO nodes
          (id, name, kind, platform, architecture, capabilities, enrolled_at, last_seen_at)
         VALUES ('coordinator', 'Coordinator', 'agent', 'linux', 'arm64', '{}', ?, ?)`,
      )
      .run(now, Date.now());
    sqlite.close();

    const headers = {
      'Content-Type': 'application/json',
      ...authHeaders('alice', aliceToken),
    };
    const coordinatorConfiguration = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration/siteAccessToken?siteId=coordinator`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value: 'coordinator-scale-token' }),
      },
    );
    assert.notEqual(coordinatorConfiguration.status, 409, coordinatorConfiguration.text);
    const scalePath = `/api/deployments/${APPLICATION_NAME}/components/web/scale`;
    const reduction = await request(port, scalePath, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'site',
        instances: 1,
        expectedParentDigest: compiledManifest.digest,
      }),
    });
    assert.equal(reduction.status, 409);
    assert.equal(reduction.body.code, 'fleet_acknowledgement_required');
    let verify = new Database(join(dataDir, 'deploy.db'), { readonly: true });
    assert.equal(
      verify
        .prepare(
          `SELECT instances FROM component_site_overrides
            WHERE app_id = 'app-notes' AND site_id = 'coordinator' AND component_key = 'web'`,
        )
        .get(),
      undefined,
    );
    verify.close();

    const writable = new Database(join(dataDir, 'deploy.db'));
    writable
      .prepare(
        `INSERT INTO component_site_overrides
          (app_id, deployment_name, site_id, component_key, instances, updated_by, updated_at)
         VALUES ('app-notes', ?, 'coordinator', 'web', 1, 'alice', ?)`,
      )
      .run(APPLICATION_NAME, now);
    writable.close();

    const increase = await request(port, scalePath, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'site',
        instances: 2,
        expectedParentDigest: compiledManifest.digest,
      }),
    });
    assert.notEqual(increase.status, 409, increase.text);
    verify = new Database(join(dataDir, 'deploy.db'), { readonly: true });
    assert.deepEqual(
      verify
        .prepare(
          `SELECT instances FROM component_site_overrides
            WHERE app_id = 'app-notes' AND site_id = 'coordinator' AND component_key = 'web'`,
        )
        .get(),
      { instances: 2 },
    );
    verify.close();

    const reset = await request(port, scalePath, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'site',
        useDefault: true,
        expectedParentDigest: compiledManifest.digest,
      }),
    });
    assert.notEqual(reset.status, 409, reset.text);
    verify = new Database(join(dataDir, 'deploy.db'));
    assert.equal(
      verify
        .prepare(
          `SELECT instances FROM component_site_overrides
            WHERE app_id = 'app-notes' AND site_id = 'coordinator' AND component_key = 'web'`,
        )
        .get(),
      undefined,
    );
    const suitcaseRuntime = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/application-runtime?revision=active&siteId=site-scale-guard`,
      { headers: authHeaders('alice', aliceToken) },
    );
    assert.equal(suitcaseRuntime.status, 200, suitcaseRuntime.text);
    assert.equal(suitcaseRuntime.body.siteId, 'site-scale-guard');

    verify
      .prepare(
        `INSERT OR IGNORE INTO nodes
          (id, name, kind, platform, architecture, capabilities, enrolled_at, last_seen_at)
         VALUES ('remote-agent', 'Remote Agent', 'agent', 'linux', 'arm64', '{}', ?, ?)`,
      )
      .run(now, Date.now());
    verify
      .prepare(
        `UPDATE deployments
            SET active_node_id = 'remote-agent', desired_node_id = 'remote-agent'
          WHERE name = ?`,
      )
      .run(APPLICATION_NAME);
    const remoteSiteCount = await request(port, scalePath, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        scope: 'site',
        siteId: 'site-scale-guard',
        instances: 3,
        expectedParentDigest: compiledManifest.digest,
      }),
    });
    assert.equal(remoteSiteCount.status, 202, remoteSiteCount.text);
    assert.equal(remoteSiteCount.body.pendingTargetProcessing, true);
    assert.equal(remoteSiteCount.body.siteId, 'site-scale-guard');
    verify
      .prepare(
        `UPDATE deployments
            SET active_node_id = 'coordinator', desired_node_id = 'coordinator'
          WHERE name = ?`,
      )
      .run(APPLICATION_NAME);
    verify.prepare("DELETE FROM app_replicas WHERE id = 'replica-scale-guard'").run();
    verify.prepare("DELETE FROM sites WHERE id = 'site-scale-guard'").run();
    verify.close();
  });

  it('previews and records UI-authored desired revisions without activating them', async () => {
    const nextManifestSource = manifestSource.replace('default: dark', 'default: light');
    const nextManifest = compileDeployYaml(nextManifestSource);
    const headers = {
      'Content-Type': 'application/json',
      ...authHeaders('alice', aliceToken),
    };

    const preview = await request(port, `/api/deployments/${APPLICATION_NAME}/application-plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ manifest: nextManifestSource }),
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.parentDigest, compiledManifest.digest);
    assert.equal(preview.body.candidateDigest, nextManifest.digest);
    assert.equal(preview.body.plan.blocked, false);
    assert.equal(preview.body.plan.actions[0].classification, 'configuration-declaration-change');

    const staleWrite = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/application-spec`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          manifest: nextManifestSource,
          expectedParentDigest: 'sha256:stale',
        }),
      },
    );
    assert.equal(staleWrite.status, 409);
    assert.equal(staleWrite.body.expectedParentDigest, compiledManifest.digest);

    const saved = await request(port, `/api/deployments/${APPLICATION_NAME}/application-spec`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        manifest: nextManifestSource,
        expectedParentDigest: compiledManifest.digest,
      }),
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.desiredDigest, nextManifest.digest);
    assert.equal(saved.body.activeDigest, compiledManifest.digest);
    assert.equal(saved.body.applied, false);
    assert.doesNotMatch(saved.text, new RegExp(ADMIN_SECRET));
    assert.doesNotMatch(saved.text, new RegExp(HOME_SITE_SECRET));

    const graph = await request(port, `/api/deployments/${APPLICATION_NAME}/application-spec`, {
      headers: authHeaders('alice', aliceToken),
    });
    assert.equal(graph.body.desiredDigest, nextManifest.digest);
    assert.equal(graph.body.activeDigest, compiledManifest.digest);
    assert.equal(graph.body.source, 'ui');
    assert.equal(graph.body.sourceAligned, false);
    assert.equal(graph.body.notYetInSource, true);
    const desiredRevision = graph.body.revisions.find(
      (revision: { digest: string }) => revision.digest === nextManifest.digest,
    );
    assert.equal(desiredRevision.parentDigest, compiledManifest.digest);
    assert.equal(desiredRevision.active, false);

    const desiredConfiguration = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration?siteId=home`,
      { headers: authHeaders('alice', aliceToken) },
    );
    assert.equal(desiredConfiguration.status, 200);
    assert.equal(desiredConfiguration.body.ready, true);
    assert.equal(desiredConfiguration.body.declarations.adminPassword.configured, true);
    assert.equal(desiredConfiguration.body.declarations.siteAccessToken.configured, true);
    assertDoesNotExposeValues(desiredConfiguration.body);

    const rotatedActiveSecret = 'rotated-active-secret-do-not-echo';
    const activeRotation = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/configuration/adminPassword?revision=active&siteId=home`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ value: rotatedActiveSecret }),
      },
    );
    assert.equal(activeRotation.status, 200);
    assert.equal(activeRotation.body.revisionTarget, 'active');
    assert.equal(activeRotation.body.specDigest, compiledManifest.digest);
    assert.equal(activeRotation.body.activationRequired, false);
    assert.doesNotMatch(activeRotation.text, new RegExp(rotatedActiveSecret));

    const activeValue = storedConfiguration(dataDir, 'adminPassword');
    const stagedValue = storedConfiguration(dataDir, 'adminPassword', '', nextManifest.digest);
    assert.equal(activeValue?.revision, 2);
    assert.equal(stagedValue?.revision, 1);
    assert.notEqual(activeValue?.value, stagedValue?.value);

    setDeploymentStatus(dataDir, 'building');
    const racingRevision = await request(
      port,
      `/api/deployments/${APPLICATION_NAME}/application-spec`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          manifest: nextManifestSource,
          expectedParentDigest: nextManifest.digest,
        }),
      },
    );
    setDeploymentStatus(dataDir, 'stopped');
    assert.equal(racingRevision.status, 409);
    assert.match(racingRevision.body.error, /while a deploy or migration/);
  });

  it('rejects stale repository ancestry, rebases clean edits, exports a parent patch, and aligns without restart', async () => {
    const headers = {
      'Content-Type': 'application/json',
      ...authHeaders('alice', aliceToken),
    };
    const repositoryEdit = `# deploy.local/base: ${compiledManifest.digest}\n${manifestSource.replace(
      'metadata:\n  name: notes',
      'metadata:\n  name: notes\n  description: Repository description',
    )}`;
    const staleArchive = await tarGzip([{ header: { name: 'deploy.yaml' }, body: repositoryEdit }]);
    const stale = await upload(port, APPLICATION_NAME, 'alice', aliceToken, staleArchive, {
      expectedParentDigest: compiledManifest.digest,
    });
    assert.equal(stale.status, 409);
    assert.equal(
      stale.body.currentDigest,
      compileDeployYaml(manifestSource.replace('default: dark', 'default: light')).digest,
    );
    assert.deepEqual(stale.body.choices, ['rebase', 'replace', 'cancel']);

    const rebase = await request(port, `/api/deployments/${APPLICATION_NAME}/application-rebase`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        manifest: repositoryEdit,
        baseDigest: compiledManifest.digest,
      }),
    });
    assert.equal(rebase.status, 200, rebase.text);
    assert.equal(rebase.body.ready, true);
    assert.equal(rebase.body.plan.blocked, false);
    assert.equal(
      compileDeployYaml(rebase.body.manifest).spec.metadata.description,
      'Repository description',
    );
    assert.equal(compileDeployYaml(rebase.body.manifest).spec.configuration.theme.default, 'light');
    assert.equal(parseRepositoryBaseDigest(rebase.body.manifest), rebase.body.currentDigest);

    const patch = await request(port, `/api/deployments/${APPLICATION_NAME}/deploy.patch.yaml`, {
      headers: authHeaders('alice', aliceToken),
    });
    assert.equal(patch.status, 200);
    assert.match(patch.text, /kind: ApplicationPatch/);
    assert.match(patch.text, new RegExp(`parentDigest: ${compiledManifest.digest}`));
    assert.match(patch.text, /default: light/);

    const exported = await request(port, `/api/deployments/${APPLICATION_NAME}/deploy.yaml`, {
      headers: authHeaders('alice', aliceToken),
    });
    const alignedDigest = compileDeployYaml(exported.text).digest;
    const aligned = await upload(
      port,
      APPLICATION_NAME,
      'alice',
      aliceToken,
      await tarGzip([{ header: { name: 'deploy.yaml' }, body: exported.text }]),
      { expectedParentDigest: alignedDigest },
    );
    assert.equal(aligned.status, 200, aligned.text);
    assert.equal(aligned.body.unchanged, true);
    assert.equal(aligned.body.sourceAligned, true);

    const graph = await request(port, `/api/deployments/${APPLICATION_NAME}/application-spec`, {
      headers: authHeaders('alice', aliceToken),
    });
    assert.equal(graph.body.sourceAligned, true);
    assert.equal(graph.body.notYetInSource, false);
    assert.equal(graph.body.activeDigest, compiledManifest.digest);
  });

  it('guards graph activation with desired-revision CAS and handles an aligned no-op', async () => {
    const sqlite = new Database(join(dataDir, 'deploy.db'));
    sqlite
      .prepare('UPDATE deployments SET desired_spec_digest = active_spec_digest WHERE name = ?')
      .run(APPLICATION_NAME);
    sqlite.close();
    await stopServer(server);
    server = await startServer(port, dataDir);
    const headers = {
      'Content-Type': 'application/json',
      ...authHeaders('alice', aliceToken),
    };
    const stale = await request(port, `/api/deployments/${APPLICATION_NAME}/application-apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedDesiredDigest: 'sha256:stale' }),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.expectedDesiredDigest, compiledManifest.digest);

    const aligned = await request(port, `/api/deployments/${APPLICATION_NAME}/application-apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedDesiredDigest: compiledManifest.digest }),
    });
    assert.equal(aligned.status, 200);
    assert.deepEqual(aligned.body, {
      applied: true,
      unchanged: true,
      activeDigest: compiledManifest.digest,
    });
  });
});

describe('target-local Suitcase component API', () => {
  it('executes a profile operation on the active local Suitcase site', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'deploy-suitcase-component-api-'));
    const fakeBin = join(dataDir, 'fake-bin');
    const siteId = 'site_suitcase_local';
    const port = await getPort();
    let server: ChildProcess | undefined;
    try {
      server = await startServer(port, dataDir);
      const aliceToken = await register(port, 'alice');
      await stopServer(server);
      server = undefined;

      seedLocalSuitcaseProfileApplication(dataDir, siteId);
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        join(fakeBin, 'docker'),
        '#!/bin/sh\nif [ "$1" = "exec" ]; then printf "suitcase-profile-ok"; exit 0; fi\nexit 1\n',
        { mode: 0o755 },
      );
      server = await startServer(port, dataDir, {
        DEPLOY_SUITCASE: '1',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      });

      const response = await request(
        port,
        '/api/deployments/suitcase-db/components/database/operations/readiness',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders('alice', aliceToken),
          },
          body: JSON.stringify({ variables: {} }),
        },
      );
      assert.equal(response.status, 201, response.text);
      assert.equal(response.body.exitCode, 0);
      assert.equal(response.body.output, 'suitcase-profile-ok');

      const sqlite = new Database(join(dataDir, 'deploy.db'), { readonly: true });
      const operation = sqlite
        .prepare(
          `SELECT site_id, component_key, operation, status, output
             FROM component_profile_operations ORDER BY started_at DESC LIMIT 1`,
        )
        .get() as Record<string, unknown>;
      sqlite.close();
      assert.deepEqual(operation, {
        site_id: siteId,
        component_key: 'database',
        operation: 'readiness',
        status: 'succeeded',
        output: 'suitcase-profile-ok',
      });
    } finally {
      await stopServer(server);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
