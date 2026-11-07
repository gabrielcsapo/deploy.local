import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleWebRedirect } from './web-redirects.ts';

async function listen(server: Server) {
  for (let port = 5180; port <= 5199; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No free test port in 5180–5199');
}

test('web host sends HTTP 308 before SSR and resolves legacy apps with the current session', async () => {
  let renders = 0;
  const server = createServer(async (req, res) => {
    if (
      await handleWebRedirect(req, res, async (request, application) => {
        if (!request.headers.get('cookie')) return undefined;
        assert.equal(request.headers.get('cookie'), 'deploy-sh-auth=fixture');
        return application === 'home-gym' ? 'project-home-gym' : null;
      })
    )
      return;
    renders++;
    res.end('SSR');
  });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/dashboard/nodes`, { redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), '/dashboard/computers');
    assert.equal(await response.text(), '');
    const app = await fetch(`${origin}/dashboard/home-gym/releases`, {
      redirect: 'manual',
      headers: { Cookie: 'deploy-sh-auth=fixture' },
    });
    assert.equal(app.status, 308);
    assert.equal(app.headers.get('Location'), '/dashboard/projects/project-home-gym/releases');
    assert.equal(renders, 0);
    assert.equal((await fetch(`${origin}/dashboard/home-gym`, { redirect: 'manual' })).status, 200);
    assert.equal((await fetch(`${origin}/dashboard/projects`, { redirect: 'manual' })).status, 200);
    assert.equal(
      (await fetch(`${origin}/dashboard/nodes`, { method: 'POST', redirect: 'manual' })).status,
      200,
    );
    assert.equal(renders, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('both production and development hosts mount the adapter before rendering', () => {
  // Both entry points render only through the shared boot's client handler.
  const boot = readFileSync(new URL('./boot.ts', import.meta.url), 'utf8');
  assert.match(
    boot,
    /async function serveClient\([^]*?await handleWebRedirect\(req, res\)[^]*?await client\(req, res\)/,
  );
});

test('real project resolver authenticates cookies and isolates application ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v2-web-redirect-'));
  process.env.DEPLOY_DATA_DIR = root;
  const { registerUser } = await import('./store.ts');
  const { save, db } = await import('./workspace/store.ts');
  const { gitText } = await import('./workspace/repository-git.ts');
  const alice = registerUser('alice', 'fixture-password');
  const bob = registerUser('bob', 'fixture-password');
  assert.ok(alice.token && bob.token);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  await gitText(repo, ['init', '--initial-branch=main']);
  await gitText(repo, ['config', 'user.name', 'Test']);
  await gitText(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(
    join(repo, 'deploy.yaml'),
    'apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: home-gym\ncomponents:\n  web:\n    image: nginx:alpine\n',
  );
  await gitText(repo, ['add', '.']);
  await gitText(repo, ['commit', '-m', 'Fixture']);
  save('project', 'alice', {
    id: 'gym-project',
    name: 'home-gym',
    repositoryPath: repo,
    repositoryStatus: 'ready',
    source: { kind: 'hosted' },
  });
  const server = createServer(async (req, res) => {
    if (!(await handleWebRedirect(req, res))) res.end('Client fallback');
  });
  const origin = await listen(server);
  try {
    const response = await fetch(`${origin}/dashboard/home-gym`, {
      redirect: 'manual',
      headers: { Cookie: `deploy-sh-auth=${encodeURIComponent(`alice:${alice.token}`)}` },
    });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), '/dashboard/projects/gym-project/apps/home-gym');
    const otherOwner = await fetch(`${origin}/dashboard/home-gym`, {
      redirect: 'manual',
      headers: { 'x-deploy-username': 'bob', 'x-deploy-token': bob.token! },
    });
    assert.equal(otherOwner.headers.get('Location'), '/dashboard/live');
    const invalid = await fetch(`${origin}/dashboard/home-gym`, {
      redirect: 'manual',
      headers: { Cookie: 'deploy-sh-auth=alice%3Ainvalid' },
    });
    assert.equal(invalid.status, 200);
    assert.equal(await invalid.text(), 'Client fallback');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
