import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AddressInfo, createServer } from 'node:net';

// Find an available port
function getPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Start the API server as a child process with isolated data directory
async function startServer(port: number, dataDir: string): Promise<ChildProcess> {
  // The API requests in these tests go over the HTTP server (PORT); the
  // HTTPS server still starts, so give it a random port too — otherwise it
  // tries to bind 443 (EACCES as non-root) and falls back to a fixed 8443,
  // which collides when a real server or a parallel test run is around.
  const httpsPort = await getPort();
  return new Promise((resolve, reject) => {
    const serverPath = join(process.cwd(), 'server.ts');
    // process.execPath (not 'node') so the child runs the exact same Node as
    // the test runner — PATH lookup can resolve a different version (volta
    // project pin vs pnpm's runtime), and native modules like better-sqlite3
    // then fail to load in the child with an ABI mismatch.
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        HTTPS_PORT: String(httpsPort),
        DEPLOY_DATA_DIR: dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        child.kill();
        reject(new Error('Server did not start within 5s'));
      }
    }, 5000);

    child.stdout!.on('data', (data: Buffer) => {
      if (!started && data.toString().includes('running on')) {
        started = true;
        clearTimeout(timeout);
        resolve(child);
      }
    });

    let stderrOutput = '';
    child.stderr!.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}: ${stderrOutput}`));
      }
    });
  });
}

// HTTP helper
async function req(port: number, path: string, options: RequestInit = {}) {
  const res = await fetch(`http://localhost:${port}${path}`, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

function authHeaders(username: string, token: string) {
  return {
    'x-deploy-username': username,
    'x-deploy-token': token,
  };
}

describe('API – auth flow', () => {
  let server: ChildProcess;
  let port: number;
  let tempDir: string;

  before(async () => {
    port = await getPort();
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(port, tempDir);
  });

  after(() => {
    server?.kill();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /register creates a user and returns 201', async () => {
    const { status, body } = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pass123' }),
    });
    assert.equal(status, 201);
    assert.ok(body.token);
    assert.equal(typeof body.token, 'string');
  });

  it('POST /api/register rejects duplicate username', async () => {
    const { status, body } = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'other' }),
    });
    assert.equal(status, 409);
    assert.ok(body.error);
  });

  it('POST /api/register rejects missing fields', async () => {
    const { status } = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(status, 400);
  });

  it('POST /api/login returns token for valid credentials', async () => {
    // Register first
    await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'logintest', password: 'secret' }),
    });
    const { status, body } = await req(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'logintest', password: 'secret' }),
    });
    assert.equal(status, 200);
    assert.ok(body.token);
  });

  it('POST /api/login rejects wrong password', async () => {
    const { status, body } = await req(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'logintest', password: 'wrong' }),
    });
    assert.equal(status, 401);
    assert.ok(body.error);
  });

  it('GET /api/user returns user info with valid auth', async () => {
    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'userinfo', password: 'pass' }),
    });
    const { status, body } = await req(port, '/api/user', {
      headers: authHeaders('userinfo', reg.body.token),
    });
    assert.equal(status, 200);
    assert.equal(body.username, 'userinfo');
    assert.ok(body.createdAt);
  });

  it('GET /api/user returns 401 without auth', async () => {
    const { status } = await req(port, '/api/user');
    assert.equal(status, 401);
  });

  it('GET /api/logout invalidates the token', async () => {
    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'logouttest', password: 'pass' }),
    });
    const token = reg.body.token;

    // Logout
    const { status } = await req(port, '/api/logout', {
      headers: authHeaders('logouttest', token),
    });
    assert.equal(status, 200);

    // Token should now be invalid
    const { status: afterStatus } = await req(port, '/api/user', {
      headers: authHeaders('logouttest', token),
    });
    assert.equal(afterStatus, 401);
  });

  it('GET /api/logout only invalidates that session', async () => {
    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'logouttest2', password: 'pass' }),
    });
    const token1 = reg.body.token;

    const login = await req(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'logouttest2', password: 'pass' }),
    });
    const token2 = login.body.token;

    // Logout session 1
    await req(port, '/api/logout', {
      headers: authHeaders('logouttest2', token1),
    });

    // Token 1 should be invalid
    const { status: s1 } = await req(port, '/api/user', {
      headers: authHeaders('logouttest2', token1),
    });
    assert.equal(s1, 401);

    // Token 2 should still work
    const { status: s2 } = await req(port, '/api/user', {
      headers: authHeaders('logouttest2', token2),
    });
    assert.equal(s2, 200);
  });

  it('POST /api/user/password changes the password', async () => {
    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pwchange', password: 'oldpass' }),
    });

    const { status } = await req(port, '/api/user/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('pwchange', reg.body.token),
      },
      body: JSON.stringify({ currentPassword: 'oldpass', newPassword: 'newpass' }),
    });
    assert.equal(status, 200);

    // Can login with new password
    const login = await req(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pwchange', password: 'newpass' }),
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
  });

  it('POST /api/user/password rejects wrong current password', async () => {
    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pwchange2', password: 'oldpass' }),
    });

    const { status } = await req(port, '/api/user/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders('pwchange2', reg.body.token),
      },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'newpass' }),
    });
    assert.equal(status, 401);
  });
});

describe('API – deployments', () => {
  let server: ChildProcess;
  let port: number;
  let tempDir: string;
  let token: string;

  before(async () => {
    port = await getPort();
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(port, tempDir);

    // Register a user for deployment tests
    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'deployer', password: 'pass' }),
    });
    token = reg.body.token;
  });

  after(() => {
    server?.kill();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('GET /api/deployments returns empty array for new user', async () => {
    const { status, body } = await req(port, '/api/deployments', {
      headers: authHeaders('deployer', token),
    });
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });

  it('GET /api/deployments/:name returns 404 for non-existent', async () => {
    const { status } = await req(port, '/api/deployments/nope', {
      headers: authHeaders('deployer', token),
    });
    assert.equal(status, 404);
  });

  it('DELETE /api/deployments/:name returns 404 for non-existent', async () => {
    const { status } = await req(port, '/api/deployments/nope', {
      method: 'DELETE',
      headers: authHeaders('deployer', token),
    });
    assert.equal(status, 404);
  });

  it('GET /api/deployments/:name/inspect returns 404 for non-existent', async () => {
    const { status } = await req(port, '/api/deployments/nope/inspect', {
      headers: authHeaders('deployer', token),
    });
    assert.equal(status, 404);
  });

  it('GET /api/deployments/:name/stats returns 404 for non-existent', async () => {
    const { status } = await req(port, '/api/deployments/nope/stats', {
      headers: authHeaders('deployer', token),
    });
    assert.equal(status, 404);
  });

  it('POST /api/deployments/:name/restart returns 404 for non-existent', async () => {
    const { status } = await req(port, '/api/deployments/nope/restart', {
      method: 'POST',
      headers: authHeaders('deployer', token),
    });
    assert.equal(status, 404);
  });

  it('GET /api/deployments/:name/history returns 404 for non-existent', async () => {
    const { status } = await req(port, '/api/deployments/nope/history', {
      headers: authHeaders('deployer', token),
    });
    assert.equal(status, 404);
  });
});

describe('API – upload validation', () => {
  let server: ChildProcess;
  let port: number;
  let tempDir: string;
  let token: string;

  before(async () => {
    port = await getPort();
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(port, tempDir);

    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'uploader', password: 'pass' }),
    });
    token = reg.body.token;
  });

  after(() => {
    server?.kill();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/upload returns 401 without auth', async () => {
    const { status } = await req(port, '/api/upload', { method: 'POST' });
    assert.equal(status, 401);
  });

  it('POST /api/upload returns 400 with no file', async () => {
    const boundary = '----TestBoundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\ntestapp\r\n--${boundary}--\r\n`;
    const { status } = await req(port, '/api/upload', {
      method: 'POST',
      headers: {
        ...authHeaders('uploader', token),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    assert.equal(status, 400);
  });
});

describe('API – CORS and 404', () => {
  let server: ChildProcess;
  let port: number;
  let tempDir: string;

  before(async () => {
    port = await getPort();
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(port, tempDir);
  });

  after(() => {
    server?.kill();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Non-/api/ paths on the HTTP listener 301-redirect to HTTPS by design, so
  // these exercise the middleware's CORS/404 handling via /api/ paths.
  it('OPTIONS returns 204 with CORS headers', async () => {
    const { status, headers } = await req(port, '/api/anything', { method: 'OPTIONS' });
    assert.equal(status, 204);
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.ok(headers.get('access-control-allow-methods'));
  });

  it('GET /api/nonexistent returns 404', async () => {
    const { status } = await req(port, '/api/nonexistent');
    assert.equal(status, 404);
  });
});
