import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { openDatabase } from './kernel/db/sqlite.ts';
import { TELEMETRY_SCHEMA } from './telemetry-schema.ts';
import { serverTelemetryHandler } from './telemetry-http.ts';
import { issueTelemetryToken } from './kernel/auth/telemetry.ts';
import { readOtlp } from './features/observability/trace-spans.ts';
import { otlpPath, batchBytes, storeOtlp } from './otlp.ts';

// A real @opentelemetry/exporter-trace-otlp-proto export with an event and two attributes.
const binary = Buffer.from(
  'CtgBChwKGAoMc2VydmljZS5uYW1lEggKBndvcmtlchAAErcBCgkKB2xpYnJhcnkSqQEKEBAQEBAQEBAQEBAQEBAQEBASCPR/b3TS1fm1IgggICAgICAgICoMaW5kZXgubG9va3VwMAE5ANe2Ncs26hhB/9i4Ncs26hhKIAoZaHR0cC5yZXNwb25zZS5zdGF0dXNfY29kZRIDGMgBShkKDGRiLnN0YXRlbWVudBIJCgdwcml2YXRlUABaEgljdbg1yzbqGBIFcmVhZHkgAGAAcAB6AhgAhQEBAwAA',
  'base64',
);
const traceId = '10'.repeat(16);
test('OTLP/HTTP acknowledges SDK batches, scopes retries to the project and validates before writing', async (t) => {
  const db = openDatabase(':memory:');
  db.exec(TELEMETRY_SCHEMA);
  const token = issueTelemetryToken(db, 'product');
  const server = createServer(
    serverTelemetryHandler(
      () => true,
      () => db,
    ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + otlpPath;
  const send = (
    body: Uint8Array | string,
    type = 'application/json',
    encoding = 'identity',
    auth = token,
  ) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': type,
        'content-encoding': encoding,
        authorization: 'Bearer ' + auth,
      },
      body: typeof body === 'string' ? body : new Uint8Array(body),
    });
  const proto = await send(gzipSync(binary), 'application/x-protobuf', 'gzip');
  assert.equal(proto.status, 200);
  assert.equal((await proto.arrayBuffer()).byteLength, 0);
  assert.equal((await send(binary, 'application/x-protobuf')).status, 200);
  const spans = readOtlp(db, 'product', traceId).spans;
  assert.equal(spans.length, 1);
  assert.equal(spans[0].service, 'worker');
  assert.equal(spans[0].scope, 'library');
  assert.equal(spans[0].parentSpanId, '20'.repeat(8));
  assert.equal(spans[0].events[0].name, 'ready');
  assert.deepEqual(spans[0].attributes, { 'http.response.status_code': 200 });
  assert.deepEqual(readOtlp(db, 'other', traceId).spans, []);
  const span = {
    traceId,
    spanId: '01'.repeat(8),
    startTimeUnixNano: '1700000000000000001',
    endTimeUnixNano: '1700000000000000003',
    name: 'decode',
  };
  const payload = (spans: unknown[]) =>
    JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }], futureField: true });
  assert.equal((await send(payload([span, { ...span, traceId: '0'.repeat(32) }]))).status, 400);
  assert.equal(readOtlp(db, 'product', traceId).spans.length, 1);
  assert.equal((await send(payload([span]), 'application/json', 'identity', 'wrong')).status, 401);
  const json = await send(payload([span]));
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), {});
  assert.ok(
    readOtlp(db, 'product', traceId).spans.some(
      (s) => s.startTimeUnixNano === span.startTimeUnixNano,
    ),
  );
  assert.equal((await send('x', 'text/plain')).status, 415);
  assert.equal(
    (await send(gzipSync(Buffer.alloc(batchBytes + 1)), 'application/json', 'gzip')).status,
    413,
  );
});

test('the rolling span budget allows idempotent retries and expires by receive time', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec(TELEMETRY_SCHEMA);
    const batch = (offset: number, length: number) => ({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: Array.from({ length }, (_, i) => ({
                traceId,
                spanId: (offset + i + 1).toString(16).padStart(16, '0'),
                name: 'parse',
                startTimeUnixNano: '1000',
                endTimeUnixNano: '1001',
              })),
            },
          ],
        },
      ],
    });
    for (let i = 0; i < 4; i++) storeOtlp(db, 'test', batch(i * 1024, 1024), 100000);
    storeOtlp(db, 'test', batch(0, 8), 100001);
    assert.throws(() => storeOtlp(db, 'test', batch(4095, 2), 100001), { status: 429 });
    assert.equal(
      (db.prepare('select count(*) as n from otlp_spans').get() as { n: number }).n,
      4096,
    );
    storeOtlp(db, 'test', batch(4096, 1), 160001);
    assert.equal(readOtlp(db, 'test', traceId).truncated, true);
  } finally {
    db.close();
  }
});

test('retains explicitly selected attributes only for their project, including event attributes', () => {
  const db = openDatabase(':memory:');
  const previous = process.env.DEPLOY_OTEL_ATTRIBUTES;
  try {
    db.exec(TELEMETRY_SCHEMA);
    process.env.DEPLOY_OTEL_ATTRIBUTES = JSON.stringify({ demo: ['pool.name'] });
    const attrs = [
      { key: 'pool.name', value: { stringValue: 'reads' } },
      { key: 'password', value: { stringValue: 'secret' } },
    ];
    const batch = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: '01'.repeat(8),
                  startTimeUnixNano: '10',
                  endTimeUnixNano: '20',
                  attributes: attrs,
                  events: [{ name: 'lease', timeUnixNano: '15', attributes: attrs }],
                },
              ],
            },
          ],
        },
      ],
    };
    for (const owner of ['demo', 'other']) storeOtlp(db, owner, batch);
    const selected = readOtlp(db, 'demo', traceId).spans[0];
    assert.deepEqual(selected.attributes, { 'pool.name': 'reads' });
    assert.deepEqual(selected.events[0].attributes, { 'pool.name': 'reads' });
    assert.deepEqual(readOtlp(db, 'other', traceId).spans[0].attributes, {});
  } finally {
    if (previous === undefined) delete process.env.DEPLOY_OTEL_ATTRIBUTES;
    else process.env.DEPLOY_OTEL_ATTRIBUTES = previous;
    db.close();
  }
});
