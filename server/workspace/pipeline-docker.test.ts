import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

// Run on a Linux Docker host. All application state and resources are disposable.
test(
  'pipeline checks publish pinned Git source through the real CI engine and retain the runtime receipt',
  { skip: process.env.PIPELINE_DOCKER_TEST !== '1', timeout: 300000 },
  async () => {
    const data = mkdtempSync(join(tmpdir(), 'pipeline-docker-'));
    process.env.DEPLOY_DATA_DIR = data;
    const app = 'pipeline-docker-' + Date.now();
    const macPilot = process.env.PIPELINE_MAC_PILOT_FILE;
    const nativeJob = macPilot
      ? '    mac-build:\n      needs: [check]\n      runsOn: {os: macos, capabilities: [swift]}\n      run: swiftc hello.swift -o hello && ./hello\n'
      : '';
    const yaml = `pipeline:\n  on: [manual]\n  jobs:\n    check:\n      runsOn: {os: linux}\n      container: busybox:1.37\n      run: test -f health && test -f index.html\n${nativeJob}  deploy:\n    application: ${app}\n`;
    const child = spawn(process.execPath, ['server/ci-test-fixture.mjs'], {
      env: { ...process.env, CI_REAL_DOCKER: '1', CI_FIXTURE_APP: app, CI_FIXTURE_PIPELINE: yaml },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let logs = '',
      imagePrefix = '',
      runner: any,
      workspace: any;
    const ids = new Set<string>();
    child.stdout!.on('data', (b) => {
      logs = (logs + b).slice(-30000);
    });
    child.stderr!.on('data', (b) => {
      logs = (logs + b).slice(-30000);
    });
    try {
      const info: any = await new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('exit', () => reject(new Error(logs)));
      });
      const origin = `http://127.0.0.1:${info.port}`;
      process.env.DEPLOY_PIPELINE_ORIGIN = origin;
      const headers = { 'x-deploy-username': 'ci-owner', 'x-deploy-token': info.ownerToken };
      if (macPilot) {
        const enrolled = await fetch(origin + '/api/workers/enroll', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workerId: 'mac-release-pilot',
            operationId: 'mac-release-enrollment',
          }),
        });
        assert.equal(enrolled.status, 200);
        writeFileSync(macPilot, JSON.stringify({ port: info.port, ...(await enrolled.json()) }), {
          mode: 0o600,
        });
      }
      const { pipelineSource, advancePipelineDeployment } =
        await import('./pipeline-deployment.ts');
      const { pipelineStart, reconcilePipelines } = await import('./pipelines.ts');
      const { createProject } = await import('./test-repository.ts');
      const { JobRunner } = await import('./job-runner.ts');
      const { jobCommand } = await import('./coordination.ts');
      const { refreshCapabilities } = await import('./worker-capabilities.ts');
      await refreshCapabilities();
      workspace = await import('./store.ts');
      const { get, db, now } = workspace;
      const source = join(data, 'source');
      mkdirSync(source);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', source, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(source, 'deploy.yaml'), info.manifest);
      writeFileSync(
        join(source, 'Dockerfile'),
        'FROM busybox:1.37\nWORKDIR /www\nCOPY health index.html /www/\nEXPOSE 3000\nCMD ["httpd","-f","-p","3000"]\n',
      );
      writeFileSync(join(source, 'health'), 'ok');
      if (macPilot)
        writeFileSync(
          join(source, 'hello.swift'),
          'print("Mac native check passed before Linux release")\n',
        );
      writeFileSync(join(source, 'index.html'), 'original');
      git('add', '.');
      git('commit', '-m', 'Initial');
      const initialSource = await pipelineSource(source, git('rev-parse', 'HEAD'));
      const form = new FormData();
      form.set('name', app);
      form.set('file', new Blob([new Uint8Array(initialSource.body)]), 'source.tar.gz');
      const initialResponse = await fetch(origin + '/api/upload', {
        method: 'POST',
        headers,
        body: form,
      });
      const initial: any = await initialResponse.json();
      if (initial.containerId) ids.add(initial.containerId);
      assert.equal(initialResponse.status, 201, JSON.stringify(initial) + logs);
      const before: any = await (
        await fetch(origin + '/api/deployments/' + app, { headers })
      ).json();
      const original = before.deployment || before;
      ids.add(original.containerId);
      imagePrefix = 'deploy-sh-' + original.appId + '-';
      writeFileSync(join(source, 'index.html'), 'pipeline-version');
      git('commit', '-am', 'Publish tested source');
      const commit = git('rev-parse', 'HEAD');
      const project = createProject('ci-owner', { name: app, sourcePath: source });
      const run = await pipelineStart(
        'ci-owner',
        project.id,
        { operationId: 'publish' },
        'publish',
      );
      db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run('local', process.pid, now());
      runner = new JobRunner(join(data, 'jobs'), async (action, body) =>
        jobCommand('ci-owner', 'local', action, { ...body, instanceId: 'pipeline-docker' }),
      );
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        reconcilePipelines();
        await runner.tick();
        await advancePipelineDeployment('ci-owner', run.id);
        const current = get('pipeline-run', 'ci-owner', run.id);
        if (['succeeded', 'failed', 'unknown'].includes(current.deployment.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const result = get('pipeline-run', 'ci-owner', run.id);
      if (result.deployment.receipt?.containerId) ids.add(result.deployment.receipt.containerId);
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(result.deployment.status, 'succeeded', JSON.stringify(result) + logs);
      assert.equal(result.deployment.receipt.sourceCommit, commit);
      assert.notEqual(result.deployment.receipt.containerId, original.containerId);
      if (process.env.PIPELINE_EVIDENCE_FILE)
        writeFileSync(
          process.env.PIPELINE_EVIDENCE_FILE,
          JSON.stringify(
            {
              pipeline: result,
              jobs: workspace
                .list('job', 'ci-owner')
                .filter((job: any) => job.pipelineId === run.id),
            },
            null,
            2,
          ),
        );
      const after: any = await (
        await fetch(origin + '/api/deployments/' + app, { headers })
      ).json();
      const deployed = after.deployment || after;
      assert.equal(
        await (await fetch(`http://127.0.0.1:${deployed.port}`)).text(),
        'pipeline-version',
      );
      const { getSqlite, _resetDb } = await import('../store.ts');
      assert.equal(
        (
          getSqlite()!
            .prepare('SELECT COUNT(*) AS count FROM ci_credentials WHERE revoked_at IS NULL')
            .get() as any
        ).count,
        0,
      );
      _resetDb();
    } finally {
      runner?.shutdown();
      if (child.exitCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
      workspace?.db.close();
      const rows = execFileSync('docker', ['ps', '-a', '--format', '{{.ID}} {{.Names}}'], {
        encoding: 'utf8',
      }).split('\n');
      for (const row of rows) {
        const [id, name] = row.split(' ');
        if (name?.includes(app) || (imagePrefix && name?.startsWith(imagePrefix))) ids.add(id);
      }
      for (const id of ids)
        if (id) {
          try {
            execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
          } catch {}
        }
      if (imagePrefix)
        for (const image of execFileSync(
          'docker',
          ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'],
          { encoding: 'utf8' },
        ).split('\n'))
          if (image.startsWith(imagePrefix)) {
            try {
              execFileSync('docker', ['image', 'rm', '-f', image], { stdio: 'ignore' });
            } catch {}
          }
      rmSync(data, { recursive: true, force: true });
    }
  },
);
