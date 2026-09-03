import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileDeployYaml } from './application-spec.ts';
import {
  rebaseApplicationRevision,
  repositoryUploadCanSkipRuntime,
  renderParentRelativeApplicationPatch,
} from './application-revision.ts';

const BASE = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata: { name: notes, description: Base }
components:
  web:
    image: example/web:1
    instances: 1
    interfaces: { http: { port: 3000, protocol: http } }
routes:
  public: { to: web.http }
`).spec;

describe('application revision ancestry', () => {
  it('rebuilds unchanged graphs when their source artifact changed', () => {
    assert.equal(
      repositoryUploadCanSkipRuntime({
        revisionUnchanged: true,
        desiredDigest: 'sha256:graph',
        activeDigest: 'sha256:graph',
        previousSourceArtifactDigest: 'sha256:old-source',
        nextSourceArtifactDigest: 'sha256:new-source',
      }),
      false,
    );
    assert.equal(
      repositoryUploadCanSkipRuntime({
        revisionUnchanged: true,
        desiredDigest: 'sha256:desired',
        activeDigest: 'sha256:active',
        previousSourceArtifactDigest: 'sha256:old-source',
        nextSourceArtifactDigest: 'sha256:new-source',
      }),
      true,
    );
  });

  it('rebases independent repository edits and anchors the exported result to current', () => {
    const current = structuredClone(BASE);
    current.metadata.description = 'Edited in UI';
    const repository = structuredClone(BASE);
    repository.components.web.instances = 2;
    const currentDigest = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata: { name: notes, description: Edited in UI }
components:
  web:
    image: example/web:1
    instances: 1
    interfaces: { http: { port: 3000, protocol: http } }
routes:
  public: { to: web.http }
`).digest;

    const result = rebaseApplicationRevision({ base: BASE, current, repository, currentDigest });

    assert.deepEqual(result.conflicts, []);
    assert.equal(result.spec?.metadata.description, 'Edited in UI');
    assert.equal(result.spec?.components.web.instances, 2);
    assert.match(result.manifest!, new RegExp(`^# deploy\\.local/base: ${currentDigest}`));
  });

  it('preserves both sides and reports overlapping edits instead of guessing', () => {
    const current = structuredClone(BASE);
    current.components.web.image = 'example/web:2';
    const repository = structuredClone(BASE);
    repository.components.web.image = 'example/web:3';

    const result = rebaseApplicationRevision({
      base: BASE,
      current,
      repository,
      currentDigest: `sha256:${'a'.repeat(64)}`,
    });

    assert.deepEqual(result.conflicts, ['/components/web/image']);
    assert.equal(result.spec, undefined);
  });

  it('exports a parent-relative merge patch without resolved values', () => {
    const target = structuredClone(BASE);
    target.components.web.instances = 2;
    const patch = renderParentRelativeApplicationPatch({
      applicationName: 'notes',
      parentDigest: `sha256:${'a'.repeat(64)}`,
      targetDigest: `sha256:${'b'.repeat(64)}`,
      parent: BASE,
      target,
    });

    assert.match(patch, /kind: ApplicationPatch/);
    assert.match(patch, /parentDigest: sha256:aaaa/);
    assert.match(patch, /instances: 2/);
  });
});
