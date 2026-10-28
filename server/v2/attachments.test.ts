import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root = mkdtempSync(join(tmpdir(), 'v2-attachments-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_CODEX_BIN = '/usr/bin/false';
const store = await import('../store.ts');
const { db, save, get } = await import('../workspace/store.ts');
const { v2Api } = await import('./api.ts');
const { storeAttachment, attachmentBytes, ownedAttachments, uploadLimit, chatModel } =
  await import('./attachments.ts');
const { getModels } = await import('./computers.ts');
const { prepareAttachmentInput } = await import('../workspace/attachment-input.ts');
let providerInput: any;
const server = createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    providerInput = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'I can see your marks.' } }] }));
    return;
  }
  await v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'owner') }));
});
server.listen(5192, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:5192/api/v2';
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO9sAAAAASUVORK5CYII=',
  'base64',
);
test('upload validates size, declared type, contents and file names', async () => {
  for (const [bytes, type, status] of [
    [Buffer.alloc(uploadLimit + 1), 'text/plain', 413],
    [Buffer.from('<svg/>'), 'image/svg+xml', 415],
    [Buffer.from('not a photo'), 'image/png', 415],
    [Buffer.from('{'), 'application/json', 415],
    [Buffer.from([0]), 'text/plain', 415],
    [Buffer.alloc(0), 'text/plain', 400],
  ] as const) {
    const response = await fetch(base + '/attachments', {
      method: 'POST',
      headers: { 'Content-Type': type, 'X-File-Name': 'file' },
      body: bytes,
    });
    assert.equal(response.status, status, await response.text());
  }
  assert.throws(() => storeAttachment('owner', png, 'image/png', '../secret'), /file name/);
  const response = await fetch(base + '/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-File-Name': 'picked.png' },
    body: png,
  });
  assert.equal(response.status, 201);
  const { attachment } = await response.json();
  assert.equal(attachment.kind, 'photo');
  assert.equal(attachment.bytes, png.length);
  const download = await fetch('http://127.0.0.1:5192' + attachment.ref);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  assert.equal(
    (
      await fetch('http://127.0.0.1:5192' + attachment.ref, {
        headers: { 'x-test-owner': 'other' },
      })
    ).status,
    404,
  );
  assert.throws(() => ownedAttachments('other', [attachment]), /Not found/);
  assert.throws(() => ownedAttachments('owner', Array(9).fill(attachment)), /eight/);
  const owned = ownedAttachments('owner', [{ ...attachment, name: 'forged', bytes: 0 }]);
  assert.equal(owned[0].name, 'picked.png');
  assert.deepEqual(attachmentBytes('owner', attachment.ref).bytes, png);
});
test('chat model override and Auto read defaults without writing them', () => {
  save('worker', 'owner', {
    id: 'mac',
    name: 'MacBook Pro',
    heartbeat: new Date().toISOString(),
    capabilities: ['codex'],
    modelOptions: [
      {
        id: 'codex',
        models: [
          { id: 'one', name: 'One' },
          { id: 'two', name: 'Two' },
        ],
      },
    ],
  });
  const defaults = { 'writing-code': 'codex:one', reviewing: null, 'answering-questions': null };
  save('v2-model-defaults', 'owner', { id: 'defaults', defaults });
  assert.deepEqual(chatModel('owner', 'codex:two'), { adapter: 'codex', model: 'two' });
  assert.deepEqual(chatModel('owner', null), { adapter: 'codex', model: 'one' });
  assert.deepEqual(getModels('owner').defaults, defaults);
  assert.deepEqual(get('v2-model-defaults', 'owner', 'defaults').defaults, defaults);
  assert.throws(() => chatModel('owner', 'codex:missing'), /unavailable/);
});
test('provider fallback writes exact bytes and markup descriptions inside the task', () => {
  const task = join(root, 'task');
  mkdirSync(task);
  const markup = {
    strokes: [
      {
        tool: 'arrow' as const,
        color: 0 as const,
        points: [
          [1, 2],
          [3, 4],
        ] as [number, number][],
      },
    ],
    texts: [{ x: 5, y: 6, text: 'pick-up night!', color: 2 as const }],
  };
  const prompt = prepareAttachmentInput(task, [
    { name: '../image.png', type: 'image/png', data: png.toString('base64'), markup },
  ]);
  assert.match(prompt, /original image pixels/);
  assert.match(prompt, /pick-up night!/);
  const path = prompt
    .split('\n')
    .find((line) => line.startsWith('.deploy-attachments/'))!
    .split(' (')[0];
  assert.deepEqual(readFileSync(join(task, path)), png);
  const other = join(root, 'other-task');
  mkdirSync(other);
  symlinkSync(task, join(other, '.deploy-attachments'));
  assert.throws(
    () =>
      prepareAttachmentInput(other, [
        { name: 'photo.png', type: 'image/png', data: png.toString('base64') },
      ]),
    /symbolic link/,
  );
});

test('agent chat passes marked images to a compatible provider without changing defaults', async () => {
  const { saveProviderConnection } = await import('../workspace/provider-connections.ts');
  const { patchScreenshot } = await import('./screenshots.ts');
  save('worker', 'vision-owner', {
    id: 'vision',
    name: 'SER',
    heartbeat: new Date().toISOString(),
    modelOptions: [
      {
        id: 'compatible',
        models: [
          { id: 'vision1', name: 'Vision 1' },
          { id: 'vision2', name: 'Vision 2' },
        ],
      },
    ],
  });
  saveProviderConnection('vision-owner', {
    workerId: 'vision',
    provider: 'compatible',
    enabled: true,
    mode: 'api-key',
    baseUrl: 'http://127.0.0.1:5192/v1',
    model: 'vision1',
    billingMode: 'local',
  });
  const defaults = {
    'writing-code': null,
    reviewing: null,
    'answering-questions': 'compatible:vision1',
  };
  save('v2-model-defaults', 'vision-owner', { id: 'defaults', defaults });
  const attachment = storeAttachment('vision-owner', png, 'image/png', 'marked.png');
  save('screenshot', 'vision-owner', { id: 'shot', taskId: 'task', image: attachment.ref });
  const markup = { strokes: [], texts: [{ x: 10, y: 20, text: 'Change this', color: 0 }] };
  patchScreenshot('vision-owner', 'shot', { markup, renderedImage: attachment.ref });
  const result = await fetch(base + '/composer/agents/scout/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-owner': 'vision-owner' },
    body: JSON.stringify({
      text: 'Read my marks',
      attachments: [attachment],
      model: 'compatible:vision2',
    }),
  });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.events[0].attachments[0].kind, 'screenshot');
  assert.equal(providerInput.model, 'vision2');
  const content = providerInput.messages.at(-1).content;
  assert.ok(
    content.some(
      (block: any) =>
        block.type === 'image_url' &&
        block.image_url.url === 'data:image/png;base64,' + png.toString('base64'),
    ),
  );
  assert.ok(
    content.some((block: any) => block.type === 'text' && block.text.includes('Change this')),
  );
  assert.deepEqual(get('v2-model-defaults', 'vision-owner', 'defaults').defaults, defaults);
});
