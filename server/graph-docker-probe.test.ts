import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DockerCliGraphAdapter, type GraphContainerInspection } from './graph-docker-adapter.ts';

// Release verification runs the new version on an internal Docker network, where Docker
// publishes no ports. The health check then reaches the container by its network address.
test('a container with no published port is probed at its network address', async () => {
  const server = createServer((request, response) => {
    response.statusCode = request.url === '/health' ? 200 : 503;
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const adapter = new DockerCliGraphAdapter() as unknown as {
    probe(name: string, inspection: GraphContainerInspection, probe: unknown): Promise<boolean>;
  };
  const inspection = (addresses: string[]): GraphContainerInspection => ({
    id: 'x',
    name: 'verify-web',
    exists: true,
    running: true,
    status: 'running',
    health: 'none',
    hostPorts: {},
    addresses,
  });
  try {
    const http = { kind: 'http', containerPort: port, path: '/health' };
    assert.equal(await adapter.probe('verify-web', inspection([]), http), false);
    assert.equal(await adapter.probe('verify-web', inspection(['127.0.0.1']), http), true);
    assert.equal(
      await adapter.probe('verify-web', inspection(['127.0.0.1']), { ...http, path: '/down' }),
      false,
    );
    assert.equal(
      await adapter.probe('verify-web', inspection(['127.0.0.1']), {
        kind: 'tcp',
        containerPort: port,
      }),
      true,
    );
  } finally {
    server.close();
  }
});
