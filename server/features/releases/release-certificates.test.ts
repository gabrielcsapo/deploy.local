import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'release-certificates-'));
process.env.DEPLOY_DATA_DIR = root;
const certs = await import('../../certs.ts');
const { compileDeployYaml } = await import('../../application-spec.ts');
const { coverReleasedHosts } = await import('./releases-runtime.ts');
after(() => {
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function spec(name: string, routed: boolean) {
  return compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata:
  name: ${name}
components:
  web:
    build:
      context: .
    interfaces:
      http:
        protocol: http
        port: 3000
${routed ? 'routes:\n  public:\n    to: web.http\n' : ''}`).spec;
}

function certificateNames() {
  return execFileSync(
    'openssl',
    ['x509', '-noout', '-text', '-in', join(root, 'certs', 'server.crt')],
    { encoding: 'utf8' },
  );
}

test('a released app with a route is added to the certificate; one without a route is not', () => {
  // Nothing to cover before the server has certificates.
  coverReleasedHosts([{ name: 'early', spec: spec('early', true) }]);
  assert.equal(certs.certsExist(), false);

  certs.ensureCerts([]);
  coverReleasedHosts([
    { name: 'drop', spec: spec('drop', true) },
    { name: 'worker-only', spec: spec('worker-only', false) },
  ]);
  const names = certificateNames();
  assert.match(names, /DNS:drop\.local/);
  assert.doesNotMatch(names, /worker-only/);
});
