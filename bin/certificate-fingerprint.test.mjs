import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { X509Certificate } from 'node:crypto';
import {
  certificateFingerprint,
  printCertificateFingerprint,
  shortFingerprint,
} from './certificate-fingerprint.mjs';

const example = '4F:A2:19:C7:0B:E3:' + '00:'.repeat(20) + '88:D1:5E:42:9C:07';
test('short form matches the approved board and keeps leading zeroes', () => {
  assert.equal(shortFingerprint(example.toLowerCase()), '4F:A2:19:C7:0B:E3 · 88:D1:5E:42:9C:07');
  assert.throws(() => shortFingerprint('00:12'), /SHA-256/);
  assert.throws(() => shortFingerprint(example.replace('4F', 'ZZ')), /SHA-256/);
});

// Public test CA only; no private key is shipped.
const ca = `-----BEGIN CERTIFICATE-----
MIIC6DCCAdCgAwIBAgIJAMEzixRA5zebMA0GCSqGSIb3DQEBCwUAMCExHzAdBgNV
BAMMFlBhc3N3b3JkIHRydXN0IHRlc3QgQ0EwHhcNMjYxMTA0MDA1NTAxWhcNMzYx
MTAxMDA1NTAxWjAhMR8wHQYDVQQDDBZQYXNzd29yZCB0cnVzdCB0ZXN0IENBMIIB
IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArU/3RR60zzicz6CYbZXVpBpj
LZmIMo7vG6eRP5yK2eX5QjKLc4N2HCuQqbceh3Y9XJgL319hRZNqksxBqOPyAhBf
mYQ/AnGr8N8soNLQ6S8Bc30ehZYt2vrlDrD07OSlR93X6sN/6nwcMQqwBRSxWZc/
YFMdheX5kd35F4sVdXMljs70CP6f4nejMoYx/k/X9g0pm7IyD2TwseNzuNTiT8aP
Nrw1liB/Liu2NIKe3qeUowns5hMkhIfSbqwftxiHEvYOiGAt92K3ry6tRO+J75gt
VvGbPYw1suZrjT3GvI5W+7acns1hzBV9ODBmlUiSAePXZhG5LaIEvBUGej5eoQID
AQABoyMwITAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG
9w0BAQsFAAOCAQEAo7uzlHc90d/eLTKY/DdHubOeo2uL5Asesj3CNgC+oSsOBEoO
aPG1HG4aUjPFezpDEjnLMV4hwTfogvYQ2eYqUUGwZSvS8sYJX1VZ5245kR18wKje
yVnAxhCuQTLhzoy5ZaPRaLdmuwT4BYiIfC4uLvCGPjOhhFKdHWBYGKQe+wlR+/M0
tx/y42KqMEaseNQn0BYFSNJc3ka3NoH4inOuC4lHHboAE0pEdJ/Uv7z/QPKYHaWH
X1PZH15qYEhNX/Fvc8nIKQW91FVBJTBfjK4LCQnsaZISVMiAX/QDpbVValuq2CKh
SMtiNia+e5B+utjh4UO1RpNwt6q/PQZPWzIo1g==
-----END CERTIFICATE-----`;

test('status fingerprint reads the local SER CA, then falls back to a credential-free bounded download', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'deploy-fingerprint-'));
  const previous = process.env.DEPLOY_DATA_DIR;
  process.env.DEPLOY_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.DEPLOY_DATA_DIR;
    else process.env.DEPLOY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, 'certs'));
  const path = join(directory, 'certs', 'ca.crt');
  await writeFile(path, ca);
  const full = new X509Certificate(ca).fingerprint256;
  const lines = [];
  await printCertificateFingerprint('https://unreachable.invalid', (line) => lines.push(line));
  assert.deepEqual(lines, [shortFingerprint(full), full, `Local CA: ${path}`]);
  const output = execFileSync(
    process.execPath,
    [
      join(import.meta.dirname, 'deploy.js'),
      'status',
      '--fingerprint',
      '--url',
      'https://unreachable.invalid',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_AUTH_JSON: '{}' },
      timeout: 20000,
    },
  );
  assert.deepEqual(output.trim().split('\n'), lines);
  await writeFile(path, 'invalid local certificate');
  await assert.rejects(certificateFingerprint('https://unreachable.invalid'));
  await rm(path);

  let mode = 'certificate';
  const requests = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    requests.push({ url, options });
    const request = new EventEmitter();
    request.destroy = (error) => {
      request.emit('error', error);
      request.emit('close');
    };
    queueMicrotask(() => {
      const response = Readable.from([
        Buffer.from(
          mode === 'oversize' ? 'a'.repeat(65537) : mode === 'invalid' ? 'not a certificate' : ca,
        ),
      ]);
      response.statusCode = mode === 'redirect' ? 302 : 200;
      response.headers = mode === 'redirect' ? { location: '/elsewhere' } : {};
      response.on('close', () => request.emit('close'));
      callback(response);
    });
    return request;
  });
  const address = 'https://fixture.invalid';
  assert.deepEqual(await certificateFingerprint(address), {
    short: shortFingerprint(full),
    full,
    source: `Fetched from ${address}/ca.crt`,
  });
  assert.equal(requests[0].url.href, `${address}/ca.crt`);
  assert.equal(requests[0].options.rejectUnauthorized, false);
  assert.equal(requests[0].options.agent, false);
  assert.equal(requests[0].url.username, '');
  assert.equal(requests[0].url.password, '');
  assert.equal(requests[0].options.headers, undefined);
  assert.equal(requests[0].options.auth, undefined);
  mode = 'redirect';
  await assert.rejects(certificateFingerprint(address), /HTTP 302/);
  assert.equal(requests.length, 2);
  mode = 'oversize';
  await assert.rejects(certificateFingerprint(address), /65536/);
  mode = 'invalid';
  await assert.rejects(certificateFingerprint(address));
  await assert.rejects(
    certificateFingerprint(address.replace('https://', 'https://user:secret@')),
    /HTTPS/,
  );
  await assert.rejects(certificateFingerprint('http://example.com'), /HTTPS/);
  assert.equal(requests.length, 4);
});
