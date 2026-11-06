import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, readBytes, readJson, RequestBodyTooLargeError, sendJson } from './http.ts';

const request = (chunks: (Buffer | string)[]) =>
  Readable.from(chunks.map((v) => Buffer.from(v))) as unknown as IncomingMessage;

test('JSON readers preserve exact boundaries, empty-body errors and route-specific limits', async () => {
  assert.deepEqual(await readJson(request(['{', '"x":1}']), 7), { x: 1 });
  await assert.rejects(readJson(request(['{}']), 1), {
    message: 'File exceeds the 0 KiB limit',
    status: 413,
  });
  await assert.rejects(
    readJson(request(['{}']), 1, { tooLarge: 'Request body too large', preserveReadErrors: true }),
    { message: 'Request body too large', status: 413 },
  );
  await assert.rejects(readJson(request([])), { message: 'Invalid JSON', status: 400 });
  await assert.rejects(readJson(request(['{'])), { message: 'Invalid JSON', status: 400 });
  assert.deepEqual(await readBytes(request(['a', 'b']), 2), Buffer.from('ab'));
});

test('releases/agents preserve transport failures while attachments report Invalid JSON', async () => {
  const broken = () =>
    Readable.from(
      (async function* () {
        yield Buffer.from('{');
        throw new Error('transport failed');
      })(),
    ) as unknown as IncomingMessage;
  await assert.rejects(readJson(broken()), { message: 'Invalid JSON', status: 400 });
  await assert.rejects(readJson(broken(), 128, { preserveReadErrors: true }), {
    message: 'transport failed',
  });
});

test('raw API body reader keeps its error class, byte message and draining behavior', async () => {
  const stream = new PassThrough();
  const body = readBody(stream as unknown as IncomingMessage, 2);
  stream.write(Buffer.from('ab'));
  stream.write(Buffer.from('c'));
  stream.end(Buffer.from('remaining'));
  await assert.rejects(
    body,
    (error) =>
      error instanceof RequestBodyTooLargeError &&
      error.message === 'Request body exceeds the 2 byte limit',
  );
  assert.equal(stream.destroyed, false);
  const exact = new PassThrough();
  const bytes = readBody(exact as unknown as IncomingMessage, 2);
  exact.end('ab');
  assert.deepEqual(await bytes, Buffer.from('ab'));
});

test('sendJson preserves headers, status, JSON and optional ended-response guard', () => {
  const writes: unknown[] = [];
  const res = {
    writeHead: (...args: unknown[]) => writes.push(args),
    end: (body: unknown) => writes.push(body),
    destroyed: false,
    writableEnded: false,
  };
  assert.equal(sendJson(res as unknown as ServerResponse, { ok: true }, 202), true);
  assert.deepEqual(writes, [
    [202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }],
    '{"ok":true}',
  ]);
  writes.length = 0;
  res.writableEnded = true;
  assert.equal(sendJson(res as unknown as ServerResponse, {}, 200, { guard: true }), undefined);
  assert.deepEqual(writes, []);
  sendJson(res as unknown as ServerResponse, null, 400, {
    headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
  });
  assert.deepEqual(writes, [[400, { 'Content-Type': 'application/vnd.git-lfs+json' }], 'null']);
});
