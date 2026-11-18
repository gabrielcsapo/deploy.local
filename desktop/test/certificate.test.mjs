import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import {
  CoordinatorClient,
  certificateProblem,
  fingerprint,
  inspectCertificate,
} from '../src/client.mjs';
import { shortFingerprint, trayModel } from '../src/model.mjs';
import { render } from '../src/views.mjs';

const dir = mkdtempSync(join(tmpdir(), 'desktop-certificate-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
function authority(name) {
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.crt`,
    '-days',
    '30',
    '-subj',
    `/CN=${name}`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  );
  return readFileSync(join(dir, `${name}.crt`), 'utf8');
}
function leaf(name, ca, names = 'DNS:localhost,IP:127.0.0.1') {
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${names}\n`);
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
    '-subj',
    '/CN=deploy.local',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    `${ca}.crt`,
    '-CAkey',
    `${ca}.key`,
    '-CAcreateserial',
    '-out',
    `${name}.crt`,
    '-days',
    '10',
    '-extfile',
    `${name}.ext`,
  );
  return {
    key: readFileSync(join(dir, `${name}.key`)),
    cert: readFileSync(join(dir, `${name}.crt`), 'utf8'),
  };
}
const ca = authority('ser-ca');
const other = authority('other-ca');
const first = leaf('first', 'ser-ca');
const renewed = leaf('renewed', 'ser-ca', 'DNS:localhost,DNS:forma.local,IP:127.0.0.1');
const imposter = leaf('imposter', 'other-ca');
const elsewhere = leaf('elsewhere', 'ser-ca', 'DNS:forma.local');

async function serve({ key, cert }, chain = true) {
  const server = https.createServer(
    { key, cert: chain ? cert + ca : cert },
    (request, response) => {
      if (request.url === '/ca.crt') return response.end(ca);
      response.setHeader('Content-Type', 'application/json');
      response.end('{"items":[]}');
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `https://127.0.0.1:${server.address().port}` };
}

test('a renewed certificate from the same CA is trusted; another CA, a wrong name or a stale pin is not', () => {
  assert.equal(certificateProblem(first.cert, { ca }, '127.0.0.1'), null);
  assert.equal(certificateProblem(renewed.cert, { ca }, 'forma.local'), null);
  assert.equal(certificateProblem(imposter.cert, { ca }, '127.0.0.1'), 'changed');
  assert.equal(certificateProblem(elsewhere.cert, { ca }, '127.0.0.1'), 'name');
  assert.equal(
    certificateProblem(first.cert, { ca }, '127.0.0.1', Date.now() + 40 * 864e5),
    'expired',
  );
  // Macs set up before CA trust hold the exact certificate until they move to the CA.
  const pin = new X509Certificate(first.cert).fingerprint256;
  assert.equal(certificateProblem(first.cert, { pin }), null);
  assert.equal(certificateProblem(renewed.cert, { pin }), 'changed');
});

test('inspection finds the CA from the handshake or from /ca.crt', async () => {
  for (const chain of [true, false]) {
    const { server, origin } = await serve(first, chain);
    try {
      const seen = await inspectCertificate(origin);
      assert.equal(seen.fingerprint, fingerprint(ca));
      assert.equal(seen.certificate, new X509Certificate(first.cert).fingerprint256);
      assert.equal(seen.address, '127.0.0.1');
    } finally {
      server.close();
    }
  }
});

test('the client keeps working through a renewal and stops, with a code, on another CA', async () => {
  const client = new CoordinatorClient('https://127.0.0.1', { ca });
  for (const [served, problem] of [
    [first, null],
    [renewed, null],
    [imposter, 'CERTIFICATE_CHANGED'],
  ]) {
    const { server, origin } = await serve(served);
    client.origin = origin;
    try {
      if (problem) await assert.rejects(client.request('/api/inbox'), { code: problem });
      else assert.deepEqual(await client.request('/api/inbox'), { items: [] });
    } finally {
      server.close();
    }
  }
  assert.equal(client.trusted, fingerprint(ca));
});

test('the certificate-changed page shows both fingerprints in the short form deploy status prints', () => {
  const previous = new X509Certificate(first.cert).fingerprint256;
  const next = fingerprint(other);
  const state = {
    page: 'certificate-changed',
    origin: 'https://deploy.local',
    coordinatorName: 'SER',
    certificate: {
      previous,
      fingerprint: next,
      address: '192.168.1.20',
      issued: new Date().toISOString(),
      expires: '2029-02-20T17:11:53Z',
    },
  };
  const html = render(state);
  assert.match(html, /<h1>SER has a new certificate<\/h1>/);
  assert.match(html, /deploy\.local · 192\.168\.1\.20/);
  assert.ok(html.includes(shortFingerprint(previous)));
  assert.ok(html.includes(shortFingerprint(next)));
  assert.match(html, /New since today at/);
  assert.match(html, /value="trust-changed" class="primary">They match · trust it/);
  assert.match(html, /value="switch" class="quiet">Use another address/);
  assert.equal(shortFingerprint(next).split(' · ').length, 2);
  const model = trayModel({ online: false, certificate: state.certificate });
  assert.equal(model.icon, 'warning');
  assert.equal(model.connection, 'New certificate · check it');
});
