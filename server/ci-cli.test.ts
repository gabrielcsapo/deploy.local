import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const cliModule = await import(
  // @ts-expect-error CLI JavaScript runtime is tested directly.
  '../bin/ci-release.mjs'
);
const { ciAuth, sourceBundle, ciRequest, waitCiRelease, assertCiReceipt } = cliModule;
const token = 'ci_' + '1'.repeat(64);
const auth = { version: 1, url: 'https://deploy.local', username: 'synthetic', token };
test('noninteractive auth accepts explicit protected inputs, rejects ambiguity/unsafe files without echoing values', () => {
  const p = mkdtempSync(join(tmpdir(), 'ci-auth-'));
  try {
    const f = join(p, 'auth.json');
    writeFileSync(f, JSON.stringify(auth), { mode: 0o600 });
    assert.equal(ciAuth({ DEPLOY_AUTH_FILE: f }).token, token);
    assert.throws(
      () => ciAuth({ DEPLOY_AUTH_FILE: f, DEPLOY_AUTH_JSON: JSON.stringify(auth) }),
      /one/,
    );
    chmodSync(f, 0o644);
    assert.throws(() => ciAuth({ DEPLOY_AUTH_FILE: f }), /owner-only/);
    chmodSync(f, 0o600);
    symlinkSync(f, join(p, 'link'));
    assert.throws(() => ciAuth({ DEPLOY_AUTH_FILE: join(p, 'link') }), /regular/);
    for (const input of [
      'bad',
      JSON.stringify({ ...auth, url: 'http://deploy.local' }),
      JSON.stringify({ ...auth, url: 'https://user:password@deploy.local' }),
      JSON.stringify({ ...auth, token: 'secret-do-not-print' }),
    ])
      assert.throws(
        () => ciAuth({ DEPLOY_AUTH_JSON: input }),
        (e) => e instanceof Error && !e.message.includes('secret-do-not-print'),
      );
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
});
test('deterministic commit archive and upload digests bind byte provenance; dirty and wrong checkout rejected', () => {
  const p = mkdtempSync(join(tmpdir(), 'ci-source-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: p, encoding: 'utf8', stdio: 'pipe' });
  try {
    git('init');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid');
    writeFileSync(join(p, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(p, '.gitignore'), 'ignored\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(p, 'ignored'), 'never bundle fixture credential');
    const a = sourceBundle(commit, p);
    const b = sourceBundle(commit, p);
    assert.deepEqual(a.body, b.body);
    assert.equal(
      a.archiveDigest,
      'sha256:' + createHash('sha256').update(gunzipSync(a.body)).digest('hex'),
    );
    assert.ok(!gunzipSync(a.body).includes('never bundle fixture credential'));
    assert.throws(() => sourceBundle('a'.repeat(40), p), /exact/);
    writeFileSync(join(p, 'Dockerfile'), 'changed');
    assert.throws(() => sourceBundle(commit, p), /clean/);
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
});
test('scoped transport has strict origin, redirect and no query-token contract', async () => {
  const a = ciAuth({ DEPLOY_AUTH_JSON: JSON.stringify(auth) });
  let observed: any;
  await ciRequest(a, '/api/ci/releases/head', {}, async (u: any, o: any) => {
    observed = { u, o };
    return { ok: true, json: async () => ({ application: 'notes' }) };
  });
  assert.equal(observed.o.redirect, 'error');
  assert.equal(observed.u.search, '');
  assert.equal(observed.o.headers['x-deploy-ci-token'], token);
  await assert.rejects(
    ciRequest(a, 'https://other.invalid/api/ci/releases', {}, () => {
      throw Error('must not run');
    }),
    /Invalid scoped/,
  );
});
test('wait distinguishes actual health, failure, interruption and timeout without retrying publication', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  for (const status of ['healthy', 'failed', 'interrupted'])
    assert.equal((await waitCiRelease(auth, id, 0, async () => ({ status }))).status, status);
  const result = await waitCiRelease(auth, id, 0, async () => ({ status: 'building' }));
  assert.equal(result.waitTimedOut, true);
});

test('release receipts must bind the original intent and actual immutable runtime', () => {
  const receipt = {
    releaseId: '11111111-1111-1111-1111-111111111111',
    application: 'notes',
    sourceCommit: 'a'.repeat(40),
    status: 'healthy',
    containerId: 'actual',
    imageDigest: 'sha256:' + '1'.repeat(64),
  };
  assertCiReceipt(receipt, { application: 'notes', sourceCommit: 'a'.repeat(40) });
  assert.throws(
    () =>
      assertCiReceipt(
        { ...receipt, sourceCommit: 'b'.repeat(40) },
        { sourceCommit: receipt.sourceCommit },
      ),
    /intent/,
  );
  assert.throws(
    () => assertCiReceipt({ ...receipt, imageDigest: 'mutable:latest' }, {}),
    /immutable/,
  );
});
