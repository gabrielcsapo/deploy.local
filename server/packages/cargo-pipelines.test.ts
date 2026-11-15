import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { routeFetch } from '../v2/test-request.ts';
import { cargoConfig, cargoMetadata, cargoPublishBody } from '../../shared/cargo.mjs';
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'cargo-pipeline-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
await import('../test-backups.ts');
const { registerUser, _resetDb } = await import('../store.ts');
const { db: workspace, save, get } = await import('../workspace/store.ts');
const { createCargoRegistry } = await import('./cargo.ts');
const { createNpmRegistry } = await import('./npm.ts');
const { advancePipelinePackages, packageAtCommit } = await import('./pipelines.ts');
const { issuePipelinePackageToken, pipelinePackageIdentity } = await import('./pipeline-auth.ts');
const { packageByName, versions } = await import('./store.ts');
const { readPackages, readPackage } = await import('./api.ts');
const { finishPackageJob } = await import('../workspace/package-publish.ts');
registerUser('owner', 'long-test-password');
const registry = createCargoRegistry({
  upstreamBase: 'http://127.0.0.1:12345/',
  downloadBase: 'http://127.0.0.1:12345/',
});
const npm = createNpmRegistry({
  upstreamBase: 'http://127.0.0.1:12345/',
  publicBase: 'http://127.0.0.1:12346/npm/',
});
const request = routeFetch(async (req, res) => {
  if (await registry.handle(req, res)) return;
  await npm.handle(req, res);
});
after(async () => {
  registry.copy.close();
  npm.copy.close();
  workspace.close();
  _resetDb();
  await rm(root, { recursive: true, force: true });
});

test(
  'Cargo pipeline schedules Rust packaging, publishes only its assigned version, records provenance, and skips a retry',
  { skip: spawnSync('cargo', ['--version']).status !== 0 },
  async () => {
    const source = join(root, 'repository');
    await mkdir(join(source, 'library/src'), { recursive: true });
    const git = async (args: string[]) =>
      (await exec('git', ['-C', source, ...args])).stdout.trim();
    await git(['init', '--initial-branch=main']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await git(['config', 'user.name', 'Fixture']);
    await writeFile(
      join(source, 'Cargo.toml'),
      '[workspace]\nmembers=["library"]\nresolver="2"\n[workspace.package]\nversion="1.0.0"\n',
    );
    await writeFile(
      join(source, 'library/Cargo.toml'),
      '[package]\nname="pipeline_crate"\nversion.workspace=true\nedition="2021"\n',
    );
    await writeFile(join(source, 'library/src/lib.rs'), 'pub fn value() -> u32 { 1 }');
    await git(['add', '.']);
    await git(['commit', '-m', 'A Cargo library']);
    const commit = await git(['rev-parse', 'HEAD']);
    const item = await packageAtCommit(source, commit, 'library');
    assert.equal(item.ecosystem, 'cargo');
    assert.equal(item.version, '1.0.0');
    save('project', 'owner', {
      id: 'project',
      owner: 'owner',
      name: 'Cargo project',
      defaultBranch: 'main',
      repositoryPath: source,
    });
    save('pipeline-run', 'owner', {
      id: 'run',
      projectId: 'project',
      status: 'succeeded',
      trigger: 'push',
      commit,
      specification: { publish: ['library'] },
    });
    await advancePipelinePackages('owner', 'run', npm.copy);
    const scheduled = get('pipeline-run', 'owner', 'run').packages.items[0];
    const job = { ...get('job', 'owner', scheduled.jobId), status: 'running', generation: 1 };
    save('job', 'owner', job);
    assert.equal(job.container, 'rust:1');
    assert.ok(job.requirements.capabilities.includes('docker'));
    assert.match(job.command, /cargo package --registry deploy-local/);
    assert.ok(!JSON.stringify(job).includes('dlp_'));
    const home = join(root, 'cargo-home');
    await mkdir(home);
    await writeFile(
      join(home, 'config.toml'),
      cargoConfig('http://127.0.0.1:12346') + '\n[net]\noffline=true\n',
    );
    await exec(
      'cargo',
      [
        'package',
        '--registry',
        'deploy-local',
        '--allow-dirty',
        '--target-dir',
        '.deploy-pipeline-package',
      ],
      { cwd: join(source, 'library'), env: { ...process.env, CARGO_HOME: home } },
    );
    await finishPackageJob(
      { ...job, packagePublish: { ...job.packagePublish, checkOnly: true } },
      source,
      async () => {
        throw Error('Packing must not request a publish token');
      },
    );
    const file = join(
      source,
      'library/.deploy-pipeline-package/package/pipeline_crate-1.0.0.crate',
    );
    const manifest = (await exec('tar', ['-xOf', file, 'pipeline_crate-1.0.0/Cargo.toml'])).stdout;
    const metadata = cargoMetadata(manifest, 'sparse+http://127.0.0.1:12346/cargo/index/');
    const bytes = await readFile(file);
    const token = issuePipelinePackageToken('owner', job);
    const send = async (meta: any) => {
      const chunks = [];
      for await (const chunk of cargoPublishBody(meta, file, bytes.length)) chunks.push(chunk);
      return request('http://127.0.0.1:12346/cargo/api/v1/crates/new', {
        method: 'PUT',
        headers: { Authorization: token },
        body: Buffer.concat(chunks) as any,
      });
    };
    assert.equal((await send({ ...metadata, vers: '2.0.0' })).status, 403);
    assert.equal(
      (
        await request('http://127.0.0.1:12346/npm/pipeline_crate', {
          method: 'PUT',
          headers: { Authorization: token },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await send(metadata)).status, 200);
    const pkg = packageByName('pipeline_crate', 'cargo')!;
    assert.equal(pkg.project_id, 'project');
    assert.equal(versions(pkg.id)[0].published_via, 'release');
    assert.equal(versions(pkg.id)[0].commit, commit);
    const list = await readPackages('owner', npm.copy, 'all');
    assert.ok(list.packages.some((row) => row.ecosystem === 'cargo'));
    assert.equal(
      (await readPackage('owner', 'pipeline_crate', false, 'cargo')).versions[0].pipeline.id,
      'run',
    );
    save('job', 'owner', { ...job, status: 'succeeded' });
    await advancePipelinePackages('owner', 'run', npm.copy);
    assert.equal(get('pipeline-run', 'owner', 'run').packages.items[0].status, 'published');
    assert.equal(pipelinePackageIdentity(token), null);
    save('pipeline-run', 'owner', {
      id: 'again',
      projectId: 'project',
      status: 'succeeded',
      trigger: 'push',
      commit,
      specification: { publish: ['library'] },
    });
    await advancePipelinePackages('owner', 'again', npm.copy);
    assert.equal(get('pipeline-run', 'owner', 'again').packages.items[0].status, 'skipped');
    save('pipeline-run', 'owner', {
      ...get('pipeline-run', 'owner', 'run'),
      status: 'succeeded',
      trigger: 'pull_request',
      packages: { status: 'running', items: [scheduled] },
    });
    save('job', 'owner', job);
    assert.throws(
      () => issuePipelinePackageToken('owner', job),
      /Only the repository owner's pipelines/,
    );
    assert.equal((await send({ ...metadata, vers: '2.0.0' })).status, 401);
  },
);

test('Cargo usage keeps private registry identities separate from crates.io', async () => {
  const { lockfileIndex } = await import('./lockfiles.ts');
  const index = lockfileIndex(
    'Cargo.lock',
    `version = 4
[[package]]
name = "shared"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
[[package]]
name = "shared"
version = "2.0.0"
source = "sparse+https://deploy.local/cargo/index/"
[[package]]
name = "also_private"
version = "3.0.0"
source = "registry+sparse+https://deploy.local/cargo/index/"
`,
  );
  assert.deepEqual(index.shared.versions, ['2.0.0']);
  assert.deepEqual(index.also_private.versions, ['3.0.0']);
});
