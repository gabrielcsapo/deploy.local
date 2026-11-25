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

test('pipeline deploy supports first deployments and a confined optional app root', () => {
  assert.deepEqual(
    compileDeployYaml(source + '  deploy: { application: new-app }\n').spec.pipeline?.deploy,
    { application: 'new-app' },
  );
  assert.equal(
    compileDeployYaml(source + '  deploy: { application: new-app, path: apps/web }\n').spec.pipeline
      ?.deploy?.path,
    'apps/web',
  );
  for (const path of ['../app', '/app', 'apps/../web', '', 'apps\\web'])
    assert.throws(
      () =>
        compileDeployYaml(
          source + `  deploy: { application: new-app, path: ${JSON.stringify(path)} }\n`,
        ),
      /subdirectory/,
    );
});

test('pipeline paths survive canonical round trips and reject invalid filters', () => {
  const withPaths = source + '  paths: ["packages/react-flight-router*/**", "pnpm-lock.yaml"]\n';
  const compiled = compileDeployYaml(withPaths);
  assert.deepEqual(compiled.spec.pipeline?.paths, [
    'packages/react-flight-router*/**',
    'pnpm-lock.yaml',
  ]);
  assert.equal(compileApplicationManifest(compiled.spec).digest, compiled.digest);
  assert.equal(compileDeployYaml(source).spec.pipeline?.paths, undefined);
  for (const paths of [
    [],
    [''],
    ['../secret'],
    ['/absolute'],
    ['a/../b'],
    ['./a'],
    ['a\\b'],
    ['!excluded'],
    ['a', 'a'],
    [false],
    'src/**',
    Array(33).fill('src'),
  ]) {
    assert.throws(
      () => compileDeployYaml(source + `  paths: ${JSON.stringify(paths)}\n`),
      /pipeline.paths/,
    );
  }
});

test('publish-only pipeline accepts confined distinct folders and round trips', () => {
  const compiled = compileDeployYaml(source + '  publish: [packages/router, packages/mdns]\n');
  assert.deepEqual(compiled.spec.pipeline?.publish, ['packages/mdns', 'packages/router']);
  assert.deepEqual(compiled.spec.components, {});
  assert.equal(compiled.spec.pipeline?.deploy, undefined);
  assert.equal(compileApplicationManifest(compiled.spec).digest, compiled.digest);
  for (const publish of [
    ['a', 'a'],
    ['a/../b'],
    ['../x'],
    ['/x'],
    ['a\\b'],
    ['a\0b'],
    ['a\nb'],
    ['a//b'],
    ['a/'],
    ['.'],
    [''],
    'a',
    [1],
  ])
    assert.throws(
      () => compileDeployYaml(source + `  publish: ${JSON.stringify(publish)}\n`),
      /pipeline.publish/,
    );
});

test('the repository pipeline checks every main push and PR', async () => {
  const { readFileSync } = await import('node:fs');
  const pipeline = compileDeployYaml(readFileSync('deploy.yaml', 'utf8')).spec.pipeline!;
  assert.deepEqual(pipeline.on, ['manual', 'pull_request', 'push']);
  assert.deepEqual(pipeline.branches, ['main']);
  assert.equal(pipeline.paths, undefined);
  assert.equal(pipeline.deploy, undefined, 'CI cannot activate the production coordinator');
  // react-flight-router is published from its own repository.
  assert.equal(pipeline.publish, undefined);
  // react-flight-router is tested in its own repository.
  assert.equal(pipeline.jobs['router-test'], undefined);
  for (const name of ['typecheck', 'lint', 'test', 'build']) {
    assert.equal(pipeline.jobs[name].paths, undefined);
    assert.ok(pipeline.jobs[name].container, 'automatic PRs require isolation');
    assert.equal(pipeline.jobs[name].runsOn.os, 'linux');
  }
  assert.match(
    pipeline.jobs.test.run,
    /DEPLOY_SKIP_SWIFT_TESTS=1 DEPLOY_MDNS_ADDRESS=127\.0\.0\.1 sh scripts\/ci-test\.sh/,
  );
  assert.match(readFileSync('scripts/ci-test.sh', 'utf8'), /exec pnpm test/);
  assert.match(pipeline.jobs.lint.run, /pnpm run lint && pnpm run format:check/);
  for (const paths of [[], ['../x'], ['!x'], ['/x'], ['a', 'a']])
    assert.throws(
      () =>
        compileDeployYaml(
          source.replace(
            'run: node --version',
            `paths: ${JSON.stringify(paths)}\n      run: node --version`,
          ),
        ),
      /paths/,
    );
});

test('pipeline artifacts retain their paths and captions and reject paths outside the checkout', () => {
  const manifest = (path: string) =>
    source.replace(
      'run: node --version',
      `artifacts: [{path: ${JSON.stringify(path)}, caption: Screenshot}]\n      run: node --version`,
    );
  const compiled = compileDeployYaml(manifest('screens/*.png'));
  assert.deepEqual(compiled.spec.pipeline?.jobs.test.artifacts, [
    { path: 'screens/*.png', caption: 'Screenshot' },
  ]);
  assert.equal(compileApplicationManifest(compiled.spec).digest, compiled.digest);
  assert.throws(() => compileDeployYaml(manifest('../screens/*.png')), /job directory/);
});
