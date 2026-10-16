import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDeployYaml, compileApplicationManifest } from './application-spec.ts';
const source = `apiVersion: deploy.local/v1
kind: Application
pipeline:
  on: [manual, push]
  jobs:
    test:
      runsOn: {os: linux}
      container: node:26-alpine
      run: node --version
    build:
      runsOn: {os: macos, capabilities: [xcode]}
      needs: [test]
      run: xcodebuild -version
`;
test('one deploy.yaml supports pipeline-only repos and canonical round trips without dummy deployments', () => {
  const compiled = compileDeployYaml(source);
  assert.deepEqual(compiled.spec.components, {});
  assert.deepEqual(compiled.spec.pipeline?.jobs.test.runsOn.capabilities, ['docker']);
  assert.equal(compileApplicationManifest(compiled.spec).digest, compiled.digest);
  assert.equal(compiled.spec.pipeline?.jobs.build.timeoutSeconds, 900);
});
test('pipeline compiler rejects cycles, unknown requirements, incompatible containers and deferred Windows', () => {
  for (const [changed, pattern] of [
    [source.replace('needs: [test]', 'needs: [build]'), /cycle/],
    [source.replace('needs: [test]', 'needs: [absent]'), /Unknown pipeline dependency/],
    [source.replace('os: linux', 'os: windows'), /Windows execution is deferred/],
    [source.replace('os: linux', 'os: macos'), /container requires Linux/],
    [source.replace('runsOn: {os: linux}', 'runsOn: {os: linux, mystery: true}'), /unknown field/],
    [
      source.replace('run: node --version', 'timeoutSeconds: 0\n      run: node --version'),
      /timeoutSeconds/,
    ],
  ] as const)
    assert.throws(() => compileDeployYaml(changed), pattern);
});
