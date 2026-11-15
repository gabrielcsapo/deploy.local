import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'deploy-repository-browsing-'));
process.env.DEPLOY_DATA_DIR = root;
const { gitText } = await import('../../workspace/repository-git.ts');
const { repositoryRead } = await import('./repositories.ts');
const { save, db } = await import('../../workspace/store.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
test('repository browsing pins files, entry lookup, images, history and root diff to the selected commit', async () => {
  const repo = join(root, 'source');
  mkdirSync(repo);
  const git = (args: string[]) => gitText(repo, args);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Repository Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'README.md'), '# Project\n\n[Guide](docs/guide.md)');
  writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide');
  writeFileSync(join(repo, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]));
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial repository']);
  const initial = await git(['rev-parse', 'HEAD']);
  save('project', 'alice', { id: 'browsing', repositoryPath: repo, repositoryStatus: 'ready' });
  const read = (action: string, params: Record<string, string> = {}) =>
    repositoryRead(
      'alice',
      'browsing',
      action,
      new URLSearchParams({ ref: initial, ...params }),
    ) as Promise<any>;
  assert.deepEqual((await read('files')).paths, ['README.md', 'docs/guide.md', 'image.png']);
  assert.equal((await read('entry', { path: 'docs' })).type, 'tree');
  assert.equal((await read('entry', { path: 'docs/guide.md' })).type, 'blob');
  assert.equal((await read('history')).commits[0].author, 'Repository Test');
  const tree = await read('tree');
  assert.equal(tree.commitCount, 1);
  assert.equal(tree.latestCommit.oid, initial);
  assert.equal(tree.latestCommit.author, 'Repository Test');
  assert.equal(tree.latestCommit.subject, 'Initial repository');
  assert.equal(tree.entries[0].name, 'docs', 'directories sort before files');
  const blob = await read('blob', { path: 'docs/guide.md' });
  assert.equal(blob.latestCommit.oid, initial);
  assert.equal(blob.size, Buffer.byteLength('# Guide'));
  assert.match((await read('diff')).patch, /Initial repository|diff --git/);
  const image = await read('blob', { path: 'image.png' });
  assert.equal(image.image.mimeType, 'image/png');
  assert.ok(image.omitted);
  assert.equal(Buffer.from(image.image.data, 'base64')[0], 137);
  writeFileSync(join(repo, 'later.txt'), 'later');
  await git(['add', '.']);
  await git(['commit', '-m', 'Newer branch']);
  assert.equal(
    (await read('files')).paths.includes('later.txt'),
    false,
    'pinned finder cannot drift with the branch',
  );
  assert.equal((await read('tree')).commitCount, 1, 'cached history stays pinned');
  const current = (await repositoryRead('alice', 'browsing', 'tree', new URLSearchParams())) as any;
  assert.equal(current.commitCount, 2);
  assert.equal(current.latestCommit.subject, 'Newer branch');
  const unchanged = (await repositoryRead(
    'alice',
    'browsing',
    'blob',
    new URLSearchParams({ path: 'docs/guide.md' }),
  )) as any;
  assert.equal(unchanged.latestCommit.oid, initial, 'file metadata follows the file, not HEAD');
  await assert.rejects(read('entry', { path: '../outside' }), /Invalid repository path/);
  await assert.rejects(
    repositoryRead('bob', 'browsing', 'files', new URLSearchParams()),
    /Not found/,
  );
});
