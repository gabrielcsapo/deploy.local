import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'v2-search-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { db, save, remove } = await import('../workspace/store.ts');
const { v2Api } = await import('./api.ts');
const { matchFileNames, searchRepositoryCode } = await import('../workspace/repository-search.ts');
const { snippet } = await import('../workspace/message-search.ts');
const server = createServer(async (req, res) => {
  await v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'owner') }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

function repository(name: string, files: Record<string, string | Buffer>) {
  const work = join(root, `${name}-work`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(work, path, '..'), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'first');
  const bare = join(root, `${name}.git`);
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  return bare;
}
const homeGym = repository('home-gym', {
  'worker/sync.ts': 'const a = 1;\n  .where(gte(workouts.started, since))\nconst last = max(Workouts.Started);\n',
  'app/routes/history.tsx': '.orderBy(desc(workouts.started))\n',
  'db/started.sql': '-- nothing here\n',
  'logo.bin': Buffer.from([0, 1, 2, ...Buffer.from('workouts.started')]),
});
const tally = repository('tally', { 'README.md': 'tally counts things\n' });
save('project', 'owner', { id: 'p1', name: 'home-gym', repositoryPath: homeGym });
save('project', 'owner', { id: 'p2', name: 'tally', repositoryPath: tally });
save('project', 'other', { id: 'p9', name: 'home-secrets', repositoryPath: homeGym });
save('agent', 'owner', { id: 'a1', name: 'Code reviewer', job: '', computers: [], createdBy: 'owner' });
save('task', 'owner', {
  id: 't1',
  projectId: 'p1',
  agentId: 'a1',
  title: 'Rename workouts.started safely',
  status: 'done',
  createdAt: '2026-11-01T00:00:00.000Z',
});
save('task', 'owner', { id: 't2', projectId: 'p2', title: 'Count faster', createdAt: '2026-11-02T00:00:00.000Z' });
save('message', 'owner', {
  id: 'm1',
  taskId: 't1',
  role: 'assistant',
  content: 'Changed the last reads of Workouts.Started in the worker and reran the sync tests.',
  createdAt: '2026-11-03T00:00:00.000Z',
});
save('message', 'owner', {
  id: 'm2',
  taskId: 't1',
  role: 'assistant',
  content: 'reading workouts.started…',
  isProgress: true,
  createdAt: '2026-11-03T00:00:01.000Z',
});
save('message', 'owner', { id: 'm3', taskId: 't2', role: 'user', content: 'make it quick', createdAt: '2026-11-04T00:00:00.000Z' });
save('message', 'other', { id: 'm4', taskId: 'x', role: 'user', content: 'workouts.started is mine', createdAt: '' });
save('agent-message', 'owner', {
  id: 'am1',
  agentId: 'a1',
  event: { kind: 'reply', id: 'e1', at: '2026-11-05T00:00:00.000Z', agent: 'a1', paragraphs: ['First.', 'The worker still reads workouts.started.'] },
});

const read = async (path: string, owner = 'owner') => {
  const response = await fetch(origin + path, { headers: { 'x-test-owner': owner } });
  return { status: response.status, body: (await response.json()) as any };
};

test('names match projects, apps, tasks and agents, and stay inside the owner', async () => {
  const { body } = await read('/api/search?q=home');
  assert.deepEqual(
    body.names.filter((name: any) => name.kind === 'project').map((name: any) => name.title),
    ['home-gym'],
  );
  const tasks = (await read('/api/search?q=WORKOUTS.started')).body.names;
  assert.deepEqual(
    tasks.map((name: any) => [name.kind, name.title, name.agent, name.project]),
    [['task', 'Rename workouts.started safely', 'Code reviewer', 'home-gym']],
  );
  const agents = (await read('/api/search?q=review')).body.names;
  assert.deepEqual(agents.map((name: any) => [name.kind, name.title]), [['agent', 'Code reviewer']]);
  assert.deepEqual((await read('/api/search?q=')).body.names, []);
});

test('messages match text in task and agent chats, ignoring case and progress notes', async () => {
  const { body } = await read('/api/search?q=workouts.started');
  assert.equal(body.messages.total, 2);
  assert.deepEqual(
    body.messages.items.map((item: any) => [item.id, item.title, item.who, item.taskId ?? null]),
    [
      ['e1', 'Code reviewer', 'Code reviewer', null],
      ['m1', 'Rename workouts.started safely', 'Code reviewer', 't1'],
    ],
  );
  assert.match(body.messages.items[1].snippet, /Workouts\.Started/);
  // Two characters is too little to search text with.
  assert.equal((await read('/api/search?q=wo')).body.messages.total, 0);
  // Inside a project only that project's task chats answer.
  assert.deepEqual(
    (await read('/api/search?q=workouts.started&project=p1')).body.messages.items.map((item: any) => item.id),
    ['m1'],
  );
  assert.equal((await read('/api/search?q=workouts.started&project=p2')).body.messages.total, 0);
});

test('the message index follows edits and deletions', async () => {
  save('message', 'owner', { id: 'm3', taskId: 't2', role: 'user', content: 'make it zippy', createdAt: '2026-11-04T00:00:00.000Z' });
  assert.equal((await read('/api/search?q=quick')).body.messages.total, 0);
  assert.equal((await read('/api/search?q=zippy')).body.messages.total, 1);
  remove('message', 'owner', 'm3');
  assert.equal((await read('/api/search?q=zippy')).body.messages.total, 0);
  assert.equal((await read('/api/search?q=say "hi"')).status, 200);
});

test('code matches lines on each project’s main branch and skips binary files', async () => {
  const { body } = await read('/api/search/code?q=workouts.started&limit=2');
  assert.equal(body.lines, 3);
  assert.equal(body.files, 2);
  assert.equal(body.projects, 1);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.items, [
    { projectId: 'p1', project: 'home-gym', ref: 'main', path: 'app/routes/history.tsx', line: 1, text: '.orderBy(desc(workouts.started))' },
    { projectId: 'p1', project: 'home-gym', ref: 'main', path: 'worker/sync.ts', line: 2, text: '.where(gte(workouts.started, since))' },
  ]);
  assert.equal((await read('/api/search/code?q=workouts.started&project=p2')).body.lines, 0);
  assert.equal((await read('/api/search/code?q=wo')).body.lines, 0);
  assert.equal((await read('/api/search/code?q=workouts.started&project=p9')).status, 404);
});

test('inside a project, file names match and the branch is named', async () => {
  const { body } = await read('/api/search?q=started&project=p1');
  assert.deepEqual(body.files, {
    total: 1,
    items: [{ path: 'db/started.sql', name: 'started.sql', directory: 'db' }],
    ref: 'main',
  });
  assert.equal((await read('/api/search/code?q=started&project=p1')).body.ref, 'main');
});

test('a broad code search stops at its limit and says so', async () => {
  const result = await searchRepositoryCode(homeGym, 'HEAD', 'workouts.started', { count: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.lines, 2);
});

test('file names rank a leading match first, and snippets keep the match in view', () => {
  assert.deepEqual(
    matchFileNames(['server/reclone.ts', 'server/clone.test.ts', 'server/clone.ts', 'clone/readme.md'], 'clone').items.map((item) => item.path),
    ['server/clone.ts', 'server/clone.test.ts', 'server/reclone.ts'],
  );
  const long = `${'a '.repeat(200)}needle ${'b '.repeat(200)}`;
  const cut = snippet(long, 'NEEDLE', 60);
  assert.ok(cut.includes('needle') && cut.startsWith('…') && cut.endsWith('…'));
});
