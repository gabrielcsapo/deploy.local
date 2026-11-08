/** Orchestrator-only real Docker smoke test. No app, multicast, published container
 * ports, existing state, or image pull. Requires an already available Node 26 image.
 * DEPLOY_MDNS_ADDRESS=127.0.0.1 pnpm exec tsx scripts/telemetry-docker-fixture.ts
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
assert.equal(process.env.DEPLOY_MDNS_ADDRESS, '127.0.0.1');
const root = mkdtempSync(join(tmpdir(), 'deploy-telemetry-docker-'));
process.env.DEPLOY_DATA_DIR = root;
const { getRequestsSqlite, resetRequestsDb } = await import('../server/requests-db.ts');
const { containerTelemetryEnvironment, startTelemetryCollector } =
  await import('../server/telemetry-runtime.ts');
const { createHotPathHandler } = await import('../server/edge/proxy.ts');
const { writeEdgeTelemetry, readPerformance } = await import('../server/telemetry.ts');
const db = getRequestsSqlite();
const collector = await startTelemetryCollector();
const upstream = createServer((_req, res) => {
  res.writeHead(200, { 'server-timing': 'route;desc="/photos/:id", match;dur=0.1, render;dur=2' });
  res.end('fixture');
});
const handler = createHotPathHandler({
  getRoute: (name) => (name === 'fixture' ? { name, port: 5351 } : null),
  logRequest: (name, entry) => writeEdgeTelemetry(db, [{ name, entry }]),
  emitEvent: () => {},
});
const edge = createServer((req, res) => {
  if (!handler(req, res)) {
    res.writeHead(404);
    res.end();
  }
});
async function edgeRequest(path: string, method = 'GET', body?: unknown) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: 5350, path, method, headers: { host: 'fixture.local' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
try {
  upstream.listen(5351, '127.0.0.1');
  edge.listen(5350, '127.0.0.1');
  await Promise.all([once(upstream, 'listening'), once(edge, 'listening')]);
  const env = await containerTelemetryEnvironment('fixture');
  const code = `const res=await fetch(process.env.DEPLOY_TELEMETRY_URL+'/v1/server',{method:'POST',headers:{authorization:'Bearer '+process.env.DEPLOY_TELEMETRY_TOKEN,'content-type':'application/json'},body:JSON.stringify({v:1,records:[{t:Date.now(),kind:'page',route:'/photos/:id',status:200,ms:100,phases:{match:1,ssr:80,stream:19},build:'fixture',aborted:false},{t:Date.now(),kind:'error',route:'/photos/:id',where:'ssr',name:'Error',message:'fixture exception',stack:'at render (app/page.ts:1:1)',fingerprint:'a'.repeat(40)}]}),signal:AbortSignal.timeout(2000)});if(res.status!==204)throw new Error('collector status '+res.status);`;
  const args = [
    'run',
    '--rm',
    '--pull=never',
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    process.env.DEPLOY_TELEMETRY_FIXTURE_IMAGE ?? 'node:26-alpine',
    'node',
    '--input-type=module',
    '-e',
    code,
  ];
  await promisify(execFile)('docker', args, { timeout: 15_000 });
  assert.equal(await edgeRequest('/photos/123'), 200);
  assert.equal(
    await edgeRequest('/__deploy/telemetry', 'POST', {
      v: 1,
      build: 'fixture',
      events: [
        { type: 'load', route: '/photos/:id', lcp: 2500, inp: 100, cls: 0.1, ttfb: 100 },
        { type: 'nav', route: '/photos/:id', from: '/', ms: 200, prefetch: 'hit' },
      ],
    }),
    204,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const result = readPerformance(db, 'fixture', '1h');
  assert.equal(result.summary.requests, 1);
  assert.equal(result.hasRouteData, true);
  assert.equal(result.pageExperience[0].prefetch.hit, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.routes[0].slowestPhase?.name, 'ssr');
  console.log(
    JSON.stringify(
      { result: 'passed', privateCollector: env.DEPLOY_TELEMETRY_URL, performance: result },
      null,
      2,
    ),
  );
} finally {
  edge.closeAllConnections();
  upstream.closeAllConnections();
  edge.close();
  upstream.close();
  collector.close();
  resetRequestsDb();
  rmSync(root, { recursive: true, force: true });
}
