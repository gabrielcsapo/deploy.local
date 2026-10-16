// Disposable HTTP/TLS fixture. No production credentials or application state.
import { createServer } from 'node:http';
import { createServer as tlsServer } from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.DEPLOY_DATA_DIR;
const mock = process.env.CI_REAL_DOCKER !== '1';
if (mock) process.env.DOCKER_HOST = 'unix://' + join(root, 'docker.sock');
const store = await import('./store.ts');
const { compileDeployYaml } = await import('./application-spec.ts');
const { ensureCerts, getTlsOptions } = await import('./certs.ts');
store.ensureCoordinatorNode();
store.setDefaultNode('coordinator');
const owner = store.registerUser('ci-owner', 'disposable-test-password');
const app = process.env.CI_FIXTURE_APP || 'ci-fixture';
const manifest =
  `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: ${app}
components:
  web:
    build:
      context: .
    role: web
    interfaces:
      http:
        port: 3000
        protocol: http
    health:
      interface: http
      path: /health
routes:
  public:
    to: web.http
` + (process.env.CI_FIXTURE_PIPELINE || '');
let backend;
if (mock) {
  backend = createServer((_q, r) => r.end('fixture-original'));
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const port = backend.address().port;
  const id = 'a'.repeat(64);
  const docker = createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    if (q.url.includes('/containers/json'))
      r.end(
        JSON.stringify([
          {
            Id: id,
            Names: ['/deploy-sh-' + app + '-web'],
            State: 'running',
            Status: 'Up fixture',
            Labels: { 'deploy-sh.app': app },
          },
        ]),
      );
    else if (q.url.includes('/containers/') && q.url.endsWith('/json'))
      r.end(
        JSON.stringify({
          Id: id,
          Image: 'sha256:' + '0'.repeat(64),
          State: { Status: 'running' },
          Config: { Image: 'fixture', Env: [] },
          NetworkSettings: {
            Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
          },
        }),
      );
    else if (q.url.includes('/events')) r.end('');
    else if (q.url.includes('/info')) r.end('{}');
    else r.end('[]');
  });
  await new Promise((r) => docker.listen(join(root, 'docker.sock'), r));
  mkdirSync(join(root, 'source'));
  writeFileSync(join(root, 'source', 'original.txt'), 'original');
  const graph = compileDeployYaml(manifest);
  store.saveDeployment({
    name: app,
    username: 'ci-owner',
    type: 'application-graph',
    containerId: id,
    containerName: 'deploy-sh-' + app + '-web',
    port,
    directory: join(root, 'source'),
  });
  store.saveDesiredApplicationSpec({
    deploymentName: app,
    digest: graph.digest,
    apiVersion: graph.spec.apiVersion,
    source: 'repository',
    manifestFormat: 'deploy.yaml',
    normalizedSpec: graph.canonicalJson,
    originalSource: manifest,
    createdBy: 'ci-owner',
  });
  store.activateDesiredApplicationSpec(app, graph.digest);
  store.updateDeploymentArtifactDigests(app, { sourceArtifactDigest: 'sha256:' + '0'.repeat(64) });
  store.updateDeploymentStatus(app, 'running');
}
ensureCerts([app]);
const { apiMiddleware } = await import('./api.ts');
const handler = apiMiddleware();
const respond = (q, r) =>
  handler(q, r, () => {
    r.statusCode = 404;
    r.end();
  });
const http = createServer(respond);
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const https = tlsServer(getTlsOptions(), respond);
await new Promise((r) => https.listen(0, '0.0.0.0', r));
process.send({
  port: http.address().port,
  httpsPort: https.address().port,
  ownerToken: owner.token,
  manifest,
  app,
  ca: join(root, 'certs', 'ca.crt'),
});
process.on('message', (msg) => {
  if (msg === 'stop') {
    store._resetDb();
    process.exit(0);
  }
});
