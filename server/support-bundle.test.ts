import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let multisite: typeof import('./multisite.ts');
let support: typeof import('./support-bundle.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-support-bundle-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?support=${Date.now()}`);
  multisite = await import(`./multisite.ts?support=${Date.now()}`);
  support = await import(`./support-bundle.ts?support=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('redacted support bundle', () => {
  it('includes topology and diagnostics without secret-like event fields or credentials', async () => {
    const fleet = multisite.ensureFleetIdentity();
    const sensitive = 'do-not-leak-this-password';
    multisite.appendLocalFleetEvent({
      originSiteId: fleet.homeSiteId,
      actor: 'admin',
      operation: 'configuration.updated',
      payload: { username: 'notes', password: sensitive, nested: { accessToken: sensitive } },
    });
    const output = join(root, 'support.json');
    const result = await support.createSupportBundle({ outputPath: output, createdBy: 'admin' });
    assert.match(result.artifactDigest, /^sha256:/);
    const text = readFileSync(output, 'utf8');
    assert.equal(text.includes(sensitive), false);
    assert.equal(text.includes('[REDACTED]'), true);
    const bundle = JSON.parse(text);
    assert.equal(bundle.kind, 'deploy.local/SupportBundle');
    assert.equal(bundle.topology.fleet.id, fleet.id);
    assert.doesNotThrow(() => support.verifySupportBundleRedaction(bundle, [sensitive]));
  });
});
