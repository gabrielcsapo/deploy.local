import { registrationVector } from './v2/auth-vectors.ts';
import { offerPasskey, preferPasskey, trusted } from '../app/routes/v2-public/auth-policy.ts';
import { setupTestAccount, testAuthHeaders } from './test-auth.ts';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Let the kernel keep the selected port reserved through startup. An IPC message
// from the HTTP listener is readiness; the HTTPS log line is not HTTP readiness.
async function startServer(
  dataDir: string,
  origin = 'https://dev.dontneeda.pw',
): Promise<ChildProcess & { port: number }> {
  const entry = new URL('../server.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { Server } from 'node:http';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      this.once('listening', () => {
        const port = this.address().port;
        if (process.env.DEPLOY_PUBLIC_ORIGIN === 'self')
          process.env.DEPLOY_PUBLIC_ORIGIN = 'http://localhost:' + port;
        process.send({ port });
      });
      return listen.apply(this, args);
    };
    await import(${JSON.stringify(entry)});
  `,
    ],
    {
      env: {
        ...process.env,
        PORT: '0',
        HTTPS_PORT: '0',
        DEPLOY_SSH_PORT: '0',
        DEPLOY_MDNS_ADDRESS: '127.0.0.1',
        DOCKER_HOST: 'unix:///nonexistent/docker.sock',
        DEPLOY_DATA_DIR: dataDir,
        DEPLOY_PUBLIC_ORIGIN: origin,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  ) as ChildProcess & { port: number };
  let output = '';
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`HTTP listener did not start: ${output}`)),
        60000,
      );
      child.once('message', (message: { port: number }) => {
        clearTimeout(timer);
        child.port = message.port;
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited (${code}): ${output}`));
      });
    });
    return child;
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

async function stopServer(server: ChildProcess | undefined) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await exited;
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
  let server: ChildProcess & { port: number };
  let port: number;
  let tempDir: string;
  let adminHeaders: Record<string, string>;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(tempDir);
    port = server.port;
    adminHeaders = testAuthHeaders(await setupTestAccount(`http://localhost:${port}`, tempDir));
  });

  after(async () => {
    await stopServer(server);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('setup owner signs in with a password, sees a trusted-only offer, registers a passkey and gets passkey-first sign-in', async () => {
    assert.equal((await req(port, '/api/v2/setup')).body.needsSetup, false);
    const login = await req(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'test-password-123' }),
    });
    assert.equal(login.status, 200);
    const headers = authHeaders('test-admin', login.body.token);
    const account = () => req(port, '/api/v2/auth/account', { headers });
    const initial = (await account()).body;
    const probe: typeof fetch = (path, options) =>
      fetch(`http://localhost:${port}${path}`, options);
    const context = (secure: boolean, protocol = 'https:') => ({
      isSecureContext: secure,
      location: { protocol } as Location,
    });
    assert.equal(await trusted(context(false), probe), false);
    assert.equal(await trusted(context(true, 'http:'), probe), false);
    assert.equal(
      await trusted(context(true), async () => {
        throw new Error('untrusted certificate');
      }),
      false,
    );
    assert.equal(
      await trusted(context(true), async () => new Response('', { status: 503 })),
      false,
    );
    assert.equal(offerPasskey(initial, false), false);
    const trust = await trusted(context(true), probe);
    assert.equal(trust, true);
    assert.equal(offerPasskey(initial, trust), true);
    assert.equal(preferPasskey((await req(port, '/api/v2/auth/methods')).body, trust), false);
    const post = (path: string, body: unknown) =>
      req(port, path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    await post('/api/v2/auth/account', { passkeyOffered: true, firstTaskSeen: true });
    assert.equal(offerPasskey((await account()).body, trust), false);
    assert.equal((await account()).body.firstTaskSeen, true);
    const options = await post('/api/v2/auth/passkey/register/options', {});
    assert.equal(options.status, 200);
    // This upstream "none" attestation has no attestation signature; bind its
    // client data to the fresh server challenge, keeping the library's RP/key data.
    const vector = structuredClone(registrationVector);
    const client = JSON.parse(Buffer.from(vector.response.clientDataJSON, 'base64url').toString());
    client.challenge = options.body.options.challenge;
    vector.response.clientDataJSON = Buffer.from(JSON.stringify(client)).toString('base64url');
    const verified = await post('/api/v2/auth/passkey/register/verify', {
      challengeId: options.body.challengeId,
      response: vector,
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal((await account()).body.hasPasskey, true);
    assert.equal(offerPasskey((await account()).body, trust), false);
    const methods = (await req(port, '/api/v2/auth/methods')).body;
    assert.equal(preferPasskey(methods, trust), true);
    assert.equal(preferPasskey(methods, false), false);
    const again = await req(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'test-password-123' }),
    });
    assert.equal(again.status, 200, 'Password still works after passkey registration');
    assert.equal(
      (
        await req(port, '/api/v2/auth/account', {
          headers: authHeaders('test-admin', again.body.token),
        })
      ).body.firstTaskSeen,
      true,
      'First-task hints stay dismissed across sessions',
    );
  });

  it('POST /register lets an admin create a user and returns 201', async () => {
    const { status, body } = await req(port, '/api/register', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'pass123' }),
    });
    assert.equal(status, 201);
    assert.ok(body.token);
    assert.equal(typeof body.token, 'string');
  });

  it('POST /api/register rejects anonymous registration', async () => {
    const { status } = await req(port, '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'anonymous', password: 'test-password' }),
    });
    assert.equal(status, 401);
  });

  it('POST /api/register rejects duplicate username', async () => {
    const { status, body } = await req(port, '/api/register', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'other' }),
    });
    assert.equal(status, 409);
    assert.ok(body.error);
  });

  it('POST /api/register rejects missing fields', async () => {
    const { status } = await req(port, '/api/register', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(status, 400);
  });

  it('POST /api/login returns token for valid credentials', async () => {
    // Register first
    await req(port, '/api/register', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
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
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
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
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
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
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
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
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
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
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
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
  let server: ChildProcess & { port: number };
  let port: number;
  let tempDir: string;
  let adminHeaders: Record<string, string>;
  let token: string;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(tempDir);
    port = server.port;
    adminHeaders = testAuthHeaders(await setupTestAccount(`http://localhost:${port}`, tempDir));

    // Register a user for deployment tests
    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'deployer', password: 'pass' }),
    });
    token = reg.body.token;
  });

  after(async () => {
    await stopServer(server);
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
  let server: ChildProcess & { port: number };
  let port: number;
  let tempDir: string;
  let adminHeaders: Record<string, string>;
  let token: string;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(tempDir);
    port = server.port;
    adminHeaders = testAuthHeaders(await setupTestAccount(`http://localhost:${port}`, tempDir));

    const reg = await req(port, '/api/register', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'uploader', password: 'pass' }),
    });
    token = reg.body.token;
  });

  after(async () => {
    await stopServer(server);
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
  let server: ChildProcess & { port: number };
  let port: number;
  let tempDir: string;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'deploy-sh-api-'));
    server = await startServer(tempDir);
    port = server.port;
  });

  after(async () => {
    await stopServer(server);
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

describe('CLI sign-in through the real HTTP API', () => {
  let server: ChildProcess & { port: number };
  let port: number;
  let directory: string;
  let origin: string;
  let owner: { username: string; token: string };
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'deploy-login-api-'));
    server = await startServer(directory, 'self');
    port = server.port;
    origin = `http://localhost:${port}`;
    owner = await setupTestAccount(origin, directory);
    mkdirSync(join(directory, 'bin'));
    // Record browser launch without invoking a desktop browser or real service.
    for (const name of ['open', 'xdg-open'])
      writeFileSync(
        join(directory, 'bin', name),
        '#!/bin/sh\nprintf "%s" "$1" > "$DEPLOY_TEST_BROWSER_URL"\n',
        { mode: 0o755 },
      );
  });
  after(async () => {
    if (server?.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  async function login(password: boolean) {
    const accountHome = join(directory, password ? 'password-home' : 'browser-home');
    mkdirSync(accountHome);
    const browserFile = join(accountHome, 'browser-url');
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), 'bin/deploy.js'),
        'login',
        '-u',
        origin,
        ...(password ? ['--password'] : []),
      ],
      {
        env: {
          ...process.env,
          HOME: accountHome,
          PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
          DEPLOY_AUTH_JSON: '',
          DEPLOY_AUTH_FILE: '',
          DEPLOY_TEST_BROWSER_URL: browserFile,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    let output = '';
    child.stdout!.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      if (password && text.includes('Username:')) child.stdin!.write('test-admin\n');
      if (password && text.includes('Password:')) child.stdin!.end('test-password-123\n');
    });
    child.stderr!.on('data', (chunk) => {
      output += chunk;
    });
    try {
      if (!password) {
        const deadline = Date.now() + 10000;
        while (!existsSync(browserFile) && Date.now() < deadline && child.exitCode === null)
          await delay(25);
        assert.ok(existsSync(browserFile), output);
        const verification = new URL(readFileSync(browserFile, 'utf8'));
        assert.equal(verification.origin, origin);
        assert.equal(verification.pathname, '/signin');
        const code = verification.searchParams.get('cli');
        assert.ok(code);
        assert.ok(output.includes(code));
        assert.equal(
          existsSync(join(accountHome, '.deployrc')),
          false,
          'No session saved before approval',
        );
        const approval = await req(port, '/api/v2/auth/cli/approve', {
          method: 'POST',
          headers: { ...testAuthHeaders(owner), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, approved: true }),
        });
        assert.equal(approval.status, 200);
      }
      const [code] = await Promise.race([
        exited,
        delay(10000, undefined, { ref: false }).then(() => {
          throw new Error(`CLI did not finish: ${output}`);
        }),
      ]);
      assert.equal(code, 0, output);
      const config = JSON.parse(readFileSync(join(accountHome, '.deployrc'), 'utf8'));
      assert.equal(config.username, owner.username);
      assert.equal(config.url, origin);
      assert.equal(
        (await req(port, '/api/user', { headers: testAuthHeaders(config) })).status,
        200,
      );
      if (!password) assert.equal(statSync(join(accountHome, '.deployrc')).mode & 0o777, 0o600);
      else assert.equal(existsSync(browserFile), false, 'Password mode does not launch a browser');
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
    }
  }
  it('deploy login waits for browser approval and saves the approved session privately', () =>
    login(false));
  it('deploy login --password still signs in', () => login(true));
});
