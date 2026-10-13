import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const execute = promisify(execFile);
const manifest =
  'apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: groffee\ncomponents:\n  web:\n    build:\n      context: .\n    interfaces:\n      http:\n        port: 3000\n        protocol: http\n';

test(
  'authenticated legacy API admits only owner/admin, binds preflight, requires acknowledgements and protects ordinary upload',
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-api-fixture-'));
    const source = join(root, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(source, 'deploy.yaml'), manifest);
    const archive = join(root, 'source.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, 'Dockerfile', 'deploy.yaml']);
    const driver = join(root, 'driver.mjs');
    const storeURL = new URL('./store.ts', import.meta.url).href;
    const apiURL = new URL('./api.ts', import.meta.url).href;
    const serviceURL = new URL('./legacy-update-service.ts', import.meta.url).href;
    writeFileSync(
      driver,
      `import {createServer} from 'node:http';import * as store from ${JSON.stringify(storeURL)};import {apiMiddleware} from ${JSON.stringify(apiURL)};import {legacyUpdateService} from ${JSON.stringify(serviceURL)};
const owner=store.registerUser('fixture-owner','synthetic-only-password');const member=store.registerUser('fixture-member','synthetic-only-password');store.ensureCoordinatorNode();store.setDefaultNode('coordinator');
const row={name:'groffee',username:'fixture-owner',type:'docker',port:39001,containerId:'fixture-old',containerName:'deploy-sh-groffee',directory:${JSON.stringify(source)},activeNodeId:'coordinator',desiredNodeId:'coordinator'};store.saveDeployment(row);store.updateDeploymentStatus('groffee','running');
const calls={updates:0,active:0,max:0,recover:[]};
const handler=apiMiddleware({legacyUpdateService:(...args)=>{const service=legacyUpdateService(...args);service.status=()=>({supported:true,locked:false,phase:null,releaseId:null,imageId:null,rollbackImageId:null});service.preflight=async()=>({});service.update=async()=>{calls.updates++;calls.active++;calls.max=Math.max(calls.max,calls.active);await new Promise(done=>setTimeout(done,100));calls.active--;return{unchanged:false,releaseId:'fixture',snapshot:'verified',imageId:'sha256:'+ 'b'.repeat(64)}};service.recover=async(rollback)=>{calls.recover.push(rollback);return{recovered:true,rolledBack:rollback,releaseId:'fixture'}};return service;}});
const server=createServer(async(req,res)=>{if(req.url==='/fixture/member-owner'){store.saveDeployment({...row,username:'fixture-member'});res.end('ok');return;}if(req.url==='/fixture/admin-owner'){store.saveDeployment(row);res.end('ok');return;}if(req.url==='/fixture/calls'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(calls));return;}handler(req,res,()=>{res.writeHead(404);res.end()});});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,owner:owner.token,member:member.token})));`,
    );
    const child = spawn(process.execPath, [driver], {
      env: { ...process.env, DEPLOY_DATA_DIR: join(root, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => (stderr += chunk.toString()));
    try {
      const connection = await new Promise<{ port: number; owner: string; member: string }>(
        (done, fail) => {
          let output = '';
          const timer = setTimeout(
            () => fail(new Error('Fixture API startup failed: ' + stderr)),
            10_000,
          );
          child.stdout!.on('data', (chunk) => {
            output += chunk.toString();
            for (const line of output.split('\n')) {
              try {
                const value = JSON.parse(line);
                if (value.port) {
                  clearTimeout(timer);
                  done(value);
                  return;
                }
              } catch {}
            }
          });
          child.once('exit', () => {
            clearTimeout(timer);
            fail(new Error('Fixture API exited: ' + stderr));
          });
        },
      );
      const origin = `http://127.0.0.1:${connection.port}`;
      const auth = (member = false) => ({
        'x-deploy-username': member ? 'fixture-member' : 'fixture-owner',
        'x-deploy-token': member ? connection.member : connection.owner,
      });
      const request = (path: string, options: RequestInit = {}) => fetch(origin + path, options);
      const capability = '/api/deployments/groffee/legacy-update';
      assert.equal((await request(capability)).status, 401);
      assert.equal((await request(capability, { headers: auth(true) })).status, 404);
      assert.equal(
        (
          await request('/api/deployments/groffee/application-apply', {
            method: 'POST',
            headers: auth(),
            body: '{}',
          })
        ).status,
        409,
      );
      const admitted = await request(capability, { headers: auth() });
      assert.equal(admitted.status, 200);
      assert.equal((await admitted.json()).supported, true);
      await request('/fixture/member-owner');
      assert.equal((await request(capability, { headers: auth(true) })).status, 403);
      await request('/fixture/admin-owner');
      const upload = (changes: Record<string, string> = {}) => {
        const form = new FormData();
        for (const [key, value] of Object.entries({
          name: 'groffee',
          legacyCodeUpdate: '1',
          confirmDowntime: '1',
          legacyExpectedContainerId: 'fixture-old',
          legacyExpectedDesiredDigest: 'none',
          ...changes,
        }))
          if (value) form.append(key, value);
        form.append('file', new Blob([readFileSync(archive)]), 'source.tar.gz');
        return request('/api/upload', { method: 'POST', headers: auth(), body: form });
      };
      assert.equal((await upload({ confirmDowntime: '' })).status, 409);
      assert.equal((await upload({ legacyExpectedContainerId: 'stale' })).status, 409);
      assert.equal(
        (await upload({ legacyExpectedDesiredDigest: 'sha256:' + 'c'.repeat(64) })).status,
        409,
      );
      const results = await Promise.all([upload(), upload()]);
      assert.ok(results.every((response) => response.ok));
      const calls = await (await request('/fixture/calls')).json();
      assert.equal(calls.updates, 2);
      assert.equal(calls.max, 1);
      const post = (action: string, body: Record<string, unknown>) =>
        request(capability + '/' + action, {
          method: 'POST',
          headers: { ...auth(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      assert.equal((await post('recover', {})).status, 409);
      assert.equal((await post('rollback', { confirmDowntime: true })).status, 409);
      assert.equal((await post('recover', { confirmDowntime: true })).status, 200);
      assert.equal(
        (await post('rollback', { confirmDowntime: true, confirmDataLoss: true })).status,
        200,
      );
      const recovery = join(root, 'data', 'legacy-updates', 'groffee');
      mkdirSync(recovery, { recursive: true });
      writeFileSync(join(recovery, 'journal.json'), '{}');
      assert.equal((await upload({ legacyCodeUpdate: '' })).status, 409);
      assert.equal(
        (await request('/api/deployments/groffee/restart', { method: 'POST', headers: auth() }))
          .status,
        409,
      );
      assert.equal(
        (await request('/api/deployments/groffee', { method: 'DELETE', headers: auth() })).status,
        409,
      );
      assert.equal(
        (
          await request('/api/deployments/GROFFEE/application-spec', {
            method: 'PUT',
            headers: auth(),
            body: '{}',
          })
        ).status,
        409,
      );
      // Protection precedes manifest parsing, including an old deploy.json archive.
      rmSync(join(source, 'deploy.yaml'));
      writeFileSync(join(source, 'deploy.json'), '{}');
      execFileSync('tar', ['-czf', archive, '-C', source, 'Dockerfile', 'deploy.json']);
      assert.equal((await upload({ legacyCodeUpdate: '' })).status, 409);
      assert.deepEqual((await (await request('/fixture/calls')).json()).recover, [false, true]);
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((done) => child.once('exit', done));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'legacy CLI fails closed on old controllers and transports exact preflight/acknowledgements with isolated credentials',
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-cli-fixture-'));
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(
      join(home, '.deployrc'),
      JSON.stringify({ username: 'fixture-owner', token: 'synthetic-token' }),
      { mode: 0o600 },
    );
    writeFileSync(join(root, 'deploy.yaml'), manifest);
    writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n');
    let supported = false;
    let upload = '';
    let recoveryBody: Record<string, unknown> = {};
    let recoveryCount = 0;
    let schemaCalls = 0;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-deploy-token'] !== 'synthetic-token') {
        res.writeHead(401);
        res.end('{}');
        return;
      }
      if (req.url === '/api/deploy-admission') {
        res.end(JSON.stringify({ placementReady: true }));
        return;
      }
      if (req.url === '/api/deploy-admission/groffee') {
        res.end('{}');
        return;
      }
      if (req.url === '/api/deployments/groffee/legacy-update' && req.method === 'GET') {
        if (!supported) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'unsupported' }));
          return;
        }
        res.end(
          JSON.stringify({
            supported: true,
            locked: false,
            containerId: 'fixture-old',
            desiredDigest: 'none',
          }),
        );
        return;
      }
      if (req.url?.includes('/application-')) {
        schemaCalls++;
        res.writeHead(500);
        res.end('{}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (req.url === '/api/upload') {
          upload = body;
          res.end(
            JSON.stringify({ legacyCodeUpdate: true, name: 'groffee', imageId: 'synthetic' }),
          );
        } else if (req.url?.endsWith('/rollback')) {
          recoveryBody = JSON.parse(body);
          recoveryCount++;
          res.end(JSON.stringify({ rolledBack: true }));
        } else {
          res.writeHead(404);
          res.end('{}');
        }
      });
    });
    server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const url = `http://127.0.0.1:${address.port}`;
    const run = (...args: string[]) =>
      execute(
        process.execPath,
        [resolve('bin/deploy.js'), 'legacy', ...args, '-a', 'groffee', '--url', url],
        { cwd: root, env: { ...process.env, HOME: home }, timeout: 15_000 },
      );
    try {
      await assert.rejects(run('update', '--confirm-downtime'), /404/);
      assert.equal(upload, '');
      supported = true;
      await assert.rejects(run('update'), /confirm-downtime/);
      await run('update', '--confirm-downtime');
      for (const field of [
        'legacyCodeUpdate',
        'legacyExpectedContainerId',
        'legacyExpectedDesiredDigest',
        'confirmDowntime',
      ])
        assert.ok(upload.includes(`name="${field}"`));
      assert.ok(upload.includes('fixture-old'));
      assert.equal(schemaCalls, 0);
      await assert.rejects(run('rollback', '--confirm-downtime'), /confirm-data-loss/);
      assert.equal(recoveryCount, 0);
      await run('rollback', '--confirm-downtime', '--confirm-data-loss');
      assert.deepEqual(recoveryBody, { confirmDowntime: true, confirmDataLoss: true });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
