import { sendJson } from '../kernel/http.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { root, get, save, now } from './store.ts';

const maximum = 2 * 1024 * 1024 * 1024;
const validOid = (oid: unknown): oid is string =>
  typeof oid === 'string' && /^[a-f0-9]{64}$/.test(oid);
const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
export function lfsPath(projectId: string, oid: string) {
  if (!/^[a-f0-9-]{36}$/.test(projectId) || !validOid(oid)) fail('Invalid object identity');
  return resolve(
    root,
    'repositories',
    projectId + '.git',
    'lfs',
    'objects',
    oid.slice(0, 2),
    oid.slice(2, 4),
    oid,
  );
}
async function stored(owner: string, projectId: string, oid: string) {
  let record;
  try {
    record = get('lfs-object', owner, projectId + ':' + oid);
  } catch {
    return null;
  }
  const info = await stat(lfsPath(projectId, oid)).catch(() => null);
  return info?.isFile() && info.size === record.size ? record : null;
}
async function body(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 256000) fail('Batch too large', 413);
  }
  return JSON.parse(raw);
}
export async function serveRepositoryLfs(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  projectId: string,
  suffix: string,
  readOnly: boolean,
) {
  const send = (value: any, status = 200) => {
    sendJson(res, value, status, {
      headers: {
        'Content-Type': 'application/vnd.git-lfs+json',
        'Cache-Control': 'no-store',
      },
    });
  };
  if (suffix === '/info/lfs/objects/batch' && req.method === 'POST') {
    const input = await body(req);
    if (!['upload', 'download'].includes(input.operation)) fail('Invalid LFS operation', 422);
    if (readOnly && input.operation !== 'download') fail('Workers have read-only LFS access', 403);
    if (
      (input.hash_algo && input.hash_algo !== 'sha256') ||
      (input.transfers && (!Array.isArray(input.transfers) || !input.transfers.includes('basic')))
    )
      fail('Only SHA-256 basic transfers are supported', 422);
    if (!Array.isArray(input.objects) || input.objects.length > 100)
      fail('Expected at most 100 objects', 422);
    const host = req.headers.host;
    if (!host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) fail('Invalid host');
    const protocol =
      (req.socket as any).encrypted || req.headers['x-forwarded-proto'] === 'https'
        ? 'https'
        : 'http';
    const base = `${protocol}://${host}/api/git/${projectId}/info/lfs`;
    const objects = await Promise.all(
      input.objects.map(async (object: any) => {
        if (
          !validOid(object.oid) ||
          !Number.isSafeInteger(object.size) ||
          object.size < 0 ||
          object.size > maximum
        )
          fail('Invalid LFS object or size', 422);
        const existing = await stored(owner, projectId, object.oid);
        const item = { oid: object.oid, size: object.size };
        if (existing && existing.size !== object.size)
          return { ...item, error: { code: 422, message: 'Object size mismatch' } };
        if (input.operation === 'download')
          return existing
            ? {
                ...item,
                actions: { download: { href: `${base}/objects/${object.oid}` } },
              }
            : { ...item, error: { code: 404, message: 'Object not found' } };
        return existing
          ? item
          : {
              ...item,
              actions: {
                upload: { href: `${base}/objects/${object.oid}` },
                verify: { href: `${base}/verify` },
              },
            };
      }),
    );
    return send({ transfer: 'basic', hash_algo: 'sha256', objects });
  }
  if (suffix === '/info/lfs/verify' && req.method === 'POST') {
    if (readOnly) fail('Workers have read-only LFS access', 403);
    const input = await body(req);
    if (!validOid(input.oid)) fail('Invalid object identity');
    const object = await stored(owner, projectId, input.oid);
    if (!object || object.size !== input.size) fail('Object missing or size mismatch', 404);
    return send({});
  }
  const match = suffix.match(/^\/info\/lfs\/objects\/([a-f0-9]{64})$/);
  if (!match) return fail('Unknown LFS route', 404);
  const oid = match[1],
    path = lfsPath(projectId, oid);
  if (req.method === 'GET') {
    const object = await stored(owner, projectId, oid);
    if (!object) fail('Object not found', 404);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': object.size,
      'Cache-Control': 'private, no-store',
    });
    await pipeline(createReadStream(path), res);
    return;
  }
  if (req.method !== 'PUT') fail('Unsupported LFS method', 405);
  if (readOnly) fail('Workers have read-only LFS access', 403);
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    fail('Object too large', 413);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.upload';
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maximum) return callback(new Error('Object too large'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {
      signal: AbortSignal.timeout(600000),
    });
    if (hash.digest('hex') !== oid || (declared !== undefined && size !== Number(declared)))
      fail('Object hash or size mismatch', 422);
    await rename(temporary, path);
    save('lfs-object', owner, {
      id: projectId + ':' + oid,
      projectId,
      oid,
      size,
      createdAt: now(),
    });
    send({});
  } finally {
    await rm(temporary, { force: true });
  }
}
