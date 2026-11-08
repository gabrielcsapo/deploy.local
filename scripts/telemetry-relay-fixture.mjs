/** Temporary, real HTTP relay/ingest fixture. Never contacts the configured coordinator. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const root = mkdtempSync(join(tmpdir(), 'telemetry-relay-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../server/store.ts');
const { _resetDb: resetStore } = store;
const { getRequestsSqlite, resetRequestsDb } = await import('../server/requests-db.ts');
const { handleRemoteTelemetry, issueRemoteTelemetryToken } =
  await import('../server/telemetry-remote.ts');
const { startTelemetryRelay } = await import('../server/telemetry-relay.ts');
const enrolled = store.redeemNodeEnrollment({
  code: store.createNodeEnrollment('Fixture Mac', 'fixture').code,
});
if (!enrolled.secret) throw new Error('Fixture enrollment failed');
store.registerDeploymentStart('relay-fixture', 'fixture', 'node');
const db = getRequestsSqlite();
const token = issueRemoteTelemetryToken(db, 'relay-fixture', enrolled.nodeId, 'fixture');
const coordinator = createServer((req, res) => {
  void handleRemoteTelemetry(req, res);
});
await new Promise((resolve, reject) => {
  coordinator.once('error', reject);
  coordinator.listen(5359, '127.0.0.1', resolve);
});
let relay;
async function close() {
  await relay?.close();
  coordinator.closeAllConnections();
  await new Promise((resolve) => coordinator.close(resolve));
  resetRequestsDb();
  resetStore();
  rmSync(root, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void close().then(() => process.exit());
  });
try {
  const host = process.argv.find((arg) => arg.startsWith('--host='))?.slice(7);
  relay = await startTelemetryRelay({
    coordinatorUrl: 'http://127.0.0.1:5359',
    nodeId: enrolled.nodeId,
    secret: enrolled.secret,
    macHost: host,
  });
  const body = JSON.stringify({
    v: 1,
    records: [
      {
        t: Date.now(),
        kind: 'page',
        route: '/fixture/:id',
        status: 200,
        ms: 12,
        phases: { ssr: 10 },
        build: null,
        aborted: false,
      },
    ],
  });
  console.log(JSON.stringify({ url: relay.url, token, temporaryData: root }));
  if (process.argv.includes('--dead')) await new Promise((resolve) => coordinator.close(resolve));
  const image = process.argv.find((arg) => arg.startsWith('--image='))?.slice(8);
  if (image) {
    const network = process.argv.find((arg) => arg.startsWith('--network='))?.slice(10);
    // Use an already-present app image with Node; no pull, build, mounts or published ports.
    const code = `const start=performance.now();fetch(process.env.RFR_TELEMETRY_URL+'/v1/server',{method:'POST',headers:{authorization:'Bearer '+process.env.RFR_TELEMETRY_TOKEN,'Content-Type':'application/json'},body:${JSON.stringify(body)},signal:AbortSignal.timeout(5000)}).then(r=>{console.log('container HTTP',r.status,'ms',performance.now()-start);if(r.status!==204)process.exitCode=1}).catch(e=>{console.error(e);process.exitCode=1})`;
    const result = await promisify(execFile)(
      'docker',
      [
        'run',
        '--rm',
        '--pull=never',
        ...(network ? ['--network', network] : []),
        '--entrypoint',
        'node',
        '-e',
        `RFR_TELEMETRY_URL=${relay.url}`,
        '-e',
        `RFR_TELEMETRY_TOKEN=${token}`,
        image,
        '-e',
        code,
      ],
      { timeout: 15000 },
    );
    console.log(result.stdout.trim());
  } else if (process.argv.includes('--check')) {
    const start = performance.now();
    const response = await fetch('http://127.0.0.1:5358/__deploy/v1/server', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body,
    });
    console.log('host HTTP', response.status, 'ms', performance.now() - start);
    if (response.status !== 204)
      throw new Error('Host probe failed (Linux requires --image for a bridge peer)');
  } else {
    console.log('Waiting for container POSTs; Ctrl-C removes fixture data.');
    await new Promise(() => {});
  }
  await relay.flush();
  const rows = db.prepare('SELECT deployment_name,source,count FROM telemetry_routes').all();
  console.log(JSON.stringify({ stats: relay.stats, rows }));
  if (process.argv.includes('--dead') ? relay.stats.droppedRecords !== 1 : rows[0]?.count !== 1)
    throw new Error('Fixture ingest assertion failed');
} finally {
  await close();
}
