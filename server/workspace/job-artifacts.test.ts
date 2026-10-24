import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { captureSnapshot } from './checkpoint.ts';
import { JobRunner } from './job-runner.ts';
import { resolveArtifacts, collectJobArtifacts } from './job-artifact-collect.ts';
import { artifactLimits, artifactRequests, matchesArtifactRequest } from './job-artifact-spec.ts';

const data = mkdtempSync(join(tmpdir(), 'deploy-job-artifacts-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { db, get, save, list, now } = await import('./store.ts');
const { coordinationTool, issueAgentToken, jobCommand } = await import('./coordination.ts');
const { coordinationApi } = await import('./coordination-api.ts');
const { enrollWorker, workerAuthentication } = await import('./credentials.ts');
const { workspaceApi } = await import('./api.ts');
const { createTask } = await import('./test-repository.ts');
const { startRun } = await import('./service.ts');
const { attachmentBytes } = await import('./attachments.ts');
const { receiveJobArtifact, readJobArtifact, redactArtifactText } =
  await import('./job-artifacts.ts');
const { workerCommand } = await import('./protocol.ts');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=',
  'base64',
);
const owner = 'artifact-test';
const task = createTask(owner, { title: 'Bring back simulator screenshots' });
writeFileSync(join(task.workspacePath, 'pixel.png'), png);
const run = startRun(owner, task.id, { revision: 0, content: 'Capture the home screen' });
save('run', owner, { ...run, status: 'running' });
const scope = { owner, taskId: task.id, runId: run.id };
const token = issueAgentToken(scope);
const tool = (name: string, args: any = {}) => coordinationTool(scope, name, args);
const operation = () => randomUUID();
const checkpoint = tool('deploy_checkpoint', {
  operationId: operation(),
  snapshot: captureSnapshot(task.workspacePath),
});
async function until(check: () => any | Promise<any>, timeout = 20000): Promise<any> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timed out waiting for condition');
}
const register = (workerId: string, capabilities: string[], workerPlatform = 'darwin') =>
  workerCommand(owner, '/workers/register', {
    workerId,
    instanceId: workerId,
    name: workerId,
    platform: workerPlatform,
    architecture: 'arm64',
    capabilities,
    checkpointJobs: true,
  });
const allowedKeys = new Set([
  'path',
  'name',
  'caption',
  'attachmentId',
  'kind',
  'bytes',
  'skipped',
]);
after(() => {
  db.close();
  rmSync(data, { recursive: true, force: true });
});

test('artifact requests are relative, bounded and glob matching stays inside a folder', () => {
  assert.deepEqual(artifactRequests(undefined), []);
  assert.deepEqual(artifactRequests([{ path: './shots/*.png', caption: ' Home ' }]), [
    { path: 'shots/*.png', caption: 'Home' },
  ]);
  for (const path of ['/etc/passwd', '../secret.txt', 'a/../../b', 'a//b', '~/x', 'a\\b', ''])
    assert.throws(() => artifactRequests([{ path }]), /artifact path|inside the job/i, path);
  assert.throws(() => artifactRequests([{ path: 'a', extra: 1 }]), /only path and caption/);
  assert.throws(
    () => artifactRequests(Array.from({ length: 21 }, (_, i) => ({ path: `f${i}` }))),
    /at most 20/,
  );
  assert.throws(() => artifactRequests([{ path: '**/a/**/b' }]), /at most one \*\*/);
  const requests = [{ path: 'shots/*.png' }, { path: 'logs/**' }, { path: 'report.xml' }];
  assert.ok(matchesArtifactRequest('shots/home.png', requests));
  assert.ok(!matchesArtifactRequest('shots/nested/home.png', requests));
  assert.ok(matchesArtifactRequest('logs/a/b/c.log', requests));
  assert.ok(matchesArtifactRequest('report.xml', requests));
  assert.ok(!matchesArtifactRequest('reportxxml', requests));
  assert.ok(!matchesArtifactRequest('source.txt', requests));
});

test('worker resolution follows globs, refuses symlink escapes and reports skipped reasons', () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-artifact-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'deploy-artifact-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  mkdirSync(join(root, 'shots'));
  mkdirSync(join(root, 'logs/ios'), { recursive: true });
  writeFileSync(join(root, 'shots/a.png'), png);
  writeFileSync(join(root, 'shots/b.png'), png);
  writeFileSync(join(root, 'shots/readme.txt'), 'x');
  writeFileSync(join(root, 'logs/ios/build.log'), 'ok');
  symlinkSync(join(root, 'shots/a.png'), join(root, 'latest.png'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'shots/escape.png'));
  symlinkSync(outside, join(root, 'linked-dir'));
  const { files, skipped } = resolveArtifacts(root, [
    { path: 'shots/*.png', caption: 'Screens' },
    { path: '**/*.log' },
    { path: 'latest.png' },
    { path: 'escape.txt' },
    { path: 'linked-dir/secret.txt' },
    { path: 'linked-dir/*.txt' },
    { path: 'missing.txt' },
    { path: 'nothing/*.png' },
    { path: 'shots' },
  ]);
  // latest.png resolves to shots/a.png, already returned by the glob.
  assert.deepEqual(
    files.map((file) => [file.path, file.caption]),
    [
      ['shots/a.png', 'Screens'],
      ['shots/b.png', 'Screens'],
      ['logs/ios/build.log', ''],
    ],
  );
  const reasons: Record<string, string> = Object.fromEntries(
    skipped.map((entry) => [entry.path, entry.skipped!]),
  );
  assert.match(reasons['shots/escape.png'], /outside the job directory/);
  assert.match(reasons['escape.txt'], /outside the job directory/);
  assert.match(reasons['linked-dir/secret.txt'], /outside the job directory/);
  assert.match(reasons['linked-dir/*.txt'], /outside the job directory/);
  assert.equal(reasons['missing.txt'], 'File not found');
  assert.equal(reasons['nothing/*.png'], 'No files matched');
  assert.equal(reasons['shots'], 'Not a regular file');
});

test('worker caps apply per file, per job and per count, and failures become skipped entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-artifact-caps-'));
  mkdirSync(join(root, 'many'));
  for (let i = 0; i < 22; i++)
    writeFileSync(join(root, `many/${String(i).padStart(2, '0')}.png`), png);
  writeFileSync(join(root, 'big.log'), Buffer.alloc(artifactLimits.textBytes + 1, 'a'));
  writeFileSync(join(root, 'empty.txt'), '');
  writeFileSync(join(root, 'tool.bin'), Buffer.from([0, 1, 2, 3, 4]));
  writeFileSync(join(root, 'rejected.txt'), 'nope');
  const uploads: string[] = [];
  const results = await collectJobArtifacts(
    root,
    [{ path: 'many/*.png' }, { path: 'big.log' }, { path: 'empty.txt' }, { path: 'tool.bin' }],
    async (file, body) => {
      for await (const _ of body);
      uploads.push(file.path);
      return { ...file, attachmentId: randomUUID(), kind: 'image', bytes: file.size };
    },
    new AbortController().signal,
  );
  assert.equal(uploads.length, 20);
  const skipped: Record<string, string> = Object.fromEntries(
    results.filter((r) => r.skipped).map((entry) => [entry.path, entry.skipped!]),
  );
  assert.match(skipped['many/20.png'], /20 files per job/);
  assert.match(skipped['many/21.png'], /20 files per job/);
  assert.match(skipped['big.log'], /limit for this kind is 5 MB/);
  assert.equal(skipped['empty.txt'], 'File is empty');
  assert.match(skipped['tool.bin'], /Unsupported file type/);
  const refused = await collectJobArtifacts(
    root,
    [{ path: 'rejected.txt' }],
    async (_file, body) => {
      for await (const _ of body);
      throw new Error('Coordinator refused it');
    },
    new AbortController().signal,
  );
  assert.equal(refused[0].skipped, 'Coordinator refused it');
  const cancelled = new AbortController();
  cancelled.abort();
  const late = await collectJobArtifacts(
    root,
    [{ path: 'rejected.txt' }],
    async () => {
      throw new Error('not called');
    },
    cancelled.signal,
  );
  assert.match(late[0].skipped!, /cancelled or timed out/);
  const jobBytes = artifactLimits.jobBytes;
  artifactLimits.jobBytes = png.length * 2;
  try {
    const capped = await collectJobArtifacts(
      root,
      [{ path: 'many/0*.png' }],
      async (file, body) => {
        for await (const _ of body);
        return { ...file, attachmentId: randomUUID(), kind: 'image', bytes: file.size };
      },
      new AbortController().signal,
    );
    assert.equal(capped.filter((r) => r.attachmentId).length, 2);
    assert.match(capped.find((r) => r.skipped)!.skipped!, /Per-job artifact limit/);
  } finally {
    artifactLimits.jobBytes = jobBytes;
  }
  const missingUploader = await collectJobArtifacts(
    root,
    [{ path: 'many/00.png' }],
    undefined,
    new AbortController().signal,
  );
  assert.match(missingUploader[0].skipped!, /cannot upload/);
});

test('local jobs return artifacts on failure, linked to the task, run and job, with redacted text', async () => {
  db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run('local', process.pid, now());
  const instanceId = operation();
  const runner = new JobRunner(
    join(data, 'local-jobs'),
    async (action, body) => jobCommand(owner, 'local', action, { ...body, instanceId }),
    undefined,
    {
      uploadArtifact: (job, file, body) =>
        receiveJobArtifact(
          body,
          owner,
          'local',
          job.id,
          new URLSearchParams({
            generation: job.generation,
            path: file.path,
            caption: file.caption,
          }),
          instanceId,
        ),
    },
  );
  const timer = setInterval(() => void runner.tick(), 40);
  try {
    const job = tool('deploy_run_job', {
      checkpointId: checkpoint.checkpointId,
      workerId: 'local',
      label: 'Capture screenshots',
      command: [
        'mkdir -p shots',
        'cp pixel.png shots/home.png',
        'cp pixel.png shots/detail.png',
        `printf 'build ok\\npassword=hunter2\\n{"token": "abc"}\\nghp_abcdefghijklmnopqrstuvwxyz123456\\n' > build.log`,
        'ln -s /etc/hosts hosts.txt',
        'exit 3',
      ].join('\n'),
      artifacts: [
        { path: 'shots/*.png', caption: 'Simulator' },
        { path: 'build.log', caption: 'Build log' },
        { path: 'hosts.txt' },
        { path: 'missing.json' },
      ],
      operationId: operation(),
    });
    assert.deepEqual(job.artifacts, []);
    assert.equal(job.artifactPaths.length, 4);
    const done = await until(() => {
      const row = get('job', owner, job.id);
      return row.status === 'failed' && row;
    });
    assert.equal(done.exitCode, 3);
    const stored = done.artifacts.filter((entry: any) => entry.attachmentId);
    assert.deepEqual(stored.map((entry: any) => [entry.path, entry.kind, entry.caption]).sort(), [
      ['build.log', 'file', 'Build log'],
      ['shots/detail.png', 'image', 'Simulator'],
      ['shots/home.png', 'image', 'Simulator'],
    ]);
    const skipped = Object.fromEntries(
      done.artifacts.filter((e: any) => e.skipped).map((e: any) => [e.path, e.skipped]),
    );
    assert.match(skipped['hosts.txt'], /outside the job directory/);
    assert.equal(skipped['missing.json'], 'File not found');
    for (const entry of stored) {
      const attachment = get('attachment', owner, entry.attachmentId);
      assert.equal(attachment.source, 'job-artifact');
      assert.equal(attachment.taskId, task.id);
      assert.equal(attachment.runId, run.id);
      assert.equal(attachment.jobId, job.id);
      assert.equal(attachment.size, entry.bytes);
    }
    const log = get(
      'attachment',
      owner,
      stored.find((e: any) => e.path === 'build.log').attachmentId,
    );
    assert.equal(log.mimeType, 'text/plain; charset=utf-8');
    const text = attachmentBytes(owner, log.id).data.toString('utf8');
    assert.match(text, /build ok/);
    for (const secret of ['hunter2', '"abc"', 'ghp_abcdefghijklmnopqrstuvwxyz123456'])
      assert.ok(!text.includes(secret), secret);
    assert.ok(log.preview.startsWith('build ok'));
    // Tool results are references only.
    const result = tool('deploy_get_job', { jobId: job.id });
    for (const entry of result.artifacts)
      for (const key of Object.keys(entry)) assert.ok(allowedKeys.has(key), key);
    assert.ok(!JSON.stringify(result.artifacts).includes('build ok'));
    assert.ok(!JSON.stringify(result.artifacts).includes(png.toString('base64').slice(0, 20)));
    // Excerpts are bounded, text-only and task-scoped.
    const excerpt = readJobArtifact(scope, { attachmentId: log.id, maxBytes: 5 });
    assert.deepEqual(
      [excerpt.text, excerpt.offset, excerpt.bytes, excerpt.nextOffset, excerpt.totalBytes],
      ['build', 0, 5, 5, log.size],
    );
    const rest = readJobArtifact(scope, { attachmentId: log.id, offset: excerpt.nextOffset });
    assert.equal(rest.nextOffset, null);
    assert.equal(excerpt.text + rest.text, text);
    for (const maxBytes of [0, 16385, 1.5, '10'])
      assert.throws(() => readJobArtifact(scope, { attachmentId: log.id, maxBytes }), /maxBytes/);
    assert.throws(() => readJobArtifact(scope, { attachmentId: log.id, offset: -1 }), /offset/);
    const image = stored.find((e: any) => e.kind === 'image').attachmentId;
    assert.throws(() => readJobArtifact(scope, { attachmentId: image }), /Only text job artifacts/);
    const other = createTask(owner, { title: 'Another conversation' });
    assert.throws(
      () => readJobArtifact({ ...scope, taskId: other.id }, { attachmentId: log.id }),
      /another task/,
    );
  } finally {
    clearInterval(timer);
    runner.stop();
  }
});

test('upload endpoint caps, type checks and refusals for unrequested paths', async () => {
  register('caps-mac', ['job-artifacts']);
  const job = save('job', owner, {
    id: randomUUID(),
    taskId: task.id,
    runId: run.id,
    checkpointId: checkpoint.checkpointId,
    digest: 'x',
    workerId: 'caps-mac',
    generation: 'generation-1',
    instanceId: 'caps-mac',
    status: 'running',
    command: 'true',
    artifactPaths: [{ path: '*.png' }, { path: '*.log' }, { path: 'tool.bin' }],
    artifacts: [],
    output: '',
    truncated: false,
    createdAt: now(),
    updatedAt: now(),
  });
  const send = (path: string, bytes: Buffer, extra: Record<string, string> = {}) =>
    receiveJobArtifact(
      Readable.from([bytes]),
      owner,
      extra.worker || 'caps-mac',
      job.id,
      new URLSearchParams({ generation: extra.generation || 'generation-1', path }),
      extra.instance || 'caps-mac',
    );
  await assert.rejects(send('other.txt', Buffer.from('x')), /not requested/);
  await assert.rejects(send('a.png', png, { instance: 'restarted' }), /not assigned/);
  await assert.rejects(send('a.png', png, { generation: 'old' }), /not assigned/);
  await assert.rejects(send('a.png', png, { worker: 'someone-else' }), /not assigned/);
  await assert.rejects(send('tool.bin', Buffer.from([0, 1, 2])), (error: any) => {
    assert.equal(error.status, 415);
    return true;
  });
  await assert.rejects(send('bad.log', Buffer.from([0xff, 0xfe, 0x00])), /UTF-8/);
  const fileBytes = artifactLimits.fileBytes;
  artifactLimits.fileBytes = 10;
  try {
    await assert.rejects(send('big.png', png), (error: any) => error.status === 413);
  } finally {
    artifactLimits.fileBytes = fileBytes;
  }
  const first = await send('a.png', png);
  assert.equal(first.kind, 'image');
  assert.deepEqual(await send('a.png', png), first);
  const files = artifactLimits.files;
  artifactLimits.files = 1;
  try {
    await assert.rejects(send('b.log', Buffer.from('later')), /1 files per job/);
  } finally {
    artifactLimits.files = files;
  }
  save('job', owner, { ...get('job', owner, job.id), status: 'succeeded' });
  await assert.rejects(send('c.log', Buffer.from('late')), /not assigned/);
  const plain = save('job', owner, {
    ...get('job', owner, job.id),
    status: 'running',
    artifactPaths: undefined,
  });
  await assert.rejects(
    receiveJobArtifact(
      Readable.from([png]),
      owner,
      'caps-mac',
      plain.id,
      new URLSearchParams({ generation: 'generation-1', path: 'a.png' }),
      'caps-mac',
    ),
    /did not request artifacts/,
  );
  assert.match(redactArtifactText('Authorization: Bearer abcdefghijkl'), /\[redacted\]/);
});

test('older workers get a clear update error and never claim artifact jobs', () => {
  register('old-mac', ['xcode']);
  const base = {
    checkpointId: checkpoint.checkpointId,
    command: 'true',
    artifacts: [{ path: 'shots/*.png' }],
  };
  assert.throws(
    () => tool('deploy_run_job', { ...base, workerId: 'old-mac', operationId: operation() }),
    /old-mac runs an older deploy.local worker that cannot return job artifacts.*Update deploy.local/,
  );
  assert.throws(
    () =>
      tool('deploy_run_job', {
        ...base,
        requirements: { os: 'macos', capabilities: ['xcode'] },
        operationId: operation(),
      }),
    /Every eligible computer \(old-mac\)/,
  );
  // Without artifacts the same computer still runs jobs.
  const plain = tool('deploy_run_job', {
    checkpointId: checkpoint.checkpointId,
    command: 'true',
    workerId: 'old-mac',
    operationId: operation(),
  });
  assert.equal(plain.status, 'queued');
  tool('deploy_cancel_job', { jobId: plain.id, operationId: operation() });
  // A Linux job queued before any eligible computer is online waits rather than landing on an old one.
  const queued = tool('deploy_run_job', {
    ...base,
    requirements: { os: 'linux' },
    operationId: operation(),
  });
  register('old-linux', [], 'linux');
  assert.equal(jobCommand(owner, 'old-linux', 'poll', { instanceId: 'old-linux' }).job, null);
  assert.match(
    tool('deploy_get_job', { jobId: queued.id }).waitingReason,
    /need a deploy.local worker update/,
  );
  register('new-linux', ['job-artifacts'], 'linux');
  assert.equal(
    jobCommand(owner, 'new-linux', 'poll', { instanceId: 'new-linux' }).job.id,
    queued.id,
  );
  // A worker that completes without reporting artifacts is marked, not silently dropped.
  const assigned = get('job', owner, queued.id);
  const completed = jobCommand(owner, 'new-linux', 'complete', {
    jobId: assigned.id,
    generation: assigned.generation,
    instanceId: 'new-linux',
    status: 'succeeded',
    exitCode: 0,
    output: '',
  }).job;
  assert.match(completed.artifacts[0].skipped, /did not report artifacts/);
  assert.ok(
    list('worker', owner)
      .find((w) => w.id === 'new-linux')
      .capabilities.includes('job-artifacts'),
  );
});

test('a real remote worker uploads artifacts over its authenticated channel only', async () => {
  const enrollment = enrollWorker(owner, { workerId: 'artifact-remote' });
  const intruder = enrollWorker(owner, { workerId: 'artifact-intruder' });
  const server = createServer((req, res) => {
    if (req.headers['x-deploy-agent-token']) return void coordinationApi(req, res);
    const worker = workerAuthentication(req);
    if (worker) return void workspaceApi(req, res, worker.owner, worker.workerId);
    res.writeHead(401);
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const child = spawn(process.execPath, [resolve('server/workspace/remote-worker.ts')], {
    env: {
      ...process.env,
      DEPLOY_COORDINATOR_URL: origin,
      DEPLOY_WORKER_ID: enrollment.workerId,
      DEPLOY_WORKER_TOKEN: enrollment.workerToken,
      DEPLOY_WORKER_ROOT: join(data, 'remote'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const basic = (id: string, secret: string) =>
    'Basic ' + Buffer.from(`workspace-worker.${id}:${secret}`).toString('base64');
  try {
    await until(() =>
      list('worker', owner).some(
        (w) => w.id === enrollment.workerId && w.capabilities.includes('job-artifacts'),
      ),
    );
    const job = tool('deploy_run_job', {
      checkpointId: checkpoint.checkpointId,
      workerId: enrollment.workerId,
      command: 'sleep 1; mkdir -p out && cp pixel.png out/screen.png && echo done > out/run.log',
      artifacts: [{ path: 'out/*', caption: 'Remote output' }],
      operationId: operation(),
    });
    const running = await until(() => {
      const row = get('job', owner, job.id);
      return row.status === 'running' && row.generation && row;
    });
    const target = `${origin}/api/workspace/workers/${enrollment.workerId}/jobs/${job.id}/artifacts?generation=${running.generation}&path=out%2Fscreen.png`;
    // Another enrolled worker cannot use this job's upload route, even with the right job id.
    const crossWorker = await fetch(target, {
      method: 'POST',
      headers: { Authorization: basic(intruder.workerId, intruder.workerToken) },
      body: png,
    });
    assert.equal(crossWorker.status, 403);
    const ownRoute = await fetch(
      target.replace(`/workers/${enrollment.workerId}/`, `/workers/${intruder.workerId}/`),
      {
        method: 'POST',
        headers: {
          Authorization: basic(intruder.workerId, intruder.workerToken),
          'x-worker-instance': running.instanceId,
        },
        body: png,
      },
    );
    assert.equal(ownRoute.status, 403);
    const wrongInstance = await fetch(target, {
      method: 'POST',
      headers: {
        Authorization: basic(enrollment.workerId, enrollment.workerToken),
        'x-worker-instance': 'another-process',
      },
      body: png,
    });
    assert.equal(wrongInstance.status, 403);
    assert.match((await wrongInstance.json()).error, /not assigned/);
    const done = await until(() => {
      const row = get('job', owner, job.id);
      return !['queued', 'running'].includes(row.status) && row;
    });
    assert.equal(done.status, 'succeeded', JSON.stringify(done) + errors);
    assert.deepEqual(
      done.artifacts.map((entry: any) => [entry.path, entry.kind, entry.caption]).sort(),
      [
        ['out/run.log', 'file', 'Remote output'],
        ['out/screen.png', 'image', 'Remote output'],
      ],
    );
    const image = get(
      'attachment',
      owner,
      done.artifacts.find((e: any) => e.kind === 'image').attachmentId,
    );
    assert.deepEqual(attachmentBytes(owner, image.id).data, png);
    assert.equal(image.jobId, job.id);
    // The agent reads text through its own tool endpoint, by reference.
    const read = await fetch(origin + '/api/workspace/agent/tools', {
      method: 'POST',
      headers: { 'x-deploy-agent-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'deploy_read_artifact',
        args: { attachmentId: done.artifacts.find((e: any) => e.kind === 'file').attachmentId },
      }),
    });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).text, 'done\n');
  } finally {
    child.kill('SIGTERM');
    await once(child, 'close');
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
