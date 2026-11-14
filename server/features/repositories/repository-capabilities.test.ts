import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'deploy-capabilities-'));
process.env.DEPLOY_DATA_DIR = root;
const { gitText } = await import('../../workspace/repository-git.ts');
const { repositoryInfo } = await import('./repositories.ts');
const { save, db } = await import('../../workspace/store.ts');
const { workspaceApi } = await import('../../workspace/api.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('repository capabilities follow main; standalone applications have no repository tabs; links are owner scoped', async () => {
  const repo = join(root, 'source');
  mkdirSync(repo);
  const git = (args: string[]) => gitText(repo, args);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'Agent context only');
  await git(['add', '.']);
  await git(['commit', '-m', 'Context repository']);
  save('project', 'alice', {
    id: 'context',
    name: 'Context',
    repositoryPath: repo,
    repositoryStatus: 'ready',
    source: { kind: 'hosted' },
  });
  const capabilities = async () => ((await repositoryInfo('alice', 'context')) as any).deployment;
  assert.equal((await capabilities()).configured, false);
  const manifest = `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: linked-app
components:
  web:
    image: nginx:alpine
`;
  await git(['switch', '-c', 'add-deployment']);
  writeFileSync(join(repo, 'deploy.yaml'), manifest);
  await git(['add', '.']);
  await git(['commit', '-m', 'Proposed deployment']);
  assert.equal(
    (await capabilities()).configured,
    false,
    'feature branch/HEAD must not activate deployment',
  );
  await git(['switch', 'main']);
  await git(['merge', '--ff-only', 'add-deployment']);
  assert.equal((await capabilities()).configured, true);
  assert.equal((await capabilities()).application, 'linked-app');
  assert.equal(
    (await capabilities()).pipeline,
    false,
    'a deployable application need not define CI',
  );

  const server = createServer((req, res) => {
    void workspaceApi(req, res, String(req.headers['x-owner'] || 'alice'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const links = async (application: string, owner = 'alice') => {
      const response = await fetch(
        `${origin}/api/application-repositories?application=${application}`,
        { headers: { 'x-owner': owner } },
      );
      assert.equal(response.status, 200);
      return ((await response.json()) as any).projects;
    };
    assert.deepEqual(await links('standalone-app'), []);
    assert.deepEqual(await links('linked-app', 'bob'), []);
    assert.deepEqual(await links('linked-app'), [{ id: 'context', name: 'Context' }]);
    // Removing configuration removes the capability without destroying Git or collaboration.
    await git(['rm', 'deploy.yaml']);
    await git(['commit', '-m', 'Return to context only']);
    assert.equal((await capabilities()).configured, false);
    assert.deepEqual(await links('linked-app'), []);
    writeFileSync(join(repo, 'deploy.yaml'), 'invalid: [');
    await git(['add', '.']);
    await git(['commit', '-m', 'Broken configuration']);
    const invalid = await capabilities();
    assert.equal(invalid.configured, true, 'invalid configuration stays reachable for repair');
    assert.match(invalid.error, /Fix deploy.yaml/);
    assert.equal(invalid.application, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a pipeline without components or deploy does not configure deployment', async () => {
  const { repositoryDeployment } = await import('./repositories.ts');
  const repo = join(root, 'pipeline-only');
  mkdirSync(repo);
  const git = (args: string[]) => gitText(repo, args);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  const manifest =
    'apiVersion: deploy.local/v1\nkind: Application\nmetadata: {name: should-not-link}\npipeline:\n  jobs:\n    test:\n      run: pnpm test\n      runsOn: {os: linux}\n  publish: [packages/router]\n';
  for (const suffix of [
    '',
    '  deploy: {application: real-app}\n',
    'components:\n  web: {image: nginx:alpine}\n',
  ]) {
    writeFileSync(join(repo, 'deploy.yaml'), manifest + suffix);
    await git(['add', '.']);
    await git(['commit', '-m', 'Manifest']);
    const commit = await git(['rev-parse', 'HEAD']);
    const result = await repositoryDeployment(repo, `refs/heads/main\0${commit}`);
    assert.equal(result.pipeline, true);
    assert.equal(result.configured, !!suffix);
    assert.equal(
      result.application,
      suffix.startsWith('  deploy') ? 'real-app' : suffix ? 'should-not-link' : null,
    );
  }
});
