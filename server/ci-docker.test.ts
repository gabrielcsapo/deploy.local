import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';

// Opt-in: creates only uniquely named disposable containers, images and a temp DB.
test(
  'real Docker rebuilds unchanged graph from new source, retries once and fences failed activation',
  { skip: process.env.CI_DOCKER_TEST !== '1', timeout: 180000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-real-docker-'));
    const app = 'ci-docker-' + Date.now();
    const child = spawn(process.execPath, ['server/ci-test-fixture.mjs'], {
      env: { ...process.env, DEPLOY_DATA_DIR: root, CI_REAL_DOCKER: '1', CI_FIXTURE_APP: app },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let logs = '';
    child.stdout!.on('data', (b) => (logs += b));
    child.stderr!.on('data', (b) => (logs += b));
    const ids = new Set<string>();
    let imagePrefix = '';
    try {
      const info: any = await new Promise((r, j) => {
        child.once('message', r);
        child.once('exit', () => j(Error(logs)));
      });
      const url = 'http://127.0.0.1:' + info.port;
      const owner = { 'x-deploy-username': 'ci-owner', 'x-deploy-token': info.ownerToken };
      const request = async (path: string, options: RequestInit = {}) => {
        const r = await fetch(url + path, options);
        const body = await r.json();
        return { status: r.status, body };
      };
      const archive = async (version: string, fail = false) => {
        const tar = pack();
        tar.entry({ name: 'deploy.yaml' }, info.manifest);
        tar.entry(
          { name: 'Dockerfile' },
          fail
            ? 'FROM busybox:1.37\nCMD ["sh","-c","exit 1"]\n'
            : 'FROM busybox:1.37\nWORKDIR /www\nCOPY health index.html /www/\nEXPOSE 3000\nCMD ["httpd","-f","-p","3000"]\n',
        );
        tar.entry({ name: 'health' }, 'ok');
        tar.entry({ name: 'index.html' }, version);
        tar.finalize();
        const chunks: Buffer[] = [];
        for await (const b of tar) chunks.push(b);
        const raw = Buffer.concat(chunks);
        return { raw, gzip: gzipSync(raw) };
      };
      const upload = async (
        path: string,
        bundle: { gzip: Buffer },
        headers: Record<string, string>,
        detached = false,
      ) => {
        const form = new FormData();
        form.set('name', app);
        if (detached) form.set('detached', '1');
        form.set('file', new Blob([new Uint8Array(bundle.gzip)]), 'source.tar.gz');
        return request(path, { method: 'POST', headers, body: form });
      };
      const initial = await upload('/api/upload', await archive('original'), owner);
      if (initial.body.containerId) ids.add(initial.body.containerId);
      assert.equal(initial.status, 201, JSON.stringify(initial.body) + ' ' + logs.slice(-3000));
      const before = await request('/api/deployments/' + app, { headers: owner });
      const beforeD = before.body.deployment || before.body;
      ids.add(beforeD.containerId);
      imagePrefix = 'deploy-sh-' + beforeD.appId + '-';
      const originalImage = JSON.parse(
        execFileSync('docker', ['inspect', beforeD.containerId], { encoding: 'utf8' }),
      )[0].Image;
      const issued = await request('/api/ci/credentials', {
        method: 'POST',
        headers: { ...owner, 'Content-Type': 'application/json' },
        body: JSON.stringify({ application: app, ttlSeconds: 3600 }),
      });
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
      const ci = { 'x-deploy-ci-token': issued.body.token };
      const head = (await request('/api/ci/releases/head', { headers: ci })).body;
      const bundle = await archive('new-source');
      const digest = (b: Buffer) => 'sha256:' + createHash('sha256').update(b).digest('hex');
      const input = {
        application: app,
        sourceCommit: 'a'.repeat(40),
        sourceDigest: digest(bundle.gzip),
        sourceArchiveDigest: digest(bundle.raw),
        expectedRelease: head.releaseId,
        idempotencyKey: 'real-source-update',
      };
      const reserve = await request('/api/ci/releases', {
        method: 'POST',
        headers: { ...ci, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(reserve.status, 202, JSON.stringify(reserve.body));
      const release = reserve.body.releaseId;
      assert.equal(
        (await upload('/api/ci/releases/' + release + '/upload', bundle, ci, true)).status,
        202,
      );
      const wait = async (id: string) => {
        for (let n = 0; n < 120; n++) {
          const r = (await request('/api/ci/releases/' + id, { headers: ci })).body;
          if (['healthy', 'failed'].includes(r.status)) return r;
          await new Promise((r) => setTimeout(r, 500));
        }
        throw Error('Timeout ' + logs.slice(-5000));
      };
      const healthy = await wait(release);
      assert.equal(healthy.status, 'healthy', JSON.stringify(healthy) + ' ' + logs.slice(-5000));
      ids.add(healthy.containerId);
      assert.notEqual(healthy.containerId, beforeD.containerId);
      assert.notEqual(healthy.imageDigest, originalImage);
      const after = (await request('/api/deployments/' + app, { headers: owner })).body;
      const afterD = after.deployment || after;
      assert.equal(await (await fetch('http://127.0.0.1:' + afterD.port)).text(), 'new-source');
      assert.equal(afterD.activeSpecDigest, beforeD.activeSpecDigest);
      const retry = await request('/api/ci/releases', {
        method: 'POST',
        headers: { ...ci, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(retry.body.releaseId, release);
      assert.equal(retry.body.containerId, healthy.containerId);
      const bad = await archive('failed', true);
      const badInput = {
        ...input,
        sourceCommit: 'b'.repeat(40),
        sourceDigest: digest(bad.gzip),
        sourceArchiveDigest: digest(bad.raw),
        expectedRelease: release,
        idempotencyKey: 'failed-activation',
      };
      const failure = await request('/api/ci/releases', {
        method: 'POST',
        headers: { ...ci, 'Content-Type': 'application/json' },
        body: JSON.stringify(badInput),
      });
      assert.equal(failure.status, 202, JSON.stringify(failure.body));
      await upload('/api/ci/releases/' + failure.body.releaseId + '/upload', bad, ci, true);
      const failed = await wait(failure.body.releaseId);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.requiresOwnerRecovery, true);
      assert.equal(
        (
          await request('/api/deployments/' + app, {
            method: 'PATCH',
            headers: { ...owner, 'Content-Type': 'application/json' },
            body: JSON.stringify({ memoryLimit: '1g' }),
          })
        ).status,
        409,
      );
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
      // Bound cleanup to the unique app label/name and discovered app image prefix.
      const rows = execFileSync('docker', ['ps', '-a', '--format', '{{.ID}} {{.Names}}'], {
        encoding: 'utf8',
      }).split('\n');
      for (const row of rows) {
        const [id, name] = row.split(' ');
        if (name?.includes(app) || (imagePrefix && name?.startsWith(imagePrefix))) ids.add(id);
      }
      // App graph names use app IDs; only remove explicitly recorded IDs otherwise.
      for (const id of ids)
        if (id)
          try {
            execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
          } catch {}
      if (imagePrefix) {
        const images = execFileSync(
          'docker',
          ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'],
          { encoding: 'utf8' },
        ).split('\n');
        for (const image of images)
          if (image.startsWith(imagePrefix))
            try {
              execFileSync('docker', ['image', 'rm', '-f', image], { stdio: 'ignore' });
            } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
