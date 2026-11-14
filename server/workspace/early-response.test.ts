import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, createServer, request } from 'node:http';
import { once } from 'node:events';
const data = mkdtempSync(join(tmpdir(), 'deploy-early-response-'));
process.env.DEPLOY_DATA_DIR = data;
const { workspaceApi } = await import('./api.ts');
const server = createServer((req, res) => void workspaceApi(req, res, 'alice'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as any).port;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(data, { recursive: true, force: true });
});

// One pooled socket, like the edge's pool to control under light load.
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
function send(method: string, path: string, body?: Buffer) {
  return new Promise<{ status: number; connection?: string; ms: number }>((resolve, reject) => {
    const started = performance.now();
    const req = request(
      { port, method, path, agent, headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            connection: res.headers.connection,
            ms: performance.now() - started,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('a body rejected partway is drained so the next request on its socket is not held up', async () => {
  const rejected = await send('POST', '/api/tasks', Buffer.alloc(1_000_000, 'a'));
  assert.equal(rejected.status, 413);
  // The follow-up must not queue behind the unread upload until the server's idle timeout.
  const next = await send('GET', '/api/transcription');
  assert.equal(next.status, 200);
  assert.ok(next.ms < 1000, `follow-up took ${next.ms}ms`);
});
