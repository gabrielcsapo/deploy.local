import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

test('DELETE removes a running plain legacy groffee container with ordinary success', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-legacy-retirement-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DOCKER_HOST = `unix://${join(root, 'docker.sock')}`;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const removed: string[] = [];
  const docker = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'DELETE') {
      removed.push(req.url!);
      res.writeHead(204).end();
    } else if (req.url?.includes('/containers/json')) {
      res.end(
        JSON.stringify([
          { Id: 'fixture-running', Names: ['/deploy-sh-groffee'], State: 'running', Status: 'Up' },
        ]),
      );
    } else if (req.url?.includes('/events')) {
      res.end();
    } else {
      res.writeHead(404).end(JSON.stringify({ message: 'No such container' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    docker.once('error', reject);
    docker.listen(join(root, 'docker.sock'), resolve);
  });
  t.after(() => {
    docker.closeAllConnections();
    docker.close();
  });
  const store = await import('./store.ts');
  const { apiMiddleware } = await import('./api.ts');
  const { stopMetricsCollector } = await import('./metrics-collector.ts');
  const { stopDockerEventStream } = await import('./docker.ts');
  const owner = store.registerUser('fixture-owner', 'synthetic-password');
  const member = store.registerUser('fixture-member', 'synthetic-password');
  store.saveDeployment({
    name: 'groffee',
    username: 'fixture-owner',
    type: 'docker',
    port: 39001,
    containerId: 'fixture-running',
    containerName: 'deploy-sh-groffee',
    activeNodeId: 'coordinator',
    desiredNodeId: 'coordinator',
  });
  store.updateDeploymentStatus('groffee', 'running');
  const volumes = join(root, 'volumes', 'groffee');
  const backups = join(root, 'backups', 'groffee');
  mkdirSync(volumes, { recursive: true });
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(volumes, 'fixture'), 'synthetic');
  writeFileSync(join(backups, 'fixture'), 'synthetic backup');
  const api = apiMiddleware();
  const call = async (
    username?: string,
    token?: string,
    path = '/api/deployments/groffee',
    method = 'DELETE',
  ) => {
    const req = Object.assign(Readable.from([]), {
      url: path,
      method,
      headers: {
        host: 'localhost',
        ...(username ? { 'x-deploy-username': username, 'x-deploy-token': token } : {}),
      },
      socket: {},
    });
    let status = 0;
    let body: unknown;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = JSON.parse(value);
      },
    };
    await api(req as unknown as IncomingMessage, res as unknown as ServerResponse, () => {
      status = 404;
    });
    return { status, body };
  };
  try {
    assert.equal(store.getDeployment('groffee')?.activeSpecDigest, null);
    assert.equal((await call()).status, 401);
    assert.equal((await call('fixture-member', member.token!)).status, 404);
    assert.equal(removed.length, 0);
    assert.deepEqual(await call('fixture-owner', owner.token!), {
      status: 200,
      body: { message: 'Deleted groffee' },
    });
    assert.ok(removed.some((path) => path.endsWith('/containers/deploy-sh-groffee?force=true')));
    assert.ok(!store.getDeployment('groffee'), 'the app record is gone');
    assert.equal(existsSync(volumes), false);
    assert.equal(existsSync(join(backups, 'fixture')), true);
    for (const path of [
      '/api/deployments/groffee/legacy-update',
      '/api/deployments/groffee/legacy-update/recover',
      '/api/deployments/groffee/legacy-update/rollback',
      '/api/deployments/wander/managed-adoption',
      '/api/deployments/wander/managed-adoption/preflight',
      '/api/deployments/wander/managed-adoption/recover',
      '/api/deployments/wander/managed-adoption/cancel',
      '/api/deployments/wander/managed-adoption/upload',
    ]) {
      for (const method of ['GET', 'POST']) {
        assert.equal(
          (await call('fixture-owner', owner.token!, path, method)).status,
          404,
          `${method} ${path}`,
        );
      }
    }
  } finally {
    api.close();
    stopMetricsCollector();
    stopDockerEventStream();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopDockerEventStream();
    store._resetDb();
  }
});
