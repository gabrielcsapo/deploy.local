import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root = mkdtempSync(join(tmpdir(), 'v2-pull-files-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../../store.ts');
const { db, save, get } = await import('../../workspace/store.ts');
const { v2Api } = await import('../../v2/api.ts');
const { classify, pullFileLimit, videoDuration } = await import('./pull-files.ts');
const { taskSnapshot } = await import('../../v2/tasks.ts');
const { collaborationCommand } = await import('../../workspace/project-collaboration.ts');
const server = createServer(async (req, res) => {
  await v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'owner') }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
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
save('project', 'owner', { id: 'p1', name: 'home-gym' });
save('task', 'owner', { id: 't1', projectId: 'p1', title: 'Self-release pipeline', createdAt: '' });
save('pull-request', 'owner', {
  id: 'pr1',
  projectId: 'p1',
  number: 18,
  title: 'Self-release pipeline',
  body: 'Drafted by the agent.',
  status: 'open',
  revision: 0,
  taskIds: ['t1'],
});
const upload = (body: Buffer, type: string, name: string, owner = 'owner', pull = 'pr1') =>
  fetch(`${origin}/api/pulls/${pull}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': type,
      'X-File-Name': encodeURIComponent(name),
      'x-test-owner': owner,
    },
    body: new Uint8Array(body),
  });

test('a file is classified by its bytes, and active content never runs', () => {
  assert.equal(classify(png, 'application/octet-stream', 'x.bin').kind, 'image');
  assert.equal(classify(Buffer.from('%PDF-1.7'), '', 'a.pdf').kind, 'pdf');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]);
  assert.deepEqual(classify(mp4, '', 'demo.mp4'), { kind: 'video', type: 'video/mp4' });
  assert.deepEqual(classify(Buffer.from('18:02 ok\n'), '', 'rollback.log'), {
    kind: 'text',
    type: 'text/plain; charset=utf-8',
  });
  // SVG and HTML are read as text, never served as images or pages.
  assert.equal(classify(Buffer.from('<svg onload=x/>'), 'image/svg+xml', 'a.svg').kind, 'file');
  assert.equal(
    classify(Buffer.from('<script>'), 'text/html', 'a.html').type,
    'text/plain; charset=utf-8',
  );
  assert.equal(classify(Buffer.from([0, 1, 2]), 'text/plain', 'a.txt').kind, 'file');
});

test('upload, list and serve description files for the owner only', async () => {
  const response = await upload(png, 'image/png', 'release flow.png');
  assert.equal(response.status, 201, await response.clone().text());
  const { file } = await response.json();
  assert.equal(file.kind, 'image');
  assert.equal(file.name, 'release flow.png');
  assert.match(file.url, /^\/api\/pulls\/pr1\/files\/[a-f0-9-]+$/);

  const image = await fetch(origin + file.url);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('content-security-policy') || '', /sandbox/);
  assert.match(image.headers.get('content-disposition') || '', /^inline/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  const zip = await (
    await upload(Buffer.from([80, 75, 3, 4, 1]), 'application/zip', 'ser.zip')
  ).json();
  const download = await fetch(origin + zip.file.url);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition') || '', /^attachment/);
  await download.arrayBuffer();

  // Byte ranges, for video players.
  const part = await fetch(origin + file.url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${png.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), png.subarray(0, 4));

  const files = (await (await fetch(`${origin}/api/pulls/pr1/files`)).json()).files;
  assert.deepEqual(
    files.map((item: any) => item.name),
    ['release flow.png', 'ser.zip'],
  );
  assert.deepEqual(
    taskSnapshot('owner', 't1').pulls[0].files.map((item: any) => item.id),
    files.map((item: any) => item.id),
  );

  // Another owner can neither see the pull request nor its files.
  assert.equal(
    (await fetch(origin + file.url, { headers: { 'x-test-owner': 'other' } })).status,
    404,
  );
  assert.equal((await upload(png, 'image/png', 'x.png', 'other')).status, 404);
  // A file belongs to one pull request.
  save('pull-request', 'owner', { ...get('pull-request', 'owner', 'pr1'), id: 'pr2', number: 19 });
  assert.equal((await fetch(file.url.replace('/pr1/', '/pr2/').replace(/^/, origin))).status, 404);
});

test('upload refuses empty files, bad names, oversized files and merged pull requests', async () => {
  assert.equal((await upload(Buffer.alloc(0), 'text/plain', 'a.txt')).status, 400);
  assert.equal((await upload(png, 'image/png', '../secret.png')).status, 400);
  assert.equal(
    (await upload(Buffer.alloc(pullFileLimit + 1), 'application/zip', 'big.zip')).status,
    413,
  );
  save('pull-request', 'owner', { ...get('pull-request', 'owner', 'pr2'), status: 'merged' });
  assert.equal((await upload(png, 'image/png', 'late.png', 'owner', 'pr2')).status, 409);
});

test('editing the description records who edited it', async () => {
  const pull = await collaborationCommand(
    'owner',
    'p1',
    'pulls',
    'pr1',
    'update',
    {
      operationId: 'edit-1',
      revision: get('pull-request', 'owner', 'pr1').revision,
      body: '![release flow.png](/api/pulls/pr1/files/x)',
    },
    'sig-1',
  );
  assert.equal(pull.bodyEditedBy, 'owner');
  assert.ok(pull.bodyEditedAt);
  assert.match(get('pull-request', 'owner', 'pr1').body, /release flow/);
});

// A box is a 32-bit size, a four-letter type and its body.
function box(kind: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(kind, 4, 'latin1');
  return Buffer.concat([head, body]);
}
test('a video’s length comes from its MP4 header, so clients can show it before playing', () => {
  const v0 = Buffer.alloc(100);
  v0.writeUInt32BE(1000, 12); // timescale
  v0.writeUInt32BE(42_000, 16); // duration
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', box('mvhd', v0))]);
  assert.equal(videoDuration(mp4), 42);
  const v1 = Buffer.alloc(112);
  v1[0] = 1;
  v1.writeUInt32BE(600, 20);
  v1.writeBigUInt64BE(4_500n, 24);
  assert.equal(videoDuration(Buffer.concat([box('moov', box('mvhd', v1))])), 7.5);
  // No moov, or a broken box, is simply unknown.
  assert.equal(videoDuration(box('ftyp', Buffer.from('isom0000'))), undefined);
  assert.equal(videoDuration(Buffer.from([0, 0, 0, 99, 109, 111, 111, 118])), undefined);
});
