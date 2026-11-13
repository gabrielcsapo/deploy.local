import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const execute = promisify(execFile);

test(
  'combined CLI trusts an admitted fixture CA and rejects unknown CA and wrong hostname on .local',
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ser-tls-fixture-'));
    const cli = new URL('../bin/deploy.js', import.meta.url).pathname;
    const openssl = (...args: string[]) =>
      execFileSync('openssl', args, { cwd: root, stdio: 'ignore' });
    try {
      mkdirSync(join(root, 'home'));
      writeFileSync(
        join(root, 'home', '.deployrc'),
        JSON.stringify({ username: 'synthetic-owner', token: 'synthetic-fixture-token' }),
        { mode: 0o600 },
      );
      openssl(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-days',
        '1',
        '-subj',
        '/CN=Synthetic Test CA',
      );
      for (const [name, hostname] of [
        ['trusted', 'fixture.local'],
        ['wrong-host', 'wrong.local'],
      ]) {
        openssl(
          'req',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          name + '.key',
          '-out',
          name + '.csr',
          '-subj',
          '/CN=' + hostname,
        );
        writeFileSync(join(root, name + '.ext'), 'subjectAltName=DNS:' + hostname + '\n');
        openssl(
          'x509',
          '-req',
          '-in',
          name + '.csr',
          '-CA',
          'ca.pem',
          '-CAkey',
          'ca.key',
          '-CAcreateserial',
          '-out',
          name + '.pem',
          '-days',
          '1',
          '-extfile',
          name + '.ext',
        );
      }
      openssl(
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'unknown.key',
        '-out',
        'unknown.pem',
        '-days',
        '1',
        '-subj',
        '/CN=fixture.local',
        '-addext',
        'subjectAltName=DNS:fixture.local',
      );
      const loader = join(root, 'dns.mjs');
      writeFileSync(
        loader,
        `import dns from 'node:dns';import {syncBuiltinESMExports} from 'node:module';const original=dns.lookup;dns.lookup=(hostname,options,callback)=>{if(typeof options==='function'){callback=options;options={};}if(hostname!=='fixture.local')return original(hostname,options,callback);queueMicrotask(()=>options?.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4));};syncBuiltinESMExports();`,
      );
      for (const name of ['trusted', 'unknown', 'wrong-host']) {
        let requests = 0;
        const server = createServer(
          {
            key: readFileSync(join(root, name + '.key')),
            cert: readFileSync(join(root, name + '.pem')),
          },
          (_req, res) => {
            requests++;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ supported: true, phase: 'fixture' }));
          },
        );
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const args = ['recovery', 'list', '--url', `https://fixture.local:${address.port}`];
        const run = execute(process.execPath, ['--import', loader, cli, ...args], {
          env: {
            ...process.env,
            HOME: join(root, 'home'),
            NODE_EXTRA_CA_CERTS: join(root, 'ca.pem'),
            NODE_TLS_REJECT_UNAUTHORIZED: '1',
          },
          timeout: 10_000,
        });
        try {
          if (name === 'trusted') {
            const result = await run;
            assert.equal(JSON.parse(result.stdout).phase, 'fixture');
            assert.equal(requests, 1);
          } else {
            await assert.rejects(run);
            assert.equal(requests, 0);
          }
        } finally {
          await new Promise<void>((done) => server.close(() => done()));
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'serving route refresh invalidates cached response with identical backend and port',
  { timeout: 15_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ser-cache-fixture-'));
    const driver = join(root, 'driver.mjs');
    const routes = new URL('./edge/routes.ts', import.meta.url).href;
    const cache = new URL('./edge/response-cache.ts', import.meta.url).href;
    const mdns = new URL('./mdns.ts', import.meta.url).href;
    const databaseModule = import.meta.resolve('better-sqlite3');
    writeFileSync(
      driver,
      `import assert from 'node:assert/strict';import Database from ${JSON.stringify(databaseModule)};import {RouteTable} from ${JSON.stringify(routes)};import {putCachedResponse,getCachedResponse,purgeDeploymentCache} from ${JSON.stringify(cache)};import {unregisterHost} from ${JSON.stringify(mdns)};
const db=new Database(${JSON.stringify(join(root, 'routes.db'))});db.exec('CREATE TABLE nodes(id TEXT,address TEXT);CREATE TABLE deployments(name TEXT,port INTEGER,extra_ports TEXT,directory TEXT,app_id TEXT,active_node_id TEXT);');const name='ser-cache-fixture-'+process.pid;db.prepare('INSERT INTO deployments VALUES (?,39000,NULL,NULL,NULL,NULL)').run(name);const table=new RouteTable(${JSON.stringify(join(root, 'routes.db'))});try{table.reloadAll();const response={status:200,headers:{},body:Buffer.from('old release'),storedAt:Date.now(),expiresAt:Date.now()+60000};putCachedResponse(name+':39000:/public',response);putCachedResponse('unrelated:39001:/public',response);assert.ok(getCachedResponse(name+':39000:/public'));table.reconcile(name);assert.equal(table.getRoute(name).port,39000);assert.equal(table.getRoute(name).backendHost,'127.0.0.1');assert.equal(getCachedResponse(name+':39000:/public'),null);assert.equal(getCachedResponse('unrelated:39001:/public').body.toString(),'old release');console.log('CACHE_REGRESSION_PASS');}finally{table.close();db.close();unregisterHost(name);purgeDeploymentCache('unrelated');}process.exit(0);`,
    );
    try {
      const result = await execute(process.execPath, [driver], {
        env: {
          ...process.env,
          DEPLOY_DATA_DIR: join(root, 'data'),
          DEPLOY_MDNS_ADDRESS: '127.0.0.1',
        },
        timeout: 10_000,
      });
      assert.match(result.stdout, /CACHE_REGRESSION_PASS/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
