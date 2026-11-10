import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let support: typeof import('./support-bundle.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-support-bundle-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?support=${Date.now()}`);
  support = await import(`./support-bundle.ts?support=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('redacted support bundle', () => {
  it('includes topology and diagnostics without secret-like event fields or credentials', async () => {
    store.ensureCoordinatorNode();
    const sensitive = 'do-not-leak-this-password';
    store
      .getSqlite()!
      .prepare('UPDATE nodes SET capabilities = ? WHERE id = ?')
      .run(
        JSON.stringify({ password: sensitive, nested: { accessToken: sensitive } }),
        'coordinator',
      );
    store.saveDeployment({ name: 'support-app', username: 'admin' });
    store.updateDeploymentSettings('support-app', {
      envVars: { PASSWORD: sensitive },
    });
    const output = join(root, 'support.json');
    const result = await support.createSupportBundle({ outputPath: output, createdBy: 'admin' });
    assert.match(result.artifactDigest, /^sha256:/);
    const text = readFileSync(output, 'utf8');
    assert.equal(text.includes(sensitive), false);
    assert.equal(text.includes('[REDACTED]'), true);
    const bundle = JSON.parse(text);
    assert.equal(bundle.kind, 'deploy.local/SupportBundle');
    assert.equal(bundle.topology.nodes[0].id, 'coordinator');
    assert.equal(bundle.recentEvents, undefined);
    assert.equal(bundle.topology.applications[0].name, 'support-app');
    assert.doesNotThrow(() => support.verifySupportBundleRedaction(bundle, [sensitive]));
  });
});
