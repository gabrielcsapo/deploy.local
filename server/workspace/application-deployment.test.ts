import test, { after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import { Readable } from 'node:stream';
import { extract } from 'tar-stream';
import { captureSnapshot } from './checkpoint.ts';

const data = mkdtempSync(join(tmpdir(), 'deploy-agent-application-test-'));
process.env.DEPLOY_DATA_DIR = data;
const store = await import('../store.ts');
const workspace = await import('./store.ts');
const { registerApplicationIdentity } = await import('../local-site.ts');
const { checkpointBundle, deployApplication, waitForApplication, redactDeploymentLog } =
  await import('./application-deployment.ts');
const {
  issueAgentUpload,
  consumeAgentUpload,
  assertAgentApplication,
  recordAgentUpload,
  finishAgentUpload,
} = await import('../agent-upload.ts');
const { coordinationInstructions } = await import('./agent-launch.ts');
const { coordinationTools } = await import('./coordination-tools.ts');
const owner = 'agent-owner';
const scope = { owner, taskId: 'task-one', runId: 'run-one' };
workspace.save('task', owner, { id: scope.taskId, title: 'Deploy a test application' });

const manifest = (name: string) => `apiVersion: deploy.local/v1
kind: Application
metadata:
  name: ${name}
components:
  web:
    build:
      context: .
      ignore: [excluded]
    interfaces:
      http: { protocol: http, port: 3000 }
routes:
  public: { to: web.http }
`;
function snapshot(files: Record<string, string>) {
  const directory = join(data, randomUUID());
  mkdirSync(directory);
  execFileSync('git', ['init', '-q', directory]);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), content, { mode: file.endsWith('.sh') ? 0o755 : 0o644 });
  }
  return captureSnapshot(directory);
}
function checkpoint(name: string, source = manifest(name)) {
  return workspace.save('checkpoint', owner, {
    id: randomUUID(),
    taskId: scope.taskId,
    snapshot: snapshot({ 'deploy.yaml': source, Dockerfile: 'FROM scratch\n' }),
  });
}
function agentContext(application: string, deploymentRecordId = randomUUID()) {
  workspace.save('application-deployment', owner, { id: deploymentRecordId, taskId: scope.taskId });
  return { ...scope, application, taskTitle: 'Deploy a test application', deploymentRecordId };
}
function attempt(application: string) {
  store.registerDeploymentStart(application, owner, 'application-graph');
  registerApplicationIdentity(application);
  store.updateDeploymentArtifactDigests(application, {
    sourceArtifactDigest: `sha256:${'a'.repeat(64)}`,
  });
  const build = store.createBuildLog(application);
  store.updateCurrentBuildLogId(application, build);
  const context = agentContext(application);
  recordAgentUpload(context, build);
  return { build, context };
}
// Exercise real multipart encoding/decoding without requiring a listening socket.
async function listen(handler: RequestListener) {
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const request = new Request(input, options);
    assert.equal(new URL(request.url).hostname, '127.0.0.1');
    const req = Object.assign(Readable.from([Buffer.from(await request.arrayBuffer())]), {
      method: request.method,
      url: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;
    return new Promise<Response>((resolve, reject) => {
      let status = 200,
        headers = {};
      const res = {
        writeHead(code: number, values = {}) {
          status = code;
          headers = values;
          return res;
        },
        end(body: string) {
          resolve(new Response(body, { status, headers }));
        },
      } as unknown as ServerResponse;
      Promise.resolve(handler(req, res)).catch(reject);
    });
  });
  return { port: 7843 };
}
afterEach(() => mock.restoreAll());
const requestWith = (token: string, overrides: any = {}) =>
  ({
    method: 'POST',
    url: '/api/upload',
    headers: { 'x-deploy-internal-upload': token },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }) as IncomingMessage;

after(async () => {
  workspace.db.close();
  store.getSqlite()?.close();
  rmSync(data, { recursive: true, force: true });
});

test('checkpoint bundle selects the app root and reuses CLI excludes with executable contents', async () => {
  const source = snapshot({
    'app/deploy.yaml': manifest('bundle-app'),
    'app/Dockerfile': 'FROM scratch',
    'app/source.txt': 'real checkpoint contents',
    'app/run.sh': '#!/bin/sh\n',
    'app/excluded/omit.txt': 'omit',
    'app/node_modules/omit.txt': 'omit',
    'outside.txt': 'outside',
    '.env': 'secret',
  });
  const bundle = await checkpointBundle(source, 'app', 'bundle-app');
  assert.equal(bundle.application, 'bundle-app');
  const entries: Record<string, string> = {};
  const archive = extract();
  archive.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = [];
    if (header.name === 'run.sh') assert.ok(header.mode! & 0o100);
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('end', () => {
      entries[header.name] = Buffer.concat(chunks).toString();
      next();
    });
    stream.resume();
  });
  const finished = new Promise<void>((resolve, reject) => {
    archive.on('finish', resolve);
    archive.on('error', reject);
  });
  archive.end(gunzipSync(bundle.body));
  await finished;
  assert.deepEqual(Object.keys(entries).sort(), [
    'Dockerfile',
    'deploy.yaml',
    'run.sh',
    'source.txt',
  ]);
  assert.equal(entries['source.txt'], 'real checkpoint contents');
  await assert.rejects(checkpointBundle(source), /deploy.yaml is required/);
  await assert.rejects(checkpointBundle(source, 'app', 'wrong-name'), /must match/);
  for (const path of ['../app', '/app', 'app/../../', 'app\\nested'])
    await assert.rejects(checkpointBundle(source, path), /checkpoint subdirectory/);
  await assert.rejects(
    checkpointBundle(snapshot({ 'deploy.yaml': 'apiVersion: invalid' })),
    /deploy.yaml/,
  );
});

test('capability is short-lived, single-use, loopback-only and upload-only', () => {
  const context = agentContext('capability-app');
  const first = issueAgentUpload(context);
  assert.throws(
    () => consumeAgentUpload(requestWith(first.token, { socket: { remoteAddress: '192.0.2.4' } })),
    /Invalid internal/,
  );
  assert.throws(
    () => consumeAgentUpload(requestWith(first.token, { url: '/api/deployments' })),
    /Invalid internal/,
  );
  assert.throws(
    () => consumeAgentUpload(requestWith(first.token, { method: 'GET' })),
    /Invalid internal/,
  );
  assert.deepEqual(consumeAgentUpload(requestWith(first.token)), context);
  assert.throws(() => consumeAgentUpload(requestWith(first.token)), /Invalid internal/);
  const expired = issueAgentUpload(context),
    original = Date.now;
  try {
    Date.now = () => original() + 61000;
    assert.throws(() => consumeAgentUpload(requestWith(expired.token)), /Invalid internal/);
  } finally {
    Date.now = original;
    expired.close();
  }
  const revoked = issueAgentUpload(context);
  revoked.close();
  assert.throws(() => consumeAgentUpload(requestWith(revoked.token)), /Invalid internal/);
});

test('upload capabilities cross the coordinator worker process boundary and remain single-use', () => {
  const context = agentContext('cross-process-app');
  const token = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { issueAgentUpload } = await import('./server/agent-upload.ts');
    const { db } = await import('./server/workspace/store.ts');
    process.stdout.write(issueAgentUpload(${JSON.stringify(context)}).token);
    db.close();
  `,
    ],
    { encoding: 'utf8', env: process.env },
  );
  assert.deepEqual(consumeAgentUpload(requestWith(token)), context);
  assert.throws(() => consumeAgentUpload(requestWith(token)), /Invalid internal/);
});

test('ownership permits a new app and this task, refuses other tasks/owners and later manual deployments', () => {
  assert.doesNotThrow(() => assertAgentApplication({ ...scope, application: 'brand-new' }));
  const { build, context } = attempt('owned-app');
  assert.doesNotThrow(() => assertAgentApplication(context));
  store.updateDeploymentStatus('owned-app', 'failed');
  assert.doesNotThrow(() => assertAgentApplication(context)); // fix a failed first deploy
  store.updateDeploymentStatus('owned-app', 'running');
  finishAgentUpload(context);
  assert.equal(workspace.get('application-origin', owner, 'owned-app').status, 'running');
  assert.throws(
    () => assertAgentApplication({ ...context, taskId: 'another-task' }),
    /deploy_ask_user.*do not pick/,
  );
  assert.throws(
    () => assertAgentApplication({ ...context, owner: 'another-owner' }),
    /deploy_ask_user/,
  );
  store.updateCurrentBuildLogId('owned-app', build + 1);
  assert.throws(() => assertAgentApplication(context), /not last deployed/);
  store.updateCurrentBuildLogId('owned-app', build);
  store.updateDeploymentArtifactDigests('owned-app', {
    sourceArtifactDigest: `sha256:${'b'.repeat(64)}`,
  });
  assert.throws(() => assertAgentApplication(context), /not last deployed/);
  store.registerDeploymentStart('manual-app', owner, 'application-graph');
  assert.throws(
    () => assertAgentApplication({ ...scope, application: 'manual-app' }),
    /not last deployed/,
  );
});

test('waiter follows the exact detached build, rejects failed/configuration/superseded attempts and times out', async () => {
  const states = [
    { currentBuildLogId: 7, status: 'uploading', buildStatus: 'building' },
    { currentBuildLogId: 7, status: 'starting', buildStatus: 'building' },
    { currentBuildLogId: 7, status: 'running', buildStatus: 'complete' },
  ];
  await waitForApplication('app', 7, { intervalMs: 0, read: () => states.shift()! });
  for (const status of ['failed', 'configuration-required'])
    await assert.rejects(
      waitForApplication('app', 7, {
        read: () => ({ currentBuildLogId: 7, status, buildStatus: 'failed' }),
      }),
      /Deployment/,
    );
  await assert.rejects(
    waitForApplication('app', 7, {
      read: () => ({ currentBuildLogId: 8, status: 'running', buildStatus: 'complete' }),
    }),
    /superseded/,
  );
  await assert.rejects(
    waitForApplication('app', 7, {
      timeoutMs: 0,
      intervalMs: 0,
      read: () => ({ currentBuildLogId: 7, status: 'building', buildStatus: 'building' }),
    }),
    /Timed out/,
  );
});

test('deploy_application returns real build identity, shares concurrent retries, and appends one compact transcript attachment', async () => {
  store.ensureCoordinatorNode();
  store.setDefaultNode('coordinator');
  const source = checkpoint('result-app');
  let uploads = 0;
  const { port } = await listen(async (req, res) => {
    try {
      const context = consumeAgentUpload(req)!;
      assert.equal(context.owner, owner);
      assert.equal(context.taskId, scope.taskId);
      assert.equal(req.headers['x-deploy-token'], undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'Content-Type': req.headers['content-type']! },
      }).formData();
      assert.deepEqual([...form.keys()].sort(), ['detached', 'file', 'name']);
      assert.equal(form.get('detached'), '1');
      assert.equal(form.get('name'), 'result-app');
      uploads++;
      store.registerDeploymentStart(context.application, owner, 'application-graph');
      registerApplicationIdentity(context.application);
      const build = store.createBuildLog(context.application);
      store.updateCurrentBuildLogId(context.application, build);
      recordAgentUpload(context, build);
      store.updateDeploymentStatus(context.application, 'running');
      store.completeBuildLog(build, { success: true, duration: 1 });
      finishAgentUpload(context);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, buildLogId: build }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  process.env.CONTROL_PORT = String(port);
  const args = { operationId: randomUUID(), checkpointId: source.id };
  const [result, retry] = await Promise.all([
    deployApplication(scope, args),
    deployApplication(scope, args),
  ]);
  assert.deepEqual(retry, result);
  assert.equal(result.status, 'running');
  assert.equal(result.url, 'https://result-app.local');
  assert.deepEqual(result.routes, [
    { name: 'public', to: 'web.http', url: 'https://result-app.local/' },
  ]);
  assert.ok(Number(result.deploymentId) > 0);
  assert.equal(result.logTail, undefined);
  assert.deepEqual(await deployApplication(scope, args), result);
  assert.equal(uploads, 1);
  await assert.rejects(
    deployApplication(scope, { ...args, name: 'different' }),
    /different command/,
  );
  const attachments = workspace
    .list('message', owner)
    .filter((m) => m.deployment?.application === 'result-app');
  assert.equal(attachments.length, 1);
  assert.match(attachments[0].content, /result-app.*running/);
  assert.match(
    attachments[0].content,
    /View logs.*https:\/\/deploy.local\/dashboard\/result-app\/build/,
  );
  await assert.rejects(
    deployApplication({ ...scope, taskId: 'wrong-task' }, { ...args, operationId: randomUUID() }),
    /another task/,
  );
});

test('admission and confirmation failures are surfaced without confirmations or credential exposure', async () => {
  const source = checkpoint('rejected-app');
  for (const reason of [
    'Destructive repository application changes require --confirm-destructive',
    'Every selected suitcase must sync and acknowledge this exact revision',
    'Choose a default deployment computer in Computers before deploying.',
  ]) {
    const { port } = await listen(async (req, res) => {
      consumeAgentUpload(req);
      for await (const _ of req) {
        /* drain upload */
      }
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: reason }));
    });
    process.env.CONTROL_PORT = String(port);
    const result = await deployApplication(scope, {
      checkpointId: source.id,
      operationId: randomUUID(),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.deploymentId, null);
    assert.match(result.logTail!, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('failure returns only a bounded redacted log tail from the exact build', async () => {
  const source = checkpoint('failure-app');
  const { port } = await listen(async (req, res) => {
    const context = consumeAgentUpload(req)!;
    for await (const _ of req) {
      /* drain upload */
    }
    store.registerDeploymentStart(context.application, owner, 'application-graph');
    const build = store.createBuildLog(context.application);
    store.updateCurrentBuildLogId(context.application, build);
    recordAgentUpload(context, build);
    store.updateDeploymentSettings(context.application, {
      envVars: { RUNTIME_TOKEN: 'opaque-runtime-value' },
    });
    writeFileSync(
      store.buildLogFilePath(build),
      Array.from(
        { length: 100 },
        (_, n) => `line ${n} token=private-token opaque-runtime-value`,
      ).join('\n'),
    );
    store.updateDeploymentStatus(context.application, 'failed');
    store.completeBuildLog(build, { success: false, duration: 1 });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, buildLogId: build }));
  });
  process.env.CONTROL_PORT = String(port);
  const result = await deployApplication(scope, {
    operationId: randomUUID(),
    checkpointId: source.id,
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.deploymentId);
  assert.match(result.logTail!, /line 99 token=\[redacted\]/);
  assert.doesNotMatch(result.logTail!, /private-token|opaque-runtime-value|line 0 /);
  assert.ok(result.logTail!.split('\n').length <= 61);
  assert.equal(
    redactDeploymentLog('opaque sensitive-value https://user:pass@host token=abc', [
      'sensitive-value',
    ]),
    'opaque [redacted] https://[redacted]@host token=[redacted]',
  );
});

test('deployment instructions and tool schema teach the complete deploy and cross-computer verification flow', () => {
  const tool = coordinationTools.find((entry) => entry.name === 'deploy_application')!;
  assert.deepEqual(tool.inputSchema.required, ['operationId', 'checkpointId']);
  for (const text of [coordinationInstructions, tool.description])
    for (const guidance of [
      'deploy_application',
      'deploy.yaml',
      'apiVersion: deploy.local/v1',
      'kind: Application',
      'context: .',
      'to: web.http',
      'Dockerfile',
      'configuration',
      'multiple components',
      'deploy_checkpoint',
      'deploy_run_job',
      'system CA',
      'logTail',
      'deploy_ask_user',
      'sudo',
      'systemd',
    ])
      assert.ok(text.includes(guidance), `Missing ${guidance}`);
});

test('actual upload handler enforces scoped fields, placement and destructive confirmation before deployment', async () => {
  const { apiMiddleware } = await import('../api.ts');
  const { stopMetricsCollector } = await import('../metrics-collector.ts');
  const { stopDockerEventStream } = await import('../docker.ts');
  const { stopStatsMonitor } = await import('../docker-api.ts');
  const { compileDeployYaml } = await import('../application-spec.ts');
  const api = apiMiddleware();
  try {
    await listen((req, res) => {
      void api(req, res, () => {
        res.writeHead(404);
        res.end('{}');
      });
    });
    async function directUpload(
      application: string,
      fields: Record<string, string> = {},
      bundle?: Buffer,
      pipeline = false,
      headers: Record<string, string> = {},
    ) {
      const projectId = 'pipeline-project';
      const pipelineId = randomUUID();
      if (pipeline) {
        workspace.save('project', owner, { id: projectId, owner });
        workspace.save('pipeline-run', owner, { id: pipelineId, projectId });
      }
      const context = pipeline
        ? { owner, projectId, pipelineId, application, deploymentRecordId: pipelineId }
        : agentContext(application);
      const capability = issueAgentUpload(context);
      const form = new FormData();
      form.set('name', application);
      form.set('detached', '1');
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      form.set(
        'file',
        new Blob([new Uint8Array(bundle || Buffer.from('invalid'))]),
        'source.tar.gz',
      );
      return fetch('http://127.0.0.1:7843/api/upload', {
        method: 'POST',
        headers: { 'x-deploy-internal-upload': capability.token, ...headers },
        body: form,
      });
    }
    for (const fields of [
      { name: 'another-name' },
      { confirmDestructive: '1' },
      { revisionResolution: 'replace' },
    ] as Record<string, string>[]) {
      const response = await directUpload('scoped-app', fields);
      assert.equal(response.status, 403);
      assert.match(((await response.json()) as any).error, /scoped to one application/);
    }
    const pipelineConfirmation = await directUpload(
      'pipeline-scoped',
      { confirmDestructive: '1' },
      undefined,
      true,
    );
    assert.equal(pipelineConfirmation.status, 403);
    const spoof = await directUpload('pipeline-scoped', {}, undefined, true, {
      'x-deploy-project-id': 'pipeline-project',
    });
    assert.equal(spoof.status, 403);
    assert.match(((await spoof.json()) as any).error, /authenticated manual upload/);
    store.setSystemSetting('default_node_id', '');
    const pipelinePlacement = await directUpload('pipeline-scoped', {}, undefined, true);
    assert.equal(pipelinePlacement.status, 428);
    const placement = await directUpload('unplaced-app');
    assert.equal(placement.status, 428);
    assert.match(((await placement.json()) as any).error, /default deployment computer/);
    store.setDefaultNode('coordinator');

    const name = 'destructive-app';
    attempt(name);
    const baseline =
      manifest(name) +
      '\nresources:\n  archive:\n    type: volume\n    durability: durable\n    dataRole: files\n';
    const compiled = compileDeployYaml(baseline);
    store.saveDesiredApplicationSpec({
      digest: compiled.digest,
      deploymentName: name,
      apiVersion: compiled.spec.apiVersion,
      source: 'repository',
      manifestFormat: 'deploy.yaml',
      normalizedSpec: compiled.canonicalJson,
      originalSource: baseline,
      createdBy: owner,
    });
    const source = checkpoint(name, `# deploy.local/base: ${compiled.digest}\n${manifest(name)}`);
    const result = await deployApplication(scope, {
      operationId: randomUUID(),
      checkpointId: source.id,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.deploymentId, null);
    assert.match(
      result.logTail!,
      /Destructive repository application changes require --confirm-destructive/,
    );
    assert.equal(store.readDeploymentRecord(name)!.desiredSpecDigest, compiled.digest);
    assert.equal(
      store.readDeploymentRecord(name)!.sourceArtifactDigest,
      `sha256:${'a'.repeat(64)}`,
    );
  } finally {
    stopMetricsCollector();
    // Let a failed local Docker probe settle before stopping its reconnect timer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopDockerEventStream();
    // On a machine running Docker this holds one stats stream per running container.
    stopStatsMonitor();
  }
});

test('provider continuation waits through pending results and transient outages using the identical operation', async () => {
  const { continueApplication } = await import('./application-continuation.ts');
  const args = { operationId: 'same-reservation', checkpointId: 'same-checkpoint' };
  let calls = 0;
  const result = {
    status: 'running',
    url: 'https://continued-app.local',
    routes: [],
    deploymentId: '12',
  };
  assert.deepEqual(
    await continueApplication(
      args,
      { pending: true },
      async (next) => {
        assert.deepEqual(next, args);
        calls++;
        if (calls === 1) throw new Error('temporary transport failure');
        return calls === 2 ? { pending: true } : result;
      },
      { wait: async () => {} },
    ),
    result,
  );
  assert.equal(calls, 3);
  await assert.rejects(
    continueApplication(
      args,
      { pending: true },
      async () => {
        throw Object.assign(new Error('Agent credential revoked'), { status: 401 });
      },
      { wait: async () => {} },
    ),
    /revoked/,
  );
});

test('lost upload responses and coordinator restarts recover the exact known build without uploading twice', async () => {
  const source = checkpoint('lost-response-app');
  let calls = 0;
  await listen(async (req) => {
    calls++;
    const context = consumeAgentUpload(req)!;
    store.registerDeploymentStart(context.application, owner, 'application-graph');
    const build = store.createBuildLog(context.application);
    store.updateCurrentBuildLogId(context.application, build);
    recordAgentUpload(context, build);
    store.updateDeploymentStatus(context.application, 'running');
    store.completeBuildLog(build, { success: true, duration: 1 });
    throw new Error('Connection lost after upload was accepted');
  });
  const result = await deployApplication(scope, {
    operationId: randomUUID(),
    checkpointId: source.id,
  });
  assert.equal(result.status, 'running');
  assert.equal(calls, 1);

  mock.restoreAll();
  mock.method(globalThis, 'fetch', () => {
    throw new Error('Must not upload a recovered reservation');
  });
  for (const known of [true, false]) {
    const args = { operationId: randomUUID(), checkpointId: source.id };
    const signature = createHash('sha256')
      .update(JSON.stringify({ taskId: scope.taskId, tool: 'deploy_application', args }))
      .digest('hex');
    workspace.command(
      owner,
      args.operationId,
      () =>
        workspace.save('application-deployment', owner, {
          id: randomUUID(),
          taskId: scope.taskId,
          checkpointId: source.id,
          application: 'lost-response-app',
          startedAt: new Date().toISOString(),
          ...(known ? { buildLogId: Number(result.deploymentId) } : {}),
        }),
      signature,
    );
    const recovered = await deployApplication(scope, args);
    assert.equal(recovered.status, known ? 'running' : 'failed');
    if (known) assert.equal(recovered.deploymentId, result.deploymentId);
    else assert.match(recovered.logTail!, /interrupted during upload.*will not upload twice/);
  }
});
