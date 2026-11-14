import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
if (process.env.DEPLOY_TEST_NO_BROWSER === '1') {
  const { chromium } = await import('playwright');
  mock.method(chromium, 'launch', () => {
    throw new Error('Browser execution disabled for this test run');
  });
}
const root = mkdtempSync(join(tmpdir(), 'v2-artifacts-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { db, save } = await import('../workspace/store.ts');
const { gitText } = await import('../workspace/repository-git.ts');
const { v2Api } = await import('./api.ts');
const { answerInboxAsync } = await import('./inbox.ts');
const server = createServer(async (req, res) => {
  await v2Api(req, res, () => ({ username: 'alice' }));
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

const repo = join(root, 'source');
mkdirSync(join(repo, 'design/boards'), { recursive: true });
mkdirSync(join(repo, 'design/ds/deploy-local'), { recursive: true });
const git = (args: string[]) => gitText(repo, args);
await git(['init', '--initial-branch=main']);
await git(['config', 'user.name', 'Artifacts Test']);
await git(['config', 'user.email', 'test@example.invalid']);
writeFileSync(
  join(repo, 'design/canvas.json'),
  JSON.stringify({
    title: 'Test',
    boards: { 'Welcome.html': { x: 0, y: 0, w: 1440, h: 900, title: 'Welcome' } },
    notes: {},
  }),
);
writeFileSync(
  join(repo, 'design/boards/Welcome.html'),
  '<!doctype html><html><body><h1 data-layer="title">Welcome</h1></body></html>',
);
writeFileSync(join(repo, 'design/ds/deploy-local/tokens.css'), ':root{--ink:#18181b}');
await git(['add', '.']);
await git(['commit', '-m', 'Add the design']);
save('project', 'alice', {
  id: 'site',
  name: 'site',
  repositoryPath: repo,
  repositoryStatus: 'ready',
});
const plain = join(root, 'plain');
mkdirSync(plain);
await gitText(plain, ['init', '--initial-branch=main']);
await gitText(plain, ['config', 'user.name', 'Artifacts Test']);
await gitText(plain, ['config', 'user.email', 'test@example.invalid']);
writeFileSync(join(plain, 'README.md'), '# Plain\n');
await gitText(plain, ['add', '.']);
await gitText(plain, ['commit', '-m', 'Start']);
save('project', 'alice', {
  id: 'plain',
  name: 'plain',
  repositoryPath: plain,
  repositoryStatus: 'ready',
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
const json = async (response: Response) => {
  const body = await response.json();
  return { status: response.status, body };
};

test('the gallery lists the App design and nothing for a project without one', async () => {
  const { body } = await json(await api('/api/artifacts'));
  assert.deepEqual(
    body.artifacts.map((entry: any) => [entry.projectId, entry.artifact, entry.kind, entry.name]),
    [['site', null, 'design', 'App design']],
  );
  assert.equal(body.artifacts[0].boards, 1);
  assert.equal(body.artifacts[0].state, null);
  assert.deepEqual(
    body.projects.map((project: any) => project.id),
    ['site', 'plain'],
  );
});

test('creating a design writes artifacts/<name> on its own branch and opens an empty canvas', async () => {
  const created = await json(
    await api('/api/artifacts', {
      method: 'POST',
      body: JSON.stringify({ kind: 'design', name: 'Onboarding flow', project: 'plain' }),
    }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.artifact, 'onboarding-flow');
  assert.equal(created.body.branch, 'artifact/onboarding-flow');
  // main is untouched; the folder is on the branch.
  assert.equal(
    await gitText(plain, ['ls-tree', '--name-only', 'main', 'artifacts/']).catch(() => ''),
    '',
  );
  const canvas = JSON.parse(
    await gitText(plain, [
      'show',
      'artifact/onboarding-flow:artifacts/onboarding-flow/canvas.json',
    ]),
  );
  assert.equal(canvas.title, 'Onboarding flow');
  assert.deepEqual(canvas.boards, {});
  const design = await json(
    await api('/api/projects/plain/artifacts/onboarding-flow/design?ref=artifact/onboarding-flow'),
  );
  assert.equal(design.status, 200);
  assert.equal(design.body.canvas.title, 'Onboarding flow');
  assert.deepEqual(
    design.body.branches.map((branch: any) => branch.name),
    ['artifact/onboarding-flow'],
  );
  // Making the files is not an edit: the new canvas has no edits and changes nothing yet.
  assert.equal(design.body.branches[0].edits, 0);
  const changes = await json(
    await api(
      '/api/projects/plain/artifacts/onboarding-flow/design/changes?ref=artifact/onboarding-flow',
    ),
  );
  assert.deepEqual(changes.body.files, []);
  // The same name twice is refused rather than overwritten.
  const again = await api('/api/artifacts', {
    method: 'POST',
    body: JSON.stringify({ kind: 'design', name: 'Onboarding  flow!', project: 'plain' }),
  });
  assert.equal(again.status, 409);
  const { body } = await json(await api('/api/artifacts'));
  const made = body.artifacts.find((entry: any) => entry.artifact === 'onboarding-flow');
  assert.equal(made.name, 'Onboarding flow');
  assert.equal(made.state, 'unproposed');
  assert.equal(made.branch, 'artifact/onboarding-flow');
});

test('an artifact design is edited, proposed and approved in its own folder', async () => {
  const base = '/api/projects/plain/artifacts/onboarding-flow/design';
  const head = (await gitText(plain, ['rev-parse', 'artifact/onboarding-flow'])).trim();
  const board = await json(
    await api(`${base}/canvas`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'board',
        ref: 'artifact/onboarding-flow',
        expect: head,
        x: 0,
        y: 0,
      }),
    }),
  );
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.branch, 'artifact/onboarding-flow');
  const files = await gitText(plain, ['ls-tree', '-r', '--name-only', 'artifact/onboarding-flow']);
  assert.match(files, /artifacts\/onboarding-flow\/boards\/Board1\.html/);
  assert.doesNotMatch(files, /^design\//m);
  // The board's design system comes from the project's design/ds, served beside the board.
  const commit = board.body.commit;
  assert.equal((await api(`${base}/files/${commit}/boards/Board1.html`)).status, 200);
  // Comments stay with the design they were made on.
  await api(`${base}/comments`, {
    method: 'POST',
    body: JSON.stringify({ board: 'Board1.html', text: 'Start here' }),
  });
  assert.equal((await json(await api(`${base}/comments`))).body.comments.length, 1);
  assert.equal(
    (await json(await api('/api/projects/plain/design/comments'))).body.comments.length,
    0,
  );
  const proposed = await json(
    await api(`${base}/propose`, {
      method: 'POST',
      body: JSON.stringify({
        ref: 'artifact/onboarding-flow',
        title: 'Onboarding flow',
        summary: 'A first board for onboarding.',
      }),
    }),
  );
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const item = proposed.body.item;
  const review = await json(
    await api(
      `/api/projects/plain/design/review?item=${encodeURIComponent(item.id)}&evidence=text`,
    ),
  );
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.api, base);
  assert.deepEqual(
    review.body.boards.map((entry: any) => entry.file),
    ['Board1.html'],
  );
  const listed = (await json(await api('/api/artifacts'))).body.artifacts.find(
    (entry: any) => entry.artifact === 'onboarding-flow',
  );
  assert.equal(listed.state, 'review');
  assert.equal((await json(await api(`${base}/proposals`))).body.proposals.length, 1);
  assert.equal(
    (await json(await api('/api/projects/plain/design/proposals'))).body.proposals.length,
    0,
  );
  await answerInboxAsync('alice', item.id, { actionId: 'approve', on: 'web' });
  const onMain = await gitText(plain, ['ls-tree', '-r', '--name-only', 'main', 'artifacts/']);
  assert.match(onMain, /artifacts\/onboarding-flow\/canvas\.json/);
  assert.match(onMain, /artifacts\/onboarding-flow\/boards\/Board1\.html/);
  const approved = (await json(await api('/api/artifacts'))).body.artifacts.find(
    (entry: any) => entry.artifact === 'onboarding-flow',
  );
  assert.equal(approved.branch, null);
  assert.equal(approved.boards, 1);
});

test('a document is created, edited on its branch as you type, and proposed', async () => {
  const created = await json(
    await api('/api/artifacts', {
      method: 'POST',
      body: JSON.stringify({ kind: 'document', name: 'One server plan', project: 'site' }),
    }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = '/api/projects/site/artifacts/one-server-plan/document';
  const opened = await json(await api(path));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.title, 'One server plan');
  assert.equal(opened.body.branch, 'artifact/one-server-plan');
  assert.equal(opened.body.main, null);
  const saved = await json(
    await api(path, {
      method: 'PUT',
      body: JSON.stringify({
        branch: 'artifact/one-server-plan',
        expect: opened.body.commit,
        text: '# One server plan\n\ndeploy.local runs as one server process.\n',
      }),
    }),
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // Saving against an old commit is refused rather than losing the newer text.
  const stale = await api(path, {
    method: 'PUT',
    body: JSON.stringify({
      branch: 'artifact/one-server-plan',
      expect: opened.body.commit,
      text: 'x',
    }),
  });
  assert.equal(stale.status, 409);
  const read = await json(await api(path));
  assert.match(read.body.text, /one server process/);
  // Making the document is not an edit; the one save is.
  assert.equal(read.body.edits, 1);
  const proposed = await json(
    await api('/api/projects/site/artifacts/one-server-plan/design/propose', {
      method: 'POST',
      body: JSON.stringify({
        ref: 'artifact/one-server-plan',
        title: 'One server plan',
        summary: 'How deploy.local becomes one process.',
      }),
    }),
  );
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  assert.equal((await json(await api(path))).body.review.id, proposed.body.item.id);
  await answerInboxAsync('alice', proposed.body.item.id, { actionId: 'approve', on: 'web' });
  const onMain = await gitText(repo, ['show', 'main:artifacts/one-server-plan/document.md']);
  assert.match(onMain, /one server process/);
  // Editing a document on main starts a branch for it.
  const main = await json(await api(path));
  assert.equal(main.body.branch, null);
  const edit = await json(
    await api(path, {
      method: 'PUT',
      body: JSON.stringify({ text: '# One server plan\n\nChanged.\n' }),
    }),
  );
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.match(edit.body.branch, /^artifact\/one-server-plan/);
  assert.notEqual(edit.body.branch, null);
  const listed = (await json(await api('/api/artifacts'))).body.artifacts.find(
    (entry: any) => entry.artifact === 'one-server-plan',
  );
  assert.equal(listed.kind, 'document');
  assert.equal(listed.state, 'unproposed');
});

test('artifact names are checked', async () => {
  for (const body of [
    { kind: 'sheet', name: 'Plan', project: 'site' },
    { kind: 'design', name: '  ', project: 'site' },
    { kind: 'design', name: '!!!', project: 'site' },
  ])
    assert.equal(
      (await api('/api/artifacts', { method: 'POST', body: JSON.stringify(body) })).status,
      400,
    );
  assert.equal((await api('/api/projects/site/artifacts/Bad_Name/document')).status, 404);
  assert.equal((await api('/api/projects/site/artifacts/missing/document')).status, 404);
});
