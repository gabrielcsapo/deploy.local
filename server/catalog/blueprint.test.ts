import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planApplicationExecution } from '../application-execution.ts';
import { validateCatalogBlueprint } from './blueprint.ts';
import { loadValidationCatalog, validationBlueprints, validationTrustStore } from './fixtures.ts';

describe('catalog blueprint trust and validation fixtures', () => {
  it('verifies signed validation blueprints and their upgrade edges without claiming physical tests', () => {
    const releases = loadValidationCatalog();
    assert.deepEqual(
      releases.map((item) => item.release.id),
      [
        'volume-app-fixture',
        'home-assistant-container',
        'postgres-service-graph-fixture',
        'volume-app-fixture',
        'postgres-service-graph-fixture',
      ],
    );
    for (const item of releases) {
      assert.equal(item.release.support.stage, 'validation');
      assert.equal(
        item.release.support.evidence.some((evidence) => evidence.result === 'passed'),
        false,
      );
      for (const component of Object.values(item.normalizedSpec.components)) {
        assert.match(component.image || '', /@sha256:[a-f0-9]{64}$/);
      }
      assert.equal(
        item.release.artifacts.every((artifact) => artifact.verification === 'resolved'),
        true,
      );
    }
    assert.equal(Object.keys(releases[2].normalizedSpec.components).length, 4);
    assert.equal(releases[2].normalizedSpec.components.web.instances, 2);
    assert.equal(releases[2].normalizedSpec.jobs.migrate.beforeTraffic, true);
    assert.deepEqual(
      releases[3].release.upgrades.map((path) => path.fromRelease),
      ['1.0.0-validation.1'],
    );
    assert.deepEqual(releases[4].release.upgrades[0].migrationJobs, ['migrate']);
    assert.equal(releases[4].normalizedSpec.components.web.instances, 3);
    assert.equal(planApplicationExecution('simple', releases[0].normalizedSpec).blocked, false);
    assert.equal(planApplicationExecution('postgres', releases[2].normalizedSpec).blocked, false);
  });

  it('rejects content tampering even when the old signature is retained', () => {
    const release = structuredClone(validationBlueprints[0]);
    release.metadata.summary = 'tampered summary';
    assert.throws(
      () => validateCatalogBlueprint(release, validationTrustStore),
      /contentDigest mismatch|signature does not verify/,
    );
  });

  it('rejects revoked publisher keys and unpinned component images', () => {
    const revokedStore = structuredClone(validationTrustStore);
    revokedStore.keys[0].revokedAt = '2026-08-08T00:00:00.000Z';
    revokedStore.keys[0].revocationReason = 'test revocation';
    assert.throws(
      () => validateCatalogBlueprint(validationBlueprints[0], revokedStore),
      /was revoked/,
    );

    const unpinned = structuredClone(validationBlueprints[0]);
    unpinned.application.components.web.image = 'example.invalid/deploy-local/volume-app:latest';
    assert.throws(
      () => validateCatalogBlueprint(unpinned, validationTrustStore),
      /contentDigest mismatch|must be pinned/,
    );
  });

  it('rejects malformed and unknown schema fields before cryptographic processing', () => {
    assert.throws(() => validateCatalogBlueprint(null, validationTrustStore), /must be an object/);
    const unknownField = {
      ...structuredClone(validationBlueprints[0]),
      unexpectedRuntimeFlag: true,
    };
    assert.throws(
      () => validateCatalogBlueprint(unknownField, validationTrustStore),
      /unknown field "unexpectedRuntimeFlag"/,
    );
    const malformedArtifacts = {
      ...structuredClone(validationBlueprints[0]),
      artifacts: [null],
    };
    assert.throws(
      () => validateCatalogBlueprint(malformedArtifacts, validationTrustStore),
      /artifacts\[0\] must be an object/,
    );
  });
});
