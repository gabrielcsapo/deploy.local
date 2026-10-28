import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { CopyPreviews, copyHostname } from './copies.ts';
const root = mkdtempSync(join(tmpdir(), 'copy-access-'));
mkdirSync(join(root, 'workspace'));
const main = new Database(join(root, 'deploy.db'));
main.exec('CREATE TABLE sessions(username TEXT, token TEXT, expires_at INTEGER)');
main.prepare('INSERT INTO sessions VALUES(?,?,?)').run('owner', 'secret', Date.now() + 60_000);
main
  .prepare('INSERT INTO sessions VALUES(?,?,?)')
  .run('other', 'other-secret', Date.now() + 60_000);
const workspace = new Database(join(root, 'workspace/workspace.db'));
workspace.exec('CREATE TABLE records(kind TEXT,owner TEXT,data TEXT)');
const restore = { id: 'test', state: 'ready', copies: [{ app: 'home-gym', port: 5187 }] };
const save = () => {
  workspace.exec('DELETE FROM records');
  workspace
    .prepare('INSERT INTO records VALUES(?,?,?)')
    .run('v2-backup-restore', 'owner', JSON.stringify(restore));
};
save();
const previews = new CopyPreviews(join(root, 'deploy.db'), false);
after(() => {
  previews.close();
  main.close();
  workspace.close();
  rmSync(root, { recursive: true, force: true });
});
const host = copyHostname('test', 'home-gym');
function call(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: 5186, path, headers: { host, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
test('copy preview requires the owner session, strips credentials, and expires on Switch, Cancel and revocation', async () => {
  const backend = createServer((req, res) => res.end(JSON.stringify(req.headers)));
  const edge = createServer((req, res) => {
    if (!previews.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  backend.listen(5187, '127.0.0.1');
  await once(backend, 'listening');
  edge.listen(5186, '127.0.0.1');
  await once(edge, 'listening');
  try {
    assert.equal((await call('/')).status, 303);
    assert.equal(
      (await call('/', { 'x-deploy-username': 'other', 'x-deploy-token': 'other-secret' })).status,
      403,
    );
    const native = await call('/data', {
      'x-deploy-username': 'owner',
      'x-deploy-token': 'secret',
      authorization: 'Bearer private',
    });
    assert.equal(native.status, 200);
    assert.doesNotMatch(native.body, /secret|private|x-deploy/);
    assert.equal(native.headers['cache-control'], 'no-store');
    const opening = `/_copy/open?host=${host}&path=%2Fdata`;
    assert.equal((await call(opening, { host: 'deploy.local' })).status, 401);
    const bridge = await call(opening, {
      host: 'deploy.local',
      cookie: 'deploy-sh-auth=owner%3Asecret',
    });
    assert.equal(bridge.status, 303);
    const ticketPath =
      new URL(bridge.headers.location).pathname + new URL(bridge.headers.location).search;
    const auth = await call(ticketPath);
    assert.equal(auth.status, 303);
    assert.equal(auth.headers.location, '/data');
    const cookie = auth.headers['set-cookie'][0].split(';')[0];
    assert.match(auth.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Lax/);
    assert.equal((await call(ticketPath)).status, 403);
    const page = await call('/data', { cookie });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /__Host-deploy-copy|secret/);
    assert.equal((await call('/data', { cookie, 'x-deploy-agent-token': 'agent' })).status, 403);
    for (const state of ['switching', 'cancelled', 'failed', 'creating', 'live']) {
      restore.state = state;
      save();
      assert.equal((await call('/data', { cookie })).status, 404);
    }
    restore.state = 'ready';
    save();
    main.prepare('DELETE FROM sessions WHERE username=?').run('owner');
    assert.equal((await call('/data', { cookie })).status, 303);
    assert.equal(
      (await call('/data', { 'x-deploy-username': 'owner', 'x-deploy-token': 'secret' })).status,
      403,
    );
    assert.equal(
      (await call('/data', { host: 'copy-unknown.home-gym.deploy.local', cookie })).status,
      404,
    );
  } finally {
    await Promise.all([
      new Promise<void>((done) => edge.close(() => done())),
      new Promise<void>((done) => backend.close(() => done())),
    ]);
  }
});
test('copy address rejects names that could escape the private host namespace', () => {
  assert.throws(() => copyHostname('../id', 'app'));
  assert.throws(() => copyHostname('id', 'app.evil'));
});
