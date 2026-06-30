import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-capture-test-'));

const {
  createBodyTap,
  tapRequestBody,
  decodeBody,
  beginCapture,
  writeCapture,
  readCapture,
  pruneOldCaptures,
  REQUEST_BODY_CAP,
} = await import('./capture.ts');

function makeRecord(name: string, id: string) {
  return {
    id,
    deploymentName: name,
    timestamp: Date.now(),
    method: 'POST',
    path: '/api/things',
    query: null,
    status: 500,
    durationMs: 12,
    request: {
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      bodyBytes: 7,
      bodyTruncated: false,
    },
    response: {
      headers: { 'content-type': 'text/plain' },
      body: 'boom',
      bodyBytes: 4,
      bodyTruncated: false,
    },
  };
}

describe('body taps', () => {
  test('copies chunks up to the cap and keeps counting after', async () => {
    const stream = new PassThrough();
    const tap = createBodyTap(stream, 10);
    stream.write(Buffer.from('12345'));
    stream.write(Buffer.from('6789abcdef')); // crosses the cap at 10
    stream.write(Buffer.from('overflow'));
    stream.end();
    await sleep(10);
    assert.strictEqual(tap.buffered, 10);
    assert.strictEqual(tap.total, 23);
    assert.strictEqual(tap.truncated, true);
    assert.strictEqual(Buffer.concat(tap.chunks).toString(), '123456789a');
  });

  test('tapRequestBody skips bodyless methods and is idempotent', () => {
    const fakeReq = new PassThrough() as unknown as import('node:http').IncomingMessage;
    assert.strictEqual(tapRequestBody(fakeReq, 'GET'), null);
    assert.strictEqual(tapRequestBody(fakeReq, 'HEAD'), null);
    const first = tapRequestBody(fakeReq, 'POST');
    assert.ok(first);
    assert.strictEqual(tapRequestBody(fakeReq, 'POST'), first);
    assert.strictEqual(REQUEST_BODY_CAP, 16 * 1024);
  });

  test('decodeBody handles empty, text, and binary content', () => {
    assert.deepStrictEqual(decodeBody(null, 'text/html'), {
      body: null,
      bodyBytes: 0,
      bodyTruncated: false,
    });
    const textTap = { chunks: [Buffer.from('hello')], buffered: 5, total: 5, truncated: false };
    assert.strictEqual(decodeBody(textTap, 'text/html').body, 'hello');
    const binTap = { chunks: [Buffer.from([0, 1, 2])], buffered: 3, total: 3, truncated: false };
    assert.match(decodeBody(binTap, 'image/png').body!, /3 bytes of image\/png omitted/);
  });
});

describe('capture files', () => {
  test('write/read roundtrip', async () => {
    const id = beginCapture('roundtrip-app');
    assert.ok(id);
    writeCapture(makeRecord('roundtrip-app', id!));
    await sleep(50); // write is fire-and-forget
    const loaded = await readCapture('roundtrip-app', id!);
    assert.ok(loaded);
    assert.strictEqual(loaded!.status, 500);
    assert.strictEqual(loaded!.response!.body, 'boom');
  });

  test('readCapture rejects unsafe ids', async () => {
    assert.strictEqual(await readCapture('app', '../../../etc/passwd'), null);
    assert.strictEqual(await readCapture('app', 'no/slashes'), null);
    assert.strictEqual(await readCapture('app', 'does-not-exist'), null);
  });

  test('rate limit caps captures per app per minute', () => {
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      if (beginCapture('stormy-app')) allowed++;
    }
    assert.strictEqual(allowed, 30);
  });

  test('pruneOldCaptures removes only stale files', async () => {
    const oldId = beginCapture('prune-app')!;
    const freshId = beginCapture('prune-app')!;
    writeCapture(makeRecord('prune-app', oldId));
    writeCapture(makeRecord('prune-app', freshId));
    await sleep(50);
    const dir = join(process.env.DEPLOY_DATA_DIR!, 'captures', 'prune-app');
    assert.strictEqual((await readdir(dir)).length, 2);
    // Age one file past the cutoff.
    const old = new Date(Date.now() - 30 * 86_400_000);
    await utimes(join(dir, `${oldId}.json`), old, old);
    const removed = await pruneOldCaptures(14 * 86_400_000);
    assert.strictEqual(removed, 1);
    assert.strictEqual(await readCapture('prune-app', oldId), null);
    assert.ok(await readCapture('prune-app', freshId));
  });
});
