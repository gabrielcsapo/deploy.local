// OTLP trace schema generated from opentelemetry-proto v1.7.0 (Apache-2.0).
import protobuf from 'protobufjs/light.js';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from './kernel/db/sqlite.ts';
import schema from './otlp-schema.json' with { type: 'json' };
import { readTelemetryBytes } from './kernel/telemetry-http.ts';

const root = protobuf.Root.fromJSON(schema as protobuf.INamespace);
const requestType = root.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
);
export const otlpPath = '/__deploy/v1/traces';
export const batchBytes = 512 * 1024;
const unzip = promisify(gunzip);
const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
type Fields = Record<string, unknown>;
function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(400, 'Expected an OTLP message');
  return value as Fields;
}
function list(value: unknown): Fields[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(400, 'Expected a repeated OTLP field');
  return value.map(fields);
}
function identifier(value: unknown, length: number) {
  const hex = value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;
  if (
    typeof hex !== 'string' ||
    hex.length !== length ||
    !/^[\da-f]+$/i.test(hex) ||
    /^0+$/.test(hex)
  )
    return fail(400, 'Invalid span identifier');
  return hex.toLowerCase();
}
function nanos(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return fail(400, 'Invalid timestamp');
  const s =
    typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? BigInt(value).toString()
      : String(value);
  if (!/^\d{1,20}$/.test(s) || BigInt(s) > 18446744073709551615n)
    return fail(400, 'Invalid timestamp');
  return BigInt(s).toString();
}
function label(value: unknown) {
  return typeof value === 'string'
    ? // eslint-disable-next-line no-control-regex -- remove control characters from display names
      value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)
    : '';
}
function serviceName(resource: unknown) {
  if (!resource) return '';
  const entry = list(fields(resource).attributes).find((a) => a.key === 'service.name');
  return entry?.value ? label(fields(entry.value).stringValue) : '';
}
function enumCode(value: unknown) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    return fail(400, 'Invalid OTLP enum');
  return value;
}
// Store the HTTP dimensions used by Requests. Other attributes may carry payloads or credentials.
function httpAttributes(value: unknown, allowed: Set<string>, includeHttp = true) {
  const attributes: Record<string, string | number> = {};
  for (const a of list(value)) {
    if (includeHttp && a.key === 'http.response.status_code') {
      const code = Number(fields(a.value).intValue);
      if (Number.isInteger(code) && code >= 100 && code <= 599) attributes[a.key] = code;
    } else if (includeHttp && (a.key === 'http.route' || a.key === 'http.request.method')) {
      const val = label(fields(a.value).stringValue);
      if (val && !/[?#]/.test(val)) attributes[a.key] = val;
    } else if (typeof a.key === 'string' && allowed.has(a.key)) {
      const field = fields(a.value);
      const val = field.stringValue ?? field.intValue ?? field.doubleValue ?? field.boolValue;
      if (typeof val === 'string') attributes[a.key] = label(val);
      else if (typeof val === 'number' && Number.isFinite(val)) attributes[a.key] = val;
      else if (typeof val === 'boolean') attributes[a.key] = String(val);
    }
  }
  return attributes;
}
function spanRecord(span: Fields, service: string, scope: string, allowed: Set<string>) {
  const startTimeUnixNano = nanos(span.startTimeUnixNano),
    endTimeUnixNano = nanos(span.endTimeUnixNano);
  if (BigInt(endTimeUnixNano) < BigInt(startTimeUnixNano))
    return fail(400, 'Span ends before its start');
  const parent = span.parentSpanId;
  return {
    traceId: identifier(span.traceId, 32),
    spanId: identifier(span.spanId, 16),
    parentSpanId:
      parent == null || parent === '' || (parent instanceof Uint8Array && !parent.length)
        ? null
        : identifier(parent, 16),
    name: label(span.name),
    attributes: httpAttributes(span.attributes, allowed),
    service,
    scope,
    startTimeUnixNano,
    endTimeUnixNano,
    kind: enumCode(span.kind),
    status: span.status ? enumCode(fields(span.status).code) : 0,
    events: list(span.events)
      .slice(0, 32)
      .map((e) => ({
        name: label(e.name),
        timeUnixNano: nanos(e.timeUnixNano),
        ...(allowed.size ? { attributes: httpAttributes(e.attributes, allowed, false) } : {}),
      })),
    links: list(span.links)
      .slice(0, 16)
      .map((l) => ({ traceId: identifier(l.traceId, 32), spanId: identifier(l.spanId, 16) })),
  };
}
export function storeOtlp(db: Database, owner: string, input: unknown, now = Date.now()) {
  let keys: unknown;
  try {
    keys = JSON.parse(process.env.DEPLOY_OTEL_ATTRIBUTES ?? '{}')[owner];
  } catch {}
  const allowed = new Set<string>(
    Array.isArray(keys)
      ? keys
          .filter(
            (key): key is string => typeof key === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(key),
          )
          .slice(0, 16)
      : [],
  );
  const spans: ReturnType<typeof spanRecord>[] = [];
  for (const resource of list(fields(input).resourceSpans)) {
    const service = serviceName(resource.resource);
    for (const group of list(resource.scopeSpans)) {
      const scope = group.scope ? label(fields(group.scope).name) : '';
      for (const span of list(group.spans)) {
        if (spans.length >= 1024) fail(413, 'Too many spans');
        spans.push(spanRecord(span, service, scope, allowed));
      }
    }
  }
  db.transaction(() => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO otlp_spans (project,trace_id,span_id,received,span) VALUES (?,?,?,?,?)',
    );
    let added = 0;
    for (const span of spans)
      added += Number(
        insert.run(owner, span.traceId, span.spanId, now, JSON.stringify(span)).changes,
      );
    if (added) {
      const { count } = db
        .prepare('SELECT count(*) AS count FROM otlp_spans WHERE project=? AND received>=?')
        .get(owner, now - 60_000) as { count: number };
      if (count > 4096) fail(429, 'Project span budget exhausted');
    }
  })();
}
export async function receiveOtlp(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database,
  owner: string,
) {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  const binary = type === 'application/x-protobuf';
  let code = 200,
    message = '';
  try {
    if (!binary && type !== 'application/json')
      fail(415, 'Use application/x-protobuf or application/json');
    const encoding = req.headers['content-encoding']?.toLowerCase();
    if (encoding && encoding !== 'identity' && encoding !== 'gzip')
      fail(415, 'Unsupported encoding');
    let data = await readTelemetryBytes(req, batchBytes);
    if (encoding === 'gzip') {
      try {
        data = await unzip(data, { maxOutputLength: batchBytes });
      } catch (e) {
        fail(
          (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400,
          'Invalid or oversized gzip payload',
        );
      }
    }
    let value: unknown;
    try {
      value = binary
        ? requestType.toObject(requestType.decode(data), { longs: String })
        : JSON.parse(data.toString('utf8'), (key, parsed, token?: { source?: string }) => {
            // JSON exporters usually quote uint64s. Preserve the original decimal for
            // producers that send an unquoted nanosecond timestamp beyond 2^53.
            return typeof parsed === 'number' &&
              key.endsWith('UnixNano') &&
              token?.source &&
              /^\d+$/.test(token.source)
              ? token.source
              : parsed;
          });
    } catch {
      fail(400, 'Invalid OTLP trace payload');
    }
    storeOtlp(db, owner, value);
  } catch (err) {
    req.resume();
    code = (err as { status?: number }).status ?? 503;
    message = code === 503 ? 'Trace storage unavailable' : (err as Error).message;
  }
  respondOtlp(req, res, code, message);
}
export function respondOtlp(req: IncomingMessage, res: ServerResponse, code: number, message = '') {
  const binary =
    req.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/x-protobuf';
  res.writeHead(code, {
    'Content-Type': binary ? 'application/x-protobuf' : 'application/json',
    'Cache-Control': 'no-store',
    ...(code === 429 ? { 'Retry-After': '60' } : {}),
  });
  const rpcCodes: Record<number, number> = {
    400: 3,
    401: 16,
    404: 5,
    413: 8,
    415: 3,
    429: 8,
    503: 14,
  };
  const status = rpcCodes[code] ?? 2;
  // Full success is an empty ExportTraceServiceResponse. Errors use google.rpc.Status.
  res.end(
    binary
      ? code === 200
        ? Buffer.alloc(0)
        : protobuf.Writer.create().uint32(8).int32(status).uint32(18).string(message).finish()
      : JSON.stringify(code === 200 ? {} : { code: status, message }),
  );
}
