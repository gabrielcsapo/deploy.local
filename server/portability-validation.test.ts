import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { compileApplicationManifest } from './application-spec.ts';
import {
  validatePortability,
  type PortabilityValidationAdapter,
  type TemporaryReplicaResult,
} from './portability-validation.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-portability-validation-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'upload.txt'), 'kept at both sites');
  const compiled = compileApplicationManifest({
    apiVersion: 'deploy.local/v1',
    kind: 'Application',
    components: {
      web: {
        image:
          'example/portable@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        interfaces: { http: { port: 3000, protocol: 'http' } },
        health: { interface: 'http', path: '/health' },
        mounts: { '/app/data': { resource: 'data' } },
      },
    },
    resources: {
      data: { type: 'volume', durability: 'durable', dataRole: 'files' },
    },
    routes: { main: { to: 'web.http' } },
  });
  return { root, compiled };
}

function adapter(
  temporaryReplica: Partial<TemporaryReplicaResult> = {},
  buildPassed = true,
): PortabilityValidationAdapter & { cleaned: boolean } {
  return {
    cleaned: false,
    async inspectTarget() {
      return {
        platform: 'linux',
        architecture: 'arm64',
        compatibleArchitectures: ['arm64'],
        runtimeAvailable: true,
        requiredDevicesAvailable: true,
        detail: ['Docker Engine reachable'],
      };
    },
    async verifyArtifacts() {
      return { passed: true, detail: ['all immutable digests present'] };
    },
    async verifyIdentityAndSecrets() {
      return { passed: true, detail: ['site envelope decrypted'] };
    },
    async startTemporaryReplica() {
      return {
        containmentEnforced: true,
        healthPassed: true,
        edgeRequestPassed: true,
        externalDependencies: [],
        validatedWorkflows: ['GET /'],
        unverifiedWorkflows: [],
        observedMutablePaths: ['/app/data/upload.txt'],
        detail: ['read-only root and network denial enforced'],
        ...temporaryReplica,
      };
    },
    async exerciseReconciliation() {
      return { passed: true, detail: ['fork/diff/apply validation passed'] };
    },
    async buildWithoutNetwork() {
      return {
        passed: buildPassed,
        detail: buildPassed ? ['cached build passed'] : ['base image layer is absent'],
      };
    },
    async cleanup() {
      this.cleaned = true;
    },
  };
}

describe('temporary suitcase validation replica', () => {
  it('turns enforced runtime evidence into a complete, digest-scoped report', async () => {
    const { root, compiled } = fixture();
    const probe = adapter();
    const result = await validatePortability(
      {
        appId: 'app-portable',
        siteId: 'site-trip',
        specDigest: compiled.digest,
        configurationDigest: 'sha256:configuration',
        targetCapabilityDigest: 'sha256:target',
        checkpointId: 'checkpoint-shared',
        requiredArtifactDigests: ['sha256:image', 'sha256:checkpoint'],
        requireOfflineBuild: true,
        spec: compiled.spec,
        volumes: [{ resource: 'data', snapshotPath: join(root, 'data') }],
        persist: false,
      },
      probe,
    );

    assert.equal(probe.cleaned, true);
    assert.equal(result.report.classification, 'file-replica');
    assert.equal(result.report.syncsAcrossSites, true);
    assert.equal(result.report.capabilityVector.runtimeContainment.status, 'pass');
    assert.equal(result.report.capabilityVector.offlineDependencies.status, 'pass');
    assert.equal(result.report.capabilityVector.buildability.status, 'pass');
    assert.match(result.proof.inputDigest, /^sha256:/);
  });

  it('blocks runtime readiness for an observed required remote service', async () => {
    const { root, compiled } = fixture();
    const result = await validatePortability(
      {
        appId: 'app-cloud-bound',
        siteId: 'site-trip',
        specDigest: compiled.digest,
        configurationDigest: 'sha256:configuration',
        targetCapabilityDigest: 'sha256:target',
        requiredArtifactDigests: ['sha256:image'],
        requireOfflineBuild: false,
        spec: compiled.spec,
        volumes: [{ resource: 'data', snapshotPath: join(root, 'data') }],
        persist: false,
      },
      adapter({
        externalDependencies: [
          {
            destination: 'accounts.example.test:443',
            required: true,
            evidence: 'login probe attempted TLS after network denial',
          },
        ],
      }),
    );

    assert.equal(result.report.capabilityVector.offlineDependencies.status, 'block');
    assert.equal(
      result.report.findings.some((item) => item.id === 'OFFLINE.REQUIRED_REMOTE_SERVICE'),
      true,
    );
  });

  it('keeps runtime portability while separately blocking offline development', async () => {
    const { root, compiled } = fixture();
    const result = await validatePortability(
      {
        appId: 'app-runtime-only',
        siteId: 'site-trip',
        specDigest: compiled.digest,
        configurationDigest: 'sha256:configuration',
        targetCapabilityDigest: 'sha256:target',
        requiredArtifactDigests: ['sha256:image'],
        requireOfflineBuild: true,
        spec: compiled.spec,
        volumes: [{ resource: 'data', snapshotPath: join(root, 'data') }],
        persist: false,
      },
      adapter({}, false),
    );

    assert.equal(result.report.syncsAcrossSites, true);
    assert.equal(result.report.capabilityVector.offlineDependencies.status, 'pass');
    assert.equal(result.report.capabilityVector.buildability.status, 'block');
  });
});
