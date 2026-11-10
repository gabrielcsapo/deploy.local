import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
function launch(root: string) {
  return new Promise<any>((done, reject) => {
    const child = spawn(process.execPath, ['server/ci-test-fixture.mjs'], {
      env: { ...process.env, DEPLOY_DATA_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let log = '';
    child.stderr!.on('data', (b) => (log += b));
    child.stdout!.on('data', () => {});
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Fixture startup timeout ' + log.slice(-1000)));
    }, 15000);
    child.once('message', (info) => {
      clearTimeout(timer);
      done({ child, ...(info as object) });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error('Fixture exited ' + code + ' ' + log.slice(-1000)));
    });
  });
}
async function archive(source: string) {
  const tar = pack();
  tar.entry({ name: 'deploy.yaml' }, source);
  tar.entry({ name: 'Dockerfile' }, 'FROM scratch\n');
  tar.finalize();
  const chunks = [];
  for await (const b of tar) chunks.push(b);
  const raw = Buffer.concat(chunks);
  return { raw, gzip: gzipSync(raw) };
}
test(
  'real HTTP boundary enforces app/credential scope, exact archive bytes, mutation fence and verified owner cancellation',
  { timeout: 30000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-api-boundary-'));
    let fixture: any;
    try {
      fixture = await launch(root);
      const url = 'http://127.0.0.1:' + fixture.port;
      const owner = { 'x-deploy-username': 'ci-owner', 'x-deploy-token': fixture.ownerToken };
      const request = async (path: string, options: RequestInit = {}) => {
        const r = await fetch(url + path, options);
        return { status: r.status, body: await r.json() };
      };
      for (const path of [
        '/api/suitcases/pairing',
        '/api/suitcases/pair',
        '/api/suitcases/sync/exchange',
        '/api/fleet/pairings',
        '/api/fleet/release-candidates/example/promote',
      ]) {
        const retired = await fetch(url + path, { method: 'POST', headers: owner, body: '{}' });
        assert.equal(retired.status, 404, path);
        await retired.body?.cancel();
      }
      const topology = await fetch(url + '/api/fleet/topology', { headers: owner });
      assert.equal(topology.status, 404);
      await topology.body?.cancel();
      const issue = await request('/api/ci/credentials', {
        method: 'POST',
        headers: { ...owner, 'Content-Type': 'application/json' },
        body: JSON.stringify({ application: fixture.app, ttlSeconds: 3600 }),
      });
      assert.equal(issue.status, 201, JSON.stringify(issue.body));
      const ci = { 'x-deploy-ci-token': issue.body.token };
      assert.equal((await request('/api/user', { headers: ci })).status, 401);
      assert.equal(
        (
          await request('/api/ci/credentials', {
            method: 'POST',
            headers: { ...ci, 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
        401,
      );
      const head = await request('/api/ci/releases/head', { headers: ci });
      assert.equal(head.status, 200);
      const bundle = await archive(fixture.manifest);
      const digest = (b: Buffer) => 'sha256:' + createHash('sha256').update(b).digest('hex');
      const input = {
        application: fixture.app,
        sourceCommit: 'b'.repeat(40),
        sourceDigest: digest(bundle.gzip),
        sourceArchiveDigest: digest(bundle.raw),
        idempotencyKey: 'fixture-request',
        expectedRelease: head.body.releaseId,
      };
      const reserve = await request('/api/ci/releases', {
        method: 'POST',
        headers: { ...ci, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(reserve.status, 202);
      const id = reserve.body.releaseId;
      assert.equal(
        (
          await request('/api/deployments/' + fixture.app, {
            method: 'PATCH',
            headers: { ...owner, 'Content-Type': 'application/json' },
            body: JSON.stringify({ memoryLimit: '1g' }),
          })
        ).status,
        409,
      );
      assert.equal(
        (await request('/api/ci/owner/releases/' + id + '/cancel', { method: 'POST', headers: ci }))
          .status,
        401,
      );
      const invalid = new FormData();
      invalid.set('name', 'another');
      invalid.set('detached', '1');
      invalid.set('file', new Blob([bundle.gzip]), 'source.tar.gz');
      const upload = await request('/api/ci/releases/' + id + '/upload', {
        method: 'POST',
        headers: ci,
        body: invalid,
      });
      assert.equal(upload.status, 403);
      const status = await request('/api/ci/releases/' + id, { headers: ci });
      assert.equal(status.body.status, 'failed');
      assert.equal(status.body.requiresOwnerRecovery, true);
      assert.equal(readFileSync(join(root, 'source', 'original.txt'), 'utf8'), 'original');
      const repeated = await request('/api/ci/releases', {
        method: 'POST',
        headers: { ...ci, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(repeated.status, 202);
      assert.equal(repeated.body.releaseId, id);
      assert.equal(repeated.body.status, 'failed');
      const cancelled = await request('/api/ci/owner/releases/' + id + '/cancel', {
        method: 'POST',
        headers: owner,
      });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, 'cancelled');
      const next = {
        ...input,
        idempotencyKey: 'wrong-tar',
        sourceArchiveDigest: 'sha256:' + '9'.repeat(64),
      };
      const r = await request('/api/ci/releases', {
        method: 'POST',
        headers: { ...ci, 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      assert.equal(r.status, 202);
      const form = new FormData();
      form.set('name', fixture.app);
      form.set('detached', '1');
      form.set('file', new Blob([bundle.gzip]), 'source.tar.gz');
      const bad = await request('/api/ci/releases/' + r.body.releaseId + '/upload', {
        method: 'POST',
        headers: ci,
        body: form,
      });
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      assert.match(bad.body.error, /archive digest/);
      assert.equal(readFileSync(join(root, 'source', 'original.txt'), 'utf8'), 'original');
      await request('/api/ci/owner/releases/' + r.body.releaseId + '/cancel', {
        method: 'POST',
        headers: owner,
      });
      // Actual executable CI command rejects unknown CA, wrong host and inherited TLS bypass.
      writeFileSync(
        join(root, '.deployrc'),
        JSON.stringify({
          url: 'https://wrong.invalid',
          username: 'wrong',
          token: 'synthetic-account-default',
        }),
      );
      const binary = process.env.CI_CLI_BINARY || join(process.cwd(), 'bin/deploy.js');
      async function cli(host: string, ca?: string, insecure = false) {
        return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: root,
            DEPLOY_AUTH_JSON: JSON.stringify({
              version: 1,
              url: host,
              username: 'ci-owner',
              token: issue.body.token,
            }),
          };
          delete env.NODE_EXTRA_CA_CERTS;
          if (ca) env.NODE_EXTRA_CA_CERTS = ca;
          if (insecure) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
          else delete env.NODE_TLS_REJECT_UNAUTHORIZED;
          const child = spawn(
            process.env.CI_CLI_BINARY ? binary : process.execPath,
            [
              ...(process.env.CI_CLI_BINARY ? [] : [binary]),
              'release',
              'head',
              '-a',
              fixture.app,
              '--json',
            ],
            { env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (b) => (stdout += b));
          child.stderr.on('data', (b) => (stderr += b));
          child.once('exit', (code) => done({ code, stdout, stderr }));
        });
      }
      const good = 'https://127.0.0.1:' + fixture.httpsPort;
      const untrusted = await cli(good);
      assert.notEqual(untrusted.code, 0);
      assert.ok(!untrusted.stderr.includes(issue.body.token));
      const trusted = await cli(good, fixture.ca);
      assert.equal(trusted.code, 0, trusted.stderr);
      assert.equal(JSON.parse(trusted.stdout).application, fixture.app);
      const bypass = await cli(good, fixture.ca, true);
      assert.notEqual(bypass.code, 0);
      assert.match(bypass.stderr, /certificate validation/);
      const wrong = await cli('https://127.0.0.2:' + fixture.httpsPort, fixture.ca);
      assert.notEqual(wrong.code, 0);
      assert.ok(!wrong.stderr.includes(issue.body.token));
    } finally {
      if (fixture) {
        fixture.child.send('stop');
        await new Promise((r) => fixture.child.once('exit', r));
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
