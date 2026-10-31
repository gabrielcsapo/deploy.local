import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const execute = promisify(execFile);
// The CA profile needs OpenSSL 3 (strict X.509 checks, -verify_hostname). macOS ships
// LibreSSL as `openssl`, so put Homebrew's OpenSSL 3 first on PATH there, for these checks
// and for the generator they run. Without any OpenSSL 3 the tests are skipped.
const openssl3 = ['', '/opt/homebrew/opt/openssl@3/bin', '/usr/local/opt/openssl@3/bin'].find(
  (dir) => {
    try {
      return execFileSync(dir ? join(dir, 'openssl') : 'openssl', ['version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).startsWith('OpenSSL 3');
    } catch {
      return false;
    }
  },
);
if (openssl3) process.env.PATH = `${openssl3}:${process.env.PATH}`;
const needsOpenssl3 = openssl3 === undefined && 'needs OpenSSL 3 (macOS ships LibreSSL)';
const openssl = (root: string, ...args: string[]) =>
  execFileSync('openssl', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function generate(root: string) {
  const certs = new URL('./certs.ts', import.meta.url).href;
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const m=await import(${JSON.stringify(certs)});m.ensureCerts(['fixture']);`,
    ],
    { env: { ...process.env, DEPLOY_DATA_DIR: root }, timeout: 15_000 },
  );
}
async function clients(root: string, ca: string, key: string, cert: string) {
  const server = createServer(
    { key: readFileSync(join(root, key)), cert: readFileSync(join(root, cert)) },
    (_req, res) => res.end('synthetic verified TLS'),
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const caPath = join(root, ca);
  const port = address.port;
  try {
    const python = `import ssl,socket,sys\nc=ssl.create_default_context(cafile=sys.argv[1])\nc.verify_flags |= ssl.VERIFY_X509_STRICT\nwith socket.create_connection(('127.0.0.1',int(sys.argv[2]))) as s:\n with c.wrap_socket(s,server_hostname=sys.argv[3]) as t:\n  t.sendall(b'GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n');assert b'200' in t.recv(2048)\nprint('STRICT_TLS_PASS')`;
    const pass = await execute('python3', ['-c', python, caPath, String(port), 'localhost'], {
      timeout: 5000,
    });
    assert.match(pass.stdout, /STRICT_TLS_PASS/);
    await assert.rejects(
      execute('python3', ['-c', python, caPath, String(port), 'wrong.local'], { timeout: 5000 }),
    );
    const curl = await execute(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--noproxy',
        '*',
        '--cacert',
        caPath,
        `https://127.0.0.1:${port}/`,
      ],
      { timeout: 5000 },
    );
    assert.equal(curl.stdout, 'synthetic verified TLS');
    await assert.rejects(
      execute(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--noproxy',
          '*',
          '--cacert',
          caPath,
          '--resolve',
          `wrong.local:${port}:127.0.0.1`,
          `https://wrong.local:${port}/`,
        ],
        { timeout: 5000 },
      ),
    );
    const node = `import https from 'node:https';import fs from 'node:fs';const req=https.get({host:'127.0.0.1',port:${port},servername:process.argv[2],ca:fs.readFileSync(process.argv[1])},r=>{if(r.statusCode!==200)process.exitCode=1;r.resume();r.on('end',()=>console.log('NODE_TLS_PASS'));});req.on('error',e=>{console.error(e.code);process.exitCode=1});`;
    const ordinary = await execute(
      process.execPath,
      ['--input-type=module', '-e', node, caPath, 'localhost'],
      { timeout: 5000 },
    );
    assert.match(ordinary.stdout, /NODE_TLS_PASS/);
    await assert.rejects(
      execute(process.execPath, ['--input-type=module', '-e', node, caPath, 'wrong.local'], {
        timeout: 5000,
      }),
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test(
  'generated root has explicit strict CA profile and all clients enforce hostname validation',
  { timeout: 30_000, skip: needsOpenssl3 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ca-profile-generated-'));
    try {
      await generate(root);
      const ca = openssl(root, 'x509', '-in', 'certs/ca.crt', '-noout', '-text');
      assert.match(ca, /Basic Constraints: critical\s+CA:TRUE/);
      assert.match(ca, /Key Usage: critical\s+Certificate Sign, CRL Sign/);
      assert.match(ca, /Subject Key Identifier:/);
      assert.match(ca, /Authority Key Identifier:/);
      assert.equal(statSync(join(root, 'certs/ca.key')).mode & 0o777, 0o600);
      assert.match(
        openssl(
          root,
          'verify',
          '-x509_strict',
          '-check_ss_sig',
          '-purpose',
          'sslserver',
          '-verify_hostname',
          'localhost',
          '-CAfile',
          'certs/ca.crt',
          'certs/server.crt',
        ),
        /OK/,
      );
      assert.throws(() =>
        openssl(
          root,
          'verify',
          '-x509_strict',
          '-purpose',
          'sslserver',
          '-verify_hostname',
          'wrong.local',
          '-CAfile',
          'certs/ca.crt',
          'certs/server.crt',
        ),
      );
      await clients(root, 'certs/ca.crt', 'certs/server.key', 'certs/server.crt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'same-key subject and SKI correction validates existing leaf; startup never replaces existing CA or keys',
  { timeout: 30_000, skip: needsOpenssl3 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ca-profile-existing-'));
    try {
      mkdirSync(join(root, 'certs'));
      writeFileSync(
        join(root, 'old.cnf'),
        '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Synthetic legacy deploy CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n',
      );
      openssl(
        root,
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'certs/ca.key',
        '-out',
        'certs/ca.crt',
        '-days',
        '365',
        '-set_serial',
        '0x1',
        '-config',
        'old.cnf',
      );
      await generate(root); // Existing malformed root is intentionally retained; creates its leaf.
      const old = new X509Certificate(readFileSync(join(root, 'certs/ca.crt')));
      const before = Object.fromEntries(
        ['ca.crt', 'ca.key', 'server.crt', 'server.key'].map((name) => [
          name,
          readFileSync(join(root, 'certs', name)),
        ]),
      );
      assert.throws(() =>
        openssl(
          root,
          'verify',
          '-x509_strict',
          '-purpose',
          'sslserver',
          '-CAfile',
          'certs/ca.crt',
          'certs/server.crt',
        ),
      );
      const ski = openssl(
        root,
        'x509',
        '-in',
        'certs/ca.crt',
        '-noout',
        '-ext',
        'subjectKeyIdentifier',
      );
      writeFileSync(
        join(root, 'corrected.cnf'),
        '[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n',
      );
      openssl(
        root,
        'x509',
        '-in',
        'certs/ca.crt',
        '-signkey',
        'certs/ca.key',
        '-set_serial',
        '0x2',
        '-preserve_dates',
        '-extfile',
        'corrected.cnf',
        '-extensions',
        'ca',
        '-out',
        'corrected.crt',
      );
      const corrected = new X509Certificate(readFileSync(join(root, 'corrected.crt')));
      assert.equal(corrected.subject, old.subject);
      assert.equal(corrected.issuer, old.issuer);
      assert.deepEqual(
        corrected.publicKey.export({ type: 'spki', format: 'der' }),
        old.publicKey.export({ type: 'spki', format: 'der' }),
      );
      assert.equal(corrected.validFrom, old.validFrom);
      assert.equal(corrected.validTo, old.validTo);
      assert.notEqual(corrected.fingerprint256, old.fingerprint256);
      assert.notEqual(corrected.serialNumber, old.serialNumber);
      assert.equal(
        openssl(root, 'x509', '-in', 'corrected.crt', '-noout', '-ext', 'subjectKeyIdentifier'),
        ski,
      );
      assert.match(
        openssl(
          root,
          'verify',
          '-x509_strict',
          '-check_ss_sig',
          '-purpose',
          'sslserver',
          '-verify_hostname',
          'localhost',
          '-CAfile',
          'corrected.crt',
          'certs/server.crt',
        ),
        /OK/,
      );
      await clients(root, 'corrected.crt', 'certs/server.key', 'certs/server.crt');
      await generate(root);
      for (const [name, content] of Object.entries(before))
        assert.deepEqual(readFileSync(join(root, 'certs', name)), content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
