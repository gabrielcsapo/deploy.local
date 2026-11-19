import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import test, { type TestContext } from 'node:test';
import { openDatabase } from '../../kernel/db/index.ts';
import { openIndex, readStatus } from './database.ts';
import { indexProject } from './index-project.ts';
import { fileLimit } from './model.ts';
import { queryIndex } from './queries.ts';
import type { IndexWork } from './worker.ts';

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function fixtures(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-index-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace.db');
  const database = join(root, 'code-index.db');
  const catalog = openDatabase(workspace);
  catalog.exec('CREATE TABLE records (kind TEXT, id TEXT, owner TEXT, data TEXT)');
  t.after(() => catalog.close());
  const work = (id: string, owner = 'alex'): IndexWork => ({
    database,
    workspace,
    owner,
    project: id,
  });
  const query = async (name: string, args: Record<string, unknown>, owner = 'alex'): Promise<any> =>
    (await queryIndex({ ...work('', owner), name: 'deploy_code_' + name, args })).result;
  function project(id: string, name: string, initial: Record<string, string>, owner = 'alex') {
    const checkout = join(root, id + '-checkout');
    const repositoryPath = join(root, id + '.git');
    mkdirSync(checkout);
    git(checkout, 'init', '-b', 'main');
    git(checkout, 'config', 'user.name', 'Test');
    git(checkout, 'config', 'user.email', 'test@example.test');
    function commit(files: Record<string, string | null>) {
      for (const [file, text] of Object.entries(files)) {
        const target = join(checkout, file);
        mkdirSync(dirname(target), { recursive: true });
        if (text === null) rmSync(target);
        else writeFileSync(target, text);
      }
      git(checkout, 'add', '-A');
      git(checkout, 'commit', '-m', 'Update sources');
      if (files !== initial) git(checkout, 'push', repositoryPath, 'main');
      return git(checkout, 'rev-parse', 'HEAD');
    }
    const first = commit(initial);
    git(root, 'clone', '--bare', checkout, repositoryPath);
    catalog
      .prepare('INSERT INTO records VALUES (?,?,?,?)')
      .run('project', id, owner, JSON.stringify({ name, defaultBranch: 'main', repositoryPath }));
    return { first, commit, work: work(id, owner) };
  }
  return { database, project, query };
}

test('bare repositories track consumer counts, aliases, unused exports, and incremental pushes', async (t) => {
  const { database, project, query } = fixtures(t);
  const router = project('router', 'react-flight-router', {
    'package.json': JSON.stringify({
      name: 'react-flight-router',
      version: '0.16.0',
      exports: { './client': './dist/client.js' },
    }),
    'README.md': '# React Flight Router\n\nSource graph fixture.',
    'src/client.ts':
      "export { prefetchRSC as prefetch } from './lib.js';\nexport * from './lib.js';",
    'src/lib.ts':
      'export function prefetchRSC(href: string) {return href;}\nexport function unused() {return 2;}',
    'notes/big.txt': 'x'.repeat(fileLimit + 1),
    'test/broken.ts': '\nexport const nope = ;\n',
  });
  const app = project('app', 'dashboard', {
    'package.json': JSON.stringify({
      dependencies: { 'react-flight-router': '^0.14.0', react: '19.2.0' },
    }),
    'pnpm-lock.yaml':
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react-flight-router:\n        specifier: ^0.14.0\n        version: 0.14.2\n",
    'a.ts':
      "import { prefetch as warm } from 'react-flight-router/client';\nexport const route = warm('/console');",
    'b.ts': "import * as router from 'react-flight-router/client';\nrouter.prefetchRSC('/home');",
    'public.ts': "import { useState } from 'react';\nuseState(false);",
  });
  await indexProject(app.work);
  assert.equal(
    (await query('project', { project: 'dashboard', section: 'uses' })).items[0].producer,
    null,
  );
  await indexProject(router.work);
  const usedBy = await query('project', { project: 'project:router', section: 'usedBy' });
  assert.equal(usedBy.items[0].consumer.name, 'dashboard');
  assert.equal(usedBy.items[0].places, 4);
  assert.equal(usedBy.items[0].files, 2);
  assert.deepEqual(usedBy.items[0].mostly, ['prefetch', 'prefetchRSC']);
  assert.deepEqual(usedBy.items[0].versions, ['0.14.2']);
  assert.equal(usedBy.items[0].latest, '0.16.0');
  assert.equal(usedBy.items[0].freshness, 'behind');
  const uses = await query('project', { project: 'dashboard', section: 'uses' });
  assert.deepEqual(
    uses.items.map(({ name, places, producer }: any) => [name, places, producer]),
    [
      ['react-flight-router', 4, 'project:router'],
      ['react', 2, null],
    ],
  );
  const unused = await query('project', { project: 'project:router', section: 'unreferenced' });
  assert.ok(unused.items.some(({ name }: any) => name === 'unused'));
  const skipped = (await query('project', { project: 'project:router', section: 'skipped' })).items;
  assert.match(skipped[0].reason, /1 MB/);
  assert.equal(skipped[1].errorLine, 2);
  const summary = await query('project', { project: 'project:router' });
  assert.equal(summary.status.commit, router.first);
  assert.equal(summary.status.freshness, 'current');
  assert.equal(summary.sections.usedBy.count, 1);
  assert.equal(summary.sections.entries.count, 1);
  assert.ok(summary.sections.files.count > 0);

  const fuzzy = await query('find', { query: 'react-flight-server' });
  assert.equal(fuzzy.items[0].name, 'react-flight-router');
  assert.ok(fuzzy.items.some(({ type }: any) => type === 'project'));
  const matching = await query('find', { query: 'prefetchRSC' });
  const handle = matching.items[0].handle;
  const symbol = await query('symbol', { handle });
  assert.equal(symbol.definition.name, 'prefetchRSC');
  assert.equal(symbol.usage.projects, 2);
  assert.ok(symbol.usage.confidence.some(({ confidence }: any) => confidence === 'module'));
  const first = await query('symbol', { handle, section: 'references', limit: 1 });
  const second = await query('symbol', {
    handle,
    section: 'references',
    cursor: first.nextCursor,
    limit: 1,
  });
  assert.notDeepEqual(first.items, second.items);
  assert.ok(first.items[0].snippet);
  await assert.rejects(
    query('symbol', { handle, section: 'references', cursor: 'invalid' }),
    /cursor/,
  );
  const search = await query('search', { query: 'prefetchRSC', limit: 10, context: 1 });
  assert.equal(search.items[0].definition, handle);
  assert.ok(search.items.some(({ path, line }: any) => path === 'a.ts' && line === 2));
  assert.ok(search.items[0].context.length > 1);

  const repo = openIndex(database, true);
  t.after(() => repo.close());
  const fileRows = () =>
    repo
      .prepare(
        "SELECT id,path,oid,data FROM code_files WHERE owner='alex' AND project='app' ORDER BY path",
      )
      .all() as { path: string }[];
  const original = fileRows();
  const commit = app.commit({
    'a.ts':
      "import { prefetch as warm } from 'react-flight-router/client';\nexport const route = warm('/updated');",
    'public.ts': null,
  });
  assert.equal((await query('project', { project: 'dashboard' })).status.freshness, 'stale');
  assert.equal((await indexProject(app.work)).extractedFiles, 1);
  assert.equal(readStatus(repo, 'alex', 'app')?.commit, commit);
  assert.deepEqual(
    fileRows().filter(({ path }) => !['a.ts', 'public.ts'].includes(path)),
    original.filter(({ path }) => !['a.ts', 'public.ts'].includes(path)),
  );
  assert.ok(!fileRows().some(({ path }) => path === 'public.ts'));
  assert.match((await query('search', { query: '/updated' })).items[0].snippet, /updated/);
  assert.equal((await query('search', { query: 'useState' })).matches, 0);
});

test('Rust connects Cargo lock versions, pub use and nested module symbols by path', async (t) => {
  const { project, query } = fixtures(t);
  const producer = project('core', 'rust-core', {
    'Cargo.toml': '[package]\nname = "rust-core"\nversion = "2.1.0"\n',
    'src/lib.rs': 'pub mod service; pub use service::serve as start;',
    'src/service.rs': 'pub fn serve() {}\npub fn unused() {}',
  });
  const consumer = project('tools', 'cli-tools', {
    'Cargo.toml':
      '[package]\nname = "cli-tools"\nversion = "1.0.0"\n[dependencies]\ncore = {package = "rust-core", version = "^2"}\n',
    'Cargo.lock':
      'version = 3\n[[package]]\nname = "rust-core"\nversion = "2.0.0"\nsource = "registry+https://example.test"\n',
    'src/main.rs': 'use core::start as run;\nfn main() { run(); core::service::serve(); }\n',
  });
  await indexProject(producer.work);
  await indexProject(consumer.work);
  const usedBy = await query('project', { project: 'project:core', section: 'usedBy' });
  assert.deepEqual(usedBy.items[0].versions, ['2.0.0']);
  assert.equal(usedBy.items[0].places, 3);
  const result = await query('find', { query: 'serve' });
  const symbol = await query('symbol', {
    handle: result.items.find((item: any) => item.type === 'symbol').handle,
  });
  assert.deepEqual(symbol.usage.confidence, [{ confidence: 'path', places: 4 }]);
});

test('interrupted indexing resumes staged work while readers see the last complete snapshot', async (t) => {
  const { database, project, query } = fixtures(t);
  const app = project('app', 'app', { 'start.ts': 'export const original = 1;' });
  await indexProject(app.work);
  const current = app.commit(
    Object.fromEntries([
      ['start.ts', 'export const replacement = 2;'],
      ...Array.from({ length: 160 }, (_, index) => [
        `src/file${index.toString().padStart(3, '0')}.ts`,
        `export const value${index} = ${index};\n`,
      ]),
    ]),
  );
  const thread = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: { ...app.work, kind: 'index' },
    execArgv: [],
  });
  t.after(() => thread.terminate());
  const reader = openIndex(database, true);
  t.after(() => reader.close());
  const staged = reader.prepare('SELECT COUNT(*) count FROM code_staged_files').pluck();
  for (let i = 0; i < 200 && !staged.get(); i++) await pause(10);
  assert.ok(staged.get());
  await thread.terminate();
  assert.equal(readStatus(reader, 'alex', 'app')?.commit, app.first);
  assert.equal((await query('find', { query: 'replacement' })).matches, 0);
  assert.equal((await query('find', { query: 'original' })).matches, 1);
  const done = await indexProject(app.work);
  assert.ok(done.resumedFiles);
  assert.ok(done.extractedFiles! < 161);
  assert.equal(readStatus(reader, 'alex', 'app')?.commit, current);
  assert.equal((await query('find', { query: 'original' })).matches, 0);
  assert.equal((await query('find', { query: 'replacement' })).matches, 1);
});

test('tool results are bounded, owner-scoped and searchable during backfill', async (t) => {
  const { project, query } = fixtures(t);
  const other = project(
    'private',
    'private-owner-project',
    {
      'package.json': '{"name":"private-owner-package","version":"1.0.0"}',
      'index.ts': 'export const restricted = "only-other-owner";',
    },
    'blair',
  );
  const mine = project('app', 'my-project', {
    'README.md': '# Shared words\n\nA backfill searchable phrase.',
    'index.ts': Array.from(
      { length: 100 },
      (_, i) =>
        `/** ${'𝄞'.repeat(400)} */\nexport function veryLongSymbol${i}() {return "${'x'.repeat(800)}";}`,
    ).join('\n'),
  });
  await indexProject(other.work);
  const secret = (await query('find', { query: 'restricted' }, 'blair')).items[0];
  assert.equal((await query('find', { query: 'restricted', owner: 'blair' })).matches, 0);
  await assert.rejects(query('symbol', { handle: secret.handle }), /not found/);
  await assert.rejects(query('project', { project: 'project:private' }), /not found/);
  assert.equal((await query('search', { query: 'only-other-owner' })).matches, 0);
  const pending = await query('project', { project: 'project:app' });
  assert.equal(pending.status.freshness, 'pending');
  const fallback = await query('search', { query: 'backfill searchable' });
  assert.equal(fallback.items[0].source, 'git grep');
  await indexProject(mine.work);
  const matches = await query('find', { query: 'veryLongSymbol' });
  assert.equal(matches.items.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(matches)) < 6 * 1024);
  const wide = await query('find', { query: 'veryLongSymbol', limit: 500 });
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= 12 * 1024);
  assert.ok(wide.nextCursor);
  const next = await query('find', { query: 'veryLongSymbol', cursor: wide.nextCursor });
  assert.ok(next.items.length);
  assert.ok(!wide.items.some(({ handle }: any) => handle === next.items[0].handle));
});

test('library pushes resolve consumers again through ESM namespaces and CommonJS aliases', async (t) => {
  const { project, query } = fixtures(t);
  const producer = project('library', 'library', {
    'package.json': '{"name":"library","exports":"./main.js"}',
    'main.ts':
      'export * as tools from "./utility.cjs"; export namespace Local { export const count = 1; }',
    'utility.cjs': 'exports.format = (value) => value;',
  });
  const consumer = project('client', 'client', {
    'package.json': '{"dependencies":{"library":"^1.0.0"}}',
    'index.ts': 'import { tools, Local } from "library"; tools.format(Local.count);',
  });
  await indexProject(producer.work);
  await indexProject(consumer.work);
  const symbol = async (name: string) => {
    const { items } = await query('find', { query: name });
    return query('symbol', { handle: items.find((item: any) => item.name === name).handle });
  };
  assert.equal((await symbol('format')).usage.places, 1);
  assert.equal((await symbol('count')).usage.places, 1);
  producer.commit({ 'utility.cjs': 'exports.format = (value) => value + " world";' });
  assert.equal((await indexProject(producer.work)).extractedFiles, 1);
  assert.equal((await symbol('format')).usage.places, 1);
  assert.equal((await symbol('count')).usage.places, 1);
  producer.commit({ 'utility.cjs': 'exports.unrelated = (value) => value;' });
  await indexProject(producer.work);
  assert.equal((await query('find', { query: 'format' })).matches, 0);
  assert.equal((await symbol('unrelated')).usage.places, 0);
});
