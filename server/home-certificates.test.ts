import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'home-certificates-'));
process.env.DEPLOY_DATA_DIR = root;
const certs = await import('./certs.ts');
after(() => {
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

test('Home issues and renews app certificates without retired delegated issuers', () => {
  const directory = join(root, 'certs');
  mkdirSync(directory);
  writeFileSync(join(directory, 'issuer.crt'), 'retired delegated issuer');
  writeFileSync(join(directory, 'issuer.key'), 'retired delegated key');
  certs.ensureCerts(['first-app']);
  const rootKey = readFileSync(join(directory, 'ca.key'));
  assert.equal(certs.certsExist(), true);
  assert.equal(certs.ensureCertCoversHost('next-app', ['first-app', 'next-app']), true);
  assert.deepEqual(readFileSync(join(directory, 'ca.key')), rootKey);
  const options = certs.getTlsOptions();
  assert.equal((options.cert.toString().match(/BEGIN CERTIFICATE/g) || []).length, 1);
  assert.match(
    execFileSync(
      'openssl',
      ['verify', '-CAfile', join(directory, 'ca.crt'), join(directory, 'server.crt')],
      { encoding: 'utf8' },
    ),
    /OK/,
  );
});
