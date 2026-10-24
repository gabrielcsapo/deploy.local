import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
  createReadStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { type IncomingMessage, type ServerResponse } from 'node:http';
const directory = mkdtempSync(join(tmpdir(), 'deploy-video-test-'));
process.env.DEPLOY_DATA_DIR = directory;
const { db, get, save, id, recentEvents } = await import('./store.ts');
const { createTask } = await import('./test-repository.ts');
const { createAttachment, streamAttachment, taskAttachments, serveAttachment, attachmentBytes } =
  await import('./attachments.ts');
const { sniffVideo, mp4Duration, videoLimit } = await import('./video-files.ts');
const { startRun } = await import('./service.ts');
const { coordinationApi } = await import('./coordination-api.ts');
const { workspaceApi } = await import('./api.ts');
const { issueAgentToken } = await import('./coordination.ts');
const { callCoordinationTool } = await import('./coordination-tools.ts');
const { prepareAgentImages } = await import('./agent-media.ts');
const { InteractiveRunner } = await import('./interactive-runtime.ts');
const { interactiveWorker, interactiveOperator } = await import('./interactive.ts');
const { uploadRecording } = await import('./recording-upload.ts');
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function box(type: string, data: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, data]);
}
const ftyp = box('ftyp', Buffer.from('isom0000'));
function mp4(version = 0) {
  const mvhd = Buffer.alloc(version ? 32 : 20);
  mvhd[0] = version;
  mvhd.writeUInt32BE(1000, version ? 20 : 12);
  if (version) mvhd.writeBigUInt64BE(12500n, 24);
  else mvhd.writeUInt32BE(12500, 16);
  return Buffer.concat([ftyp, box('mdat', Buffer.alloc(128)), box('moov', box('mvhd', mvhd))]);
}
const webm = Buffer.from('1a45dfa300000000', 'hex');
function input(extra = {}) {
  return { operationId: id(), name: 'demo.mp4', kind: 'video', ...extra };
}
test('sniffs MP4, MOV and WebM from bytes and reads mvhd v0/v1 after media payload', () => {
  assert.equal(sniffVideo(mp4())?.mimeType, 'video/mp4');
  assert.equal(sniffVideo(box('ftyp', Buffer.from('qt  0000')))?.mimeType, 'video/quicktime');
  assert.equal(sniffVideo(webm)?.mimeType, 'video/webm');
  assert.equal(sniffVideo(Buffer.from('movie.mp4')), null);
  assert.equal(sniffVideo(Buffer.from('0000000866747970', 'hex')), null);
  assert.equal(mp4Duration(mp4()), 12.5);
  assert.equal(mp4Duration(mp4(1)), 12.5);
  assert.equal(mp4Duration(ftyp), null);
  assert.equal(mp4Duration(Buffer.concat([ftyp, box('moov', Buffer.from('broken'))])), null);
});
test('video default cap is 200 MB, configurable; streamed cap and task budget clean up partial files', async () => {
  assert.equal(videoLimit(), 200 * 1024 * 1024);
  const task = createTask('alice', { title: 'Caps' });
  const tooLarge = Buffer.alloc(videoLimit() + 1);
  ftyp.copy(tooLarge);
  assert.throws(() => createAttachment('alice', task.id, tooLarge, input()), /200 MB/);
  process.env.DEPLOY_VIDEO_LIMIT_BYTES = '1024';
  try {
    await assert.rejects(
      streamAttachment(Readable.from([ftyp, Buffer.alloc(1024)]), 'alice', task.id, input()),
      /limit|exceeds/,
    );
  } finally {
    delete process.env.DEPLOY_VIDEO_LIMIT_BYTES;
  }
  process.env.DEPLOY_TASK_MEDIA_LIMIT_BYTES = '1';
  try {
    await assert.rejects(
      streamAttachment(Readable.from([mp4()]), 'alice', task.id, input()),
      /storage limit/,
    );
  } finally {
    delete process.env.DEPLOY_TASK_MEDIA_LIMIT_BYTES;
  }
  assert.equal(
    readdirSync(join(directory, 'workspace', 'attachments')).some((p) => p.startsWith('.upload-')),
    false,
  );
});
test('stream upload exceeds a small buffering budget, stays bounded, is idempotent and owner isolated', async () => {
  const task = createTask('alice', { title: 'Stream' });
  const args = { operationId: id(), name: 'demo.mp4', caption: '', kind: 'video' };
  const concat = Buffer.concat;
  Buffer.concat = ((chunks: readonly Uint8Array[], length?: number) => {
    assert.ok(chunks.reduce((n, c) => n + c.length, 0) <= 65536, 'must not buffer the full upload');
    return concat(chunks, length);
  }) as typeof Buffer.concat;
  let row: any;
  const chunks = async function* () {
    yield ftyp;
    for (let i = 0; i < 256; i++) yield Buffer.alloc(8192);
  };
  try {
    let response = '',
      status = 0;
    const request = Object.assign(Readable.from(chunks()), {
      method: 'POST',
      url: `/api/workspace/tasks/${task.id}/attachments?kind=video&name=demo.mp4&operationId=${args.operationId}`,
      headers: { 'content-type': 'video/mp4' },
    });
    await workspaceApi(
      request as unknown as IncomingMessage,
      {
        writeHead(value: number) {
          status = value;
        },
        end(value: string) {
          response = value;
        },
      } as ServerResponse,
      'alice',
    );
    assert.equal(status, 200);
    row = JSON.parse(response);
    assert.equal((await streamAttachment(chunks(), 'alice', task.id, args)).id, row.id);
  } finally {
    Buffer.concat = concat;
  }
  assert.equal(row.size, ftyp.length + 256 * 8192);
  assert.equal(row.duration, null);
  assert.equal(row.kind, 'video');
  assert.throws(() => attachmentBytes('bob', row.id), /Not found/);
  await assert.rejects(
    streamAttachment(Readable.from([webm]), 'bob', task.id, input()),
    /Not found/,
  );
});
async function readRange(row: any, range?: string, owner = 'alice') {
  let status = 0,
    headers: any;
  const chunks: Buffer[] = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  Object.assign(response, {
    writeHead(code: number, value: any) {
      status = code;
      headers = value;
    },
  });
  await serveAttachment(
    { headers: range ? { range } : {} } as IncomingMessage,
    response as unknown as ServerResponse,
    owner,
    row.id,
  );
  return { status, headers, data: Buffer.concat(chunks) };
}
test('authenticated video range responses include start, middle, suffix, clamped end and invalid ranges', async () => {
  const task = createTask('alice', { title: 'Ranges' });
  const data = mp4();
  const row = createAttachment('alice', task.id, data, input());
  assert.equal(row.duration, 12.5);
  for (const [range, start, end] of [
    ['bytes=0-15', 0, 15],
    ['bytes=20-39', 20, 39],
    ['bytes=-10', data.length - 10, data.length - 1],
    ['bytes=20-', 20, data.length - 1],
    ['bytes=20-9999', 20, data.length - 1],
  ] as const) {
    const response = await readRange(row, range);
    assert.equal(response.status, 206);
    assert.equal(response.headers['Accept-Ranges'], 'bytes');
    assert.equal(response.headers['Content-Length'], end - start + 1);
    assert.equal(response.headers['Content-Range'], `bytes ${start}-${end}/${data.length}`);
    assert.deepEqual(response.data, data.subarray(start, end + 1));
  }
  for (const range of [
    'bytes=9999-',
    'bytes=9-1',
    'bytes=-0',
    'bytes=0-1,4-5',
    'bytes=-',
    'garbage',
  ]) {
    const response = await readRange(row, range);
    assert.equal(response.status, 416);
    assert.equal(response.headers['Content-Range'], `bytes */${data.length}`);
  }
  assert.deepEqual((await readRange(row)).data, data);
  await assert.rejects(readRange(row, 'bytes=0-1', 'bob'), /Not found/);
});
test('remote deploy_attach streams a workspace video via scoped agent HTTP and video inputs become notes', async (t) => {
  const task = createTask('alice', { title: 'Remote' });
  const video = createAttachment('alice', task.id, mp4(), input({ source: 'user' }));
  const run = startRun('alice', task.id, { revision: task.revision, attachmentIds: [video.id] });
  assert.match(
    run.prompt,
    /The user attached a video, demo.mp4, 13 s; you cannot view video directly/,
  );
  save('run', 'alice', { ...run, status: 'running' });
  const token = issueAgentToken({ owner: 'alice', taskId: task.id, runId: run.id });
  const paths: string[] = [],
    types: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
    const target = new URL(url);
    paths.push(target.pathname + target.search);
    types.push((init.headers as Record<string, string>)['Content-Type']);
    assert.equal(init.redirect, 'error');
    const body = typeof init.body === 'string' ? Readable.from([init.body]) : init.body;
    const request = Object.assign(body!, {
      method: init.method,
      url: target.pathname + target.search,
      headers: init.headers,
    });
    let status = 0,
      response = '';
    await coordinationApi(
      request as unknown as IncomingMessage,
      {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          response = value;
        },
      } as ServerResponse,
    );
    return new Response(response, { status, headers: { 'Content-Type': 'application/json' } });
  });
  const endpoint = 'http://worker-coordinator.test/api/workspace/agent/tools';
  const old = {
    cwd: process.cwd(),
    url: process.env.DEPLOY_AGENT_URL,
    token: process.env.DEPLOY_AGENT_TOKEN,
  };
  try {
    writeFileSync(join(task.workspacePath, 'remote.webm'), webm);
    process.chdir(task.workspacePath);
    process.env.DEPLOY_AGENT_URL = endpoint;
    process.env.DEPLOY_AGENT_TOKEN = token;
    const attached = await callCoordinationTool('deploy_attach', {
      path: 'remote.webm',
      caption: 'Flow',
    });
    assert.equal(attached.kind, 'video');
    assert.equal(attached.runId, run.id);
    assert.equal(attached.source, 'agent');
    assert.match(paths[0], /^\/api\/workspace\/agent\/attachments\?/);
    assert.equal(types[0], 'application/octet-stream');
    assert.equal(
      (await callCoordinationTool('deploy_attach', { path: 'remote.webm', caption: 'Flow' })).id,
      attached.id,
    );
    const images = await prepareAgentImages([video.id], endpoint, token);
    assert.deepEqual(images.paths, []);
    images.cleanup();
  } finally {
    process.chdir(old.cwd);
    if (old.url) process.env.DEPLOY_AGENT_URL = old.url;
    else delete process.env.DEPLOY_AGENT_URL;
    if (old.token) process.env.DEPLOY_AGENT_TOKEN = old.token;
    else delete process.env.DEPLOY_AGENT_TOKEN;
  }
});
test('mock Playwright recording uploads on close, links task/run, cleans temp files and reports upload failures', async () => {
  const task = createTask('alice', { title: 'Recording' });
  const instanceId = id();
  const targets = [{ id: 'browser', kind: 'browser', label: 'Browser', available: true }];
  interactiveWorker('alice', 'local', 'poll', { instanceId, targets });
  const session = interactiveOperator('alice', task.id, 'open', {
    operationId: id(),
    clientId: id(),
    workerId: 'local',
    targetId: 'browser',
    record: true,
  });
  save('interactive-session', 'alice', { ...session, runId: 'record-run' });
  let sessions = [{ ...session, runId: 'record-run' }],
    options: any,
    closed = false,
    recordingPath = '';
  const page = {
    on() {},
    setDefaultTimeout() {},
    video: () => ({
      path: async () => {
        assert.equal(closed, true);
        return recordingPath;
      },
    }),
  };
  const context = {
    route: async () => {},
    newPage: async () => page,
    on() {},
    close: async () => {
      closed = true;
      writeFileSync(recordingPath, webm);
    },
  };
  const chromium = {
    launch: async () => ({
      newContext: async (value: any) => {
        options = value;
        recordingPath = join(options.recordVideo.dir, 'video.webm');
        return context;
      },
      close: async () => {},
    }),
  };
  const errors: any[] = [];
  const runner = new InteractiveRunner(
    async (action, body) => {
      if (action === 'poll') return { sessions, commands: [] };
      if (action === 'recording-error') {
        errors.push(body);
        return interactiveWorker('alice', 'local', action, { ...body, instanceId });
      }
      return {};
    },
    {
      chromium,
      uploadRecording: (s, path) =>
        uploadRecording(createReadStream(path), 'alice', 'local', s.id, instanceId),
    },
  );
  try {
    await runner.tick();
    assert.deepEqual(options.recordVideo.size, { width: 1280, height: 800 });
    sessions = [];
    await runner.tick();
    await runner.shutdown();
    const row = taskAttachments('alice', task.id).find((a) => a.kind === 'video')!;
    assert.equal(row.caption, 'Computer use recording');
    assert.equal(row.source, 'computer-use');
    assert.equal(row.runId, 'record-run');
    assert.equal(existsSync(options.recordVideo.dir), false);
    assert.equal(errors.length, 0);
  } finally {
    await runner.shutdown();
  }
  closed = false;
  sessions = [{ ...session, runId: 'record-run' }];
  const failing = new InteractiveRunner(
    async (action, body) => {
      if (action === 'poll') return { sessions, commands: [] };
      if (action === 'recording-error')
        return interactiveWorker('alice', 'local', action, { ...body, instanceId });
      throw new Error('Recording failure must not fail session');
    },
    {
      chromium,
      uploadRecording: async () => {
        throw new Error('Upload unavailable');
      },
    },
  );
  try {
    await failing.tick();
    sessions = [];
    await failing.tick();
    await failing.shutdown();
    assert.equal(get('interactive-session', 'alice', session.id).status, 'opening');
    assert.ok(
      recentEvents('alice', task.id).events.some((e: any) => e.type === 'attachment.error'),
    );
  } finally {
    await failing.shutdown();
  }
});

test('recording is opt-in and closes at ten minutes before uploading', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let record = false,
    options: any,
    closed = 0,
    uploaded = 0;
  const calls: string[] = [];
  const page = {
    on() {},
    setDefaultTimeout() {},
    video: () => (record ? { path: async () => 'recording.webm' } : null),
  };
  const chromium = {
    launch: async () => ({
      newContext: async (value: any) => {
        options = value;
        return {
          route: async () => {},
          newPage: async () => page,
          on() {},
          close: async () => {
            closed++;
          },
        };
      },
      close: async () => {},
    }),
  };
  const request = async (action: string) => {
    calls.push(action);
    return { sessions: [{ id: 'bounded', kind: 'browser', record }], commands: [] };
  };
  const plain = new InteractiveRunner(request, {
    chromium,
    uploadRecording: async () => {
      uploaded++;
    },
  });
  try {
    await plain.tick();
    assert.equal(options.recordVideo, undefined);
  } finally {
    await plain.shutdown();
  }
  assert.equal(uploaded, 0);
  record = true;
  closed = 0;
  let uploadedResolve: () => void = () => {};
  const finalized = new Promise<void>((resolve) => {
    uploadedResolve = resolve;
  });
  const recording = new InteractiveRunner(request, {
    chromium,
    uploadRecording: async () => {
      assert.equal(closed, 1);
      uploaded++;
      uploadedResolve();
    },
  });
  try {
    await recording.tick();
    t.mock.timers.tick(599999);
    assert.equal(closed, 0);
    t.mock.timers.tick(1);
    await finalized;
    assert.equal(closed, 1);
    assert.equal(uploaded, 1);
  } finally {
    await recording.shutdown();
  }
});

test('streaming keeps JPEG frame headers after large metadata supported', async () => {
  const task = createTask('alice', { title: 'JPEG metadata' });
  const metadata = Buffer.alloc(65535);
  metadata.writeUInt16BE(metadata.length);
  const data = Buffer.concat([
    Buffer.from('ffd8ffe1', 'hex'),
    metadata,
    Buffer.from('ffc00008080003000200ffd9', 'hex'),
  ]);
  const row = await streamAttachment(
    Readable.from([data]),
    'alice',
    task.id,
    input({ kind: 'media', name: 'photo.jpg' }),
  );
  assert.equal(row.kind, 'image');
  assert.equal(row.width, 2);
  assert.equal(row.height, 3);
});
