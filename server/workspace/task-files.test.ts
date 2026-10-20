import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
const directory = mkdtempSync(join(tmpdir(), 'task-files-'));
process.env.DEPLOY_DATA_DIR = directory;
const { workspaceApi } = await import('./api.ts');
const { save, db } = await import('./store.ts');
const { createTask } = await import('./test-repository.ts');
const { git } = await import('./service.ts');
const task = createTask('alice', { title: 'Files' });
const root = task.workspacePath;
mkdirSync(join(root, 'web'));
writeFileSync(join(root, 'old.txt'), 'before\n');
writeFileSync(join(root, 'gone.txt'), 'gone\n');
mkdirSync(join(root, 'deleted'));
writeFileSync(join(root, 'deleted/child.txt'), 'gone\n');
git(root, ['add', '.']);
git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'Base']);
save('task', 'alice', { ...task, baseRevision: git(root, ['rev-parse', 'HEAD']) });
writeFileSync(join(root, 'old.txt'), 'after\n');
rmSync(join(root, 'gone.txt'));
rmSync(join(root, 'deleted'), { recursive: true });
writeFileSync(join(root, 'web/format-time.mjs'), 'export const format = 1;\n');
writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]));
writeFileSync(join(root, 'large'), Buffer.alloc(256 * 1024 + 1, 65));
writeFileSync(join(root, 'boundary'), 'a'.repeat(256 * 1024));
symlinkSync(directory, join(root, 'escape'));
const read = async (path = '', content = false, id = task.id, owner = 'alice') => {
  let status = 0,
    body: any;
  await workspaceApi(
    {
      method: 'GET',
      url: `/api/workspace/tasks/${id}/files${content ? '/content' : ''}?path=${encodeURIComponent(path)}`,
    } as IncomingMessage,
    {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = JSON.parse(value);
      },
    } as unknown as ServerResponse,
    owner,
  );
  return { status, body };
};
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
test('lists and reads working files, including added, modified and deleted files', async () => {
  const listing = await read();
  assert.equal(listing.status, 200);
  assert.equal(
    listing.body.entries.find((entry: any) => entry.path === 'old.txt').change,
    'Modified',
  );
  assert.equal(
    listing.body.entries.find((entry: any) => entry.path === 'gone.txt').change,
    'Deleted',
  );
  assert.ok(!listing.body.entries.some((entry: any) => entry.name === '.git'));
  assert.equal((await read('web')).body.entries[0].change, 'Added');
  assert.equal(
    (await read('web/format-time.mjs', true)).body.content,
    'export const format = 1;\n',
  );
  assert.equal((await read('gone.txt', true)).body.omitted, 'Deleted in this task');
  assert.equal((await read('deleted')).body.entries[0].change, 'Deleted');
});
test('refuses traversal, symlinks and other owners', async () => {
  for (const path of [
    '../outside',
    '/etc/passwd',
    'web/../../outside',
    '.git/config',
    'escape',
    'escape/workspace',
  ]) {
    assert.equal((await read(path, true)).status, 400, path);
  }
  assert.equal((await read('', false, task.id, 'bob')).status, 404);
  assert.equal((await read('old.txt', true, task.id, 'bob')).status, 404);
});
test('binary and oversized previews are explicit and reads stay bounded', async () => {
  assert.equal((await read('binary', true)).body.omitted, 'Binary file');
  const large = (await read('large', true)).body;
  assert.match(large.omitted, /256 KiB/);
  assert.equal(large.content, undefined);
  assert.equal((await read('boundary', true)).body.content.length, 256 * 1024);
});
test('remote workers return an actionable computer message for listing and file reads', async () => {
  save('worker', 'alice', { id: 'mac', name: 'Owner’s MacBook' });
  save('task', 'alice', {
    ...task,
    id: 'remote',
    workerId: 'mac',
    workspacePath: '/does/not/exist',
  });
  for (const content of [false, true]) {
    const result = await read('web/new.ts', content, 'remote');
    assert.equal(result.status, 200);
    assert.equal(result.body.omitted, 'Files are on Owner’s MacBook; open Changes to review them');
    assert.equal(result.body.content, undefined);
  }
});
test("the account's managed worker reads its workspace on this machine", async () => {
  const { useManagedWorkspaceDirectory } = await import('./task-files.ts');
  // The managed worker's files live under its own root; the coordinator's path is a placeholder.
  useManagedWorkspaceDirectory((workerId, taskId) =>
    workerId === 'managed-alice' && taskId === 'managed' ? root : '/does/not/exist',
  );
  save('managed-worker', 'alice', { id: 'managed-alice' });
  save('task', 'alice', {
    ...task,
    id: 'managed',
    workerId: 'managed-alice',
    workspacePath: '/placeholder',
  });
  const listing = (await read('web', false, 'managed')).body;
  assert.equal(listing.omitted, undefined);
  assert.ok(listing.entries.some((entry: any) => entry.name === 'format-time.mjs'));
  assert.match((await read('web/format-time.mjs', true, 'managed')).body.content, /format = 1/);
});
test('a missing workspace says so instead of exposing a filesystem error', async () => {
  save('task', 'alice', {
    ...task,
    id: 'missing',
    workerId: 'local',
    workspacePath: join(directory, 'gone'),
  });
  const result = (await read('', false, 'missing')).body;
  assert.equal(result.omitted, 'This task’s workspace is no longer on this computer');
});
