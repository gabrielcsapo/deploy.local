import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let recovery: typeof import('./recovery-bundle.ts');
let readiness: typeof import('./release-readiness.ts');
let secrets: typeof import('./secrets.ts');
let certs: typeof import('./certs.ts');
let content: typeof import('./content-store.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-release-readiness-'));
  process.env.DEPLOY_DATA_DIR = join(root, 'home');
  store = await import(`./store.ts?release-readiness=${Date.now()}`);
  recovery = await import(`./recovery-bundle.ts?release-readiness=${Date.now()}`);
  readiness = await import(`./release-readiness.ts?release-readiness=${Date.now()}`);
  secrets = await import(`./secrets.ts?release-readiness=${Date.now()}`);
  certs = await import(`./certs.ts?release-readiness=${Date.now()}`);
  content = await import(`./content-store.ts?release-readiness=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe('v1 release readiness gate', () => {
  it('requires a fresh verified bundle and a passed clean-Home rehearsal', async () => {
    const initial = readiness.evaluateV1ReleaseReadiness();
    assert.equal(initial.ready, false);
    assert.equal(
      initial.checks.find((check) => check.id === 'CUTOVER.RECOVERY_BOUNDARY')?.status,
      'block',
    );

    const bundlePath = join(root, 'cutover.bundle');
    const passphrase = 'release rehearsal suitcase passphrase';
    secrets.loadOrCreateSecretKey();
    certs.ensureCerts();
    const bundle = await recovery.createRecoveryBundle({ outputPath: bundlePath, passphrase });
    recovery.verifyRecoveryBundle({ bundlePath, passphrase, bundleId: bundle.id });

    const verifiedOnly = readiness.evaluateV1ReleaseReadiness();
    assert.equal(verifiedOnly.ready, false);
    assert.match(
      verifiedOnly.checks.find((check) => check.id === 'CUTOVER.RECOVERY_BOUNDARY')!.message,
      /has not passed/i,
    );

    const rehearsal = recovery.rehearseRecoveryBundle({
      bundleId: bundle.id,
      bundlePath,
      passphrase,
    });
    assert.equal(rehearsal.passed, true);
    const rehearsed = readiness.evaluateV1ReleaseReadiness();
    assert.equal(rehearsed.ready, true);
    assert.equal(
      rehearsed.checks.find((check) => check.id === 'CUTOVER.RECOVERY_BOUNDARY')?.status,
      'pass',
    );

    const retained = content.putArtifactBytes(Buffer.from('retained release artifact'), {
      type: 'release',
      retentionClass: 'release',
    });
    unlinkSync(retained.path);
    const missingArtifact = readiness.evaluateV1ReleaseReadiness();
    assert.equal(missingArtifact.ready, false);
    assert.deepEqual(
      missingArtifact.checks.find((check) => check.id === 'CUTOVER.ARTIFACT_INTEGRITY'),
      {
        id: 'CUTOVER.ARTIFACT_INTEGRITY',
        status: 'block',
        message: '1 retained artifact(s) are missing or corrupt.',
        evidence: [retained.digest],
      },
    );
  });
});
