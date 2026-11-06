import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
const directory = mkdtempSync(join(tmpdir(), 'deploy-media-test-'));
process.env.DEPLOY_DATA_DIR = directory;
const { createAttachment, attachmentBytes, taskAttachments } = await import('./attachments.ts');
const {
  sniffImage,
  imageLimit,
  readWorkspaceMedia,
  rewriteMedia,
  materializeImages,
  claudeImageMessage,
} = await import('./media-files.ts');
const { createTask } = await import('./test-repository.ts');
const { get, save, db } = await import('./store.ts');
const { startRun } = await import('./service.ts');
const { workspaceApi } = await import('./api.ts');
const { coordinationApi } = await import('./coordination-api.ts');
const { issueAgentToken } = await import('./coordination.ts');
const { agentLaunch } = await import('./agent-launch.ts');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=',
  'base64',
);
const task = createTask('alice', { title: 'Media' });
let sequence = 0;
const upload = (options: any = {}, bytes = png, taskId = task.id, owner = 'alice') =>
  createAttachment(owner, taskId, bytes, {
    operationId: 'media-' + ++sequence,
    kind: 'image',
    ...options,
  });
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
async function api(
  owner: string,
  method: string,
  path: string,
  data = Buffer.alloc(0),
  headers: any = {},
) {
  let status = 0,
    responseHeaders: any = {},
    body: any;
  const req = Object.assign(Readable.from([data]), {
    method,
    url: '/api/workspace' + path,
    headers,
  });
  await workspaceApi(
    req as unknown as IncomingMessage,
    {
      writeHead(code: number, value: any) {
        status = code;
        responseHeaders = value;
      },
      end(value: any) {
        body = value;
      },
    } as ServerResponse,
    owner,
  );
  return { status, headers: responseHeaders, body };
}
test('sniffs supported formats and dimensions from content, rejects names and unsupported images', () => {
  assert.deepEqual(sniffImage(png), { mimeType: 'image/png', width: 1, height: 1 });
  const gif = Buffer.from('47494638396102000300', 'hex');
  assert.deepEqual(sniffImage(gif), { mimeType: 'image/gif', width: 2, height: 3 });
  const jpeg = Buffer.from('ffd8ffc00008080003000200ffd9', 'hex');
  assert.deepEqual(sniffImage(jpeg), { mimeType: 'image/jpeg', width: 2, height: 3 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF');
  webp.write('WEBP', 8);
  webp.write('VP8X', 12);
  webp.writeUIntLE(2, 24, 3);
  webp.writeUIntLE(3, 27, 3);
  assert.deepEqual(sniffImage(webp), { mimeType: 'image/webp', width: 3, height: 4 });
  for (const value of ['', '<svg></svg>', '%PDF-1.0', 'not a png'])
    assert.equal(sniffImage(Buffer.from(value)), null);
  assert.throws(() => upload({ name: 'photo.png' }, Buffer.from('<svg></svg>')), /PNG/);
  assert.equal(upload({ name: 'photo.svg' }).mimeType, 'image/png');
});
test('content addressed store deduplicates bytes, isolates owners, replays identical operations and refuses conflicts', async () => {
  const a = upload({ operationId: 'retry', name: 'picture.png' });
  const retry = upload({ operationId: 'retry', name: 'picture.png' });
  assert.equal(a.id, retry.id);
  assert.throws(() => upload({ operationId: 'retry', caption: 'different' }), /different command/);
  const b = upload();
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await attachmentBytes('alice', a.id)).data, png);
  assert.throws(() => attachmentBytes('bob', a.id), /Not found/);
  assert.throws(() => upload({}, png, task.id, 'bob'), /Not found/);
});
test('enforces the image and configurable task storage caps', () => {
  assert.throws(() => upload({}, Buffer.alloc(imageLimit + 1)), /20 MB/);
  const isolated = createTask('alice', { title: 'Cap' });
  process.env.DEPLOY_TASK_MEDIA_LIMIT_BYTES = String(png.length);
  upload({}, png, isolated.id);
  assert.throws(() => upload({}, png, isolated.id), /storage limit/);
  delete process.env.DEPLOY_TASK_MEDIA_LIMIT_BYTES;
});
test('authenticated raw upload, thumbnail fallback, ETag and owner isolation on routes', async () => {
  const response = await api(
    'alice',
    'POST',
    `/tasks/${task.id}/attachments?operationId=raw&name=photo.png`,
    png,
  );
  assert.equal(response.status, 200);
  const row = JSON.parse(response.body);
  const image = await api('alice', 'GET', `/attachments/${row.id}`);
  assert.equal(image.status, 200);
  assert.deepEqual(image.body, png);
  assert.equal(image.headers['Content-Type'], 'image/png');
  assert.match(image.headers['Cache-Control'], /private/);
  assert.equal((await api('alice', 'GET', `/attachments/${row.id}/thumbnail`)).status, 200);
  assert.equal(
    (
      await api('alice', 'GET', `/attachments/${row.id}`, Buffer.alloc(0), {
        'if-none-match': image.headers.ETag,
      })
    ).status,
    304,
  );
  assert.equal((await api('bob', 'GET', `/attachments/${row.id}`)).status, 404);
  assert.equal((await api('bob', 'GET', `/attachments/${row.id}/thumbnail`)).status, 404);
});
test('messages accept image-only input, validate ids and link attachments to a message', () => {
  const a = upload();
  const run = startRun('alice', task.id, {
    revision: get('task', 'alice', task.id).revision,
    attachmentIds: [a.id],
    adapter: 'codex',
  });
  assert.deepEqual(run.attachmentIds, [a.id]);
  const row = get('attachment', 'alice', a.id);
  assert.ok(row.messageId);
  assert.deepEqual(get('message', 'alice', row.messageId).attachmentIds, [a.id]);
  const other = createTask('alice', { title: 'Other' });
  assert.throws(
    () =>
      startRun('alice', other.id, {
        revision: other.revision,
        content: 'look',
        attachmentIds: [a.id],
      }),
    /unavailable/,
  );
  assert.throws(
    () =>
      startRun('alice', other.id, {
        revision: other.revision,
        content: 'look',
        attachmentIds: ['missing'],
      }),
    /Not found/,
  );
});
test('Codex receives -i paths, Claude receives real image blocks and temporary files hold exact bytes', () => {
  const materialized = materializeImages([
    { id: 'x', data: png.toString('base64'), mimeType: 'image/png' },
  ]);
  const launch = agentLaunch({ adapter: 'codex', imagePaths: materialized.paths });
  assert.equal(launch.args[launch.args.indexOf('-i') + 1], materialized.paths[0]);
  const resume = agentLaunch({
    adapter: 'codex',
    sessionId: 'session',
    imagePaths: materialized.paths,
  });
  assert.ok(resume.args.indexOf('-i') > resume.args.indexOf('resume'));
  const message = claudeImageMessage('Look here', [
    { data: png.toString('base64'), mimeType: 'image/png' },
  ]);
  assert.equal(message.message.content[0].type, 'image');
  assert.deepEqual((message.message.content[0] as any).source, {
    type: 'base64',
    media_type: 'image/png',
    data: png.toString('base64'),
  });
  assert.deepEqual(message.message.content.at(-1), { type: 'text', text: 'Look here' });
  materialized.cleanup();
});
test('deploy_attach refuses traversal, symlinks and directories; accepts in-workspace files', () => {
  writeFileSync(join(task.workspacePath, 'screen.png'), png);
  symlinkSync(directory, join(task.workspacePath, 'outside'));
  assert.deepEqual(readWorkspaceMedia(task.workspacePath, 'screen.png'), png);
  assert.throws(() => readWorkspaceMedia(task.workspacePath, '../escape'), /traversal/);
  assert.throws(() => readWorkspaceMedia(task.workspacePath, join(directory, 'escape')), /inside/);
  assert.throws(() => readWorkspaceMedia(task.workspacePath, 'outside/image.png'), /symlink/);
  assert.throws(() => readWorkspaceMedia(task.workspacePath, '.'), /inside/);
});
test('run-end Markdown upload maps local, file URL and remote worker paths, rewrites images and reports missing files', async () => {
  const paths: string[] = [];
  const source = `![one](${task.workspacePath}/screen.png) ![two](file://${task.workspacePath}/screen.png) ![three](/worker/tasks/${task.id}/screen.png) ![missing](gone.png) ![web](https://example.test/a.png)`;
  const result = await rewriteMedia(source, task, async (path, caption) => {
    paths.push(path);
    return upload(
      { caption, source: 'agent', runId: 'final' },
      readWorkspaceMedia(task.workspacePath, path),
    );
  });
  assert.deepEqual(paths, ['screen.png', 'screen.png', 'screen.png', 'gone.png']);
  assert.equal(result.attachmentIds.length, 3);
  assert.equal(result.errors.length, 1);
  assert.match(result.content, /\/api\/workspace\/attachments\//);
  assert.match(result.content, /Image unavailable/);
  assert.match(result.content, /https:\/\/example.test/);
});
test('computer-use frames retain one per action and the newest fifty per session', () => {
  const isolated = createTask('alice', { title: 'Frames' });
  for (let i = 0; i < 55; i++)
    upload(
      { source: 'computer-use', runId: 'control', sessionId: 'session', actionId: String(i) },
      png,
      isolated.id,
    );
  upload(
    { source: 'computer-use', runId: 'control', sessionId: 'session', actionId: '54' },
    png,
    isolated.id,
  );
  const frames = taskAttachments('alice', isolated.id);
  assert.equal(frames.length, 50);
  assert.equal(frames[0].actionId, '5');
  assert.equal(frames.at(-1).actionId, '54');
  assert.ok(readdirSync(join(directory, 'workspace', 'attachments')).length >= 1);
});
test('per-run agent endpoint accepts uploads and reads only image input assigned to this run', async () => {
  const scopedTask = createTask('alice', { title: 'Agent' });
  const input = upload({}, png, scopedTask.id);
  const run = startRun('alice', scopedTask.id, {
    revision: scopedTask.revision,
    content: 'look',
    attachmentIds: [input.id],
  });
  save('run', 'alice', { ...run, status: 'running' });
  const token = issueAgentToken({ owner: 'alice', taskId: scopedTask.id, runId: run.id });
  const call = async (name: string, args: any) => {
    let status = 0,
      body: any;
    const req = Object.assign(Readable.from([JSON.stringify({ name, args })]), {
      method: 'POST',
      url: '/api/workspace/agent/tools',
      headers: { 'x-deploy-agent-token': token },
    });
    await coordinationApi(
      req as unknown as IncomingMessage,
      {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          body = JSON.parse(value);
        },
      } as ServerResponse,
    );
    return { status, body };
  };
  const attached = await call('deploy_attach', {
    operationId: 'agent-out',
    name: 'out.png',
    data: png.toString('base64'),
  });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.runId, run.id);
  assert.equal(attached.body.source, 'agent');
  const read = await call('deploy_attachment_read', { id: input.id });
  assert.equal(read.status, 200);
  assert.equal(read.body.data, png.toString('base64'));
  assert.equal((await call('deploy_attachment_read', { id: attached.body.id })).status, 403);
  const unrelated = upload();
  assert.equal((await call('deploy_attachment_read', { id: unrelated.id })).status, 403);
});

test('Claude CLI adapter writes stream-json image content to the provider process', async () => {
  const fake = join(directory, 'claude-image-provider');
  const capture = join(directory, 'claude-image-input.json');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
writeFileSync(process.env.CAPTURE_INPUT, JSON.stringify({ args: process.argv.slice(2), input: JSON.parse(input) }));
console.log(JSON.stringify({ type: 'result', result: 'received' }));
`,
    { mode: 0o700 },
  );
  const images = materializeImages([
    { id: 'image', mimeType: 'image/png', data: png.toString('base64') },
  ]);
  try {
    const result = spawnSync(process.execPath, [resolve('server/workspace/claude-agent.ts')], {
      input: 'Describe this image',
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        DEPLOY_CLAUDE_BIN: fake,
        DEPLOY_IMAGE_PATHS: JSON.stringify(images.paths),
        CAPTURE_INPUT: capture,
        DEPLOY_AGENT_INSTRUCTIONS: 'Coordinator system instructions',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(value.args[value.args.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(
      value.args[value.args.indexOf('--append-system-prompt') + 1],
      'Coordinator system instructions',
    );
    assert.equal(value.input.message.content[0].source.data, png.toString('base64'));
    assert.equal(value.input.message.content[1].text, 'Describe this image');
  } finally {
    images.cleanup();
  }
});

test('queued image ids survive release and remain available when a failed turn holds the draft', async () => {
  const { queueMessage, releaseQueuedMessage, queuedMessage } = await import('./queued-message.ts');
  for (const status of ['succeeded', 'failed']) {
    const queuedTask = createTask('alice', { title: 'Image queue' });
    const first = startRun('alice', queuedTask.id, {
      revision: queuedTask.revision,
      content: 'Work',
    });
    const image = upload({}, png, queuedTask.id);
    queueMessage('alice', queuedTask.id, { content: '', attachmentIds: [image.id] });
    assert.deepEqual(queuedMessage('alice', queuedTask.id).attachmentIds, [image.id]);
    save('run', 'alice', { ...first, status });
    const next = releaseQueuedMessage('alice', queuedTask.id, status);
    if (status === 'succeeded') {
      assert.ok(next);
      assert.deepEqual(next.attachmentIds, [image.id]);
      assert.ok(get('attachment', 'alice', image.id).messageId);
    } else {
      assert.equal(queuedMessage('alice', queuedTask.id).status, 'held');
      assert.equal(get('attachment', 'alice', image.id).messageId, undefined);
    }
  }
});
