import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { getArtifact, putArtifactBytes } from '../content-store.ts';
import { get, id, list, now, save } from '../workspace/store.ts';
import { readBytes, sendJson } from './attachments.ts';
import { fail } from './inbox.ts';

// Files dropped into a pull request's description. Any file is accepted; how it is served and
// shown depends on what its bytes are, never on the name or type the client claims alone.
export const pullFileLimit = 100 * 1024 * 1024;
export type PullFileKind = 'image' | 'video' | 'pdf' | 'text' | 'file';
export type PullFile = {
  id: string;
  pullId: string;
  name: string;
  kind: PullFileKind;
  /** The media type it is served with. */
  type: string;
  bytes: number;
  url: string;
  createdAt: string;
};

const textNames =
  /\.(txt|log|md|markdown|json|csv|tsv|ya?ml|toml|ini|xml|diff|patch|sh|ts|tsx|js|mjs|cjs|py|rb|go|rs|swift|sql|env\.example)$/i;
const text = (bytes: Buffer) => {
  if (bytes.includes(0)) return false;
  return bytes.equals(Buffer.from(bytes.toString('utf8')));
};
/** What the bytes are. SVG and HTML are text to read, never active content. */
export function classify(bytes: Buffer, claimed: string, name: string) {
  const starts = (signature: number[]) =>
    bytes.subarray(0, signature.length).equals(Buffer.from(signature));
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString('latin1');
  if (starts([137, 80, 78, 71, 13, 10, 26, 10]))
    return { kind: 'image', type: 'image/png' } as const;
  if (starts([255, 216, 255])) return { kind: 'image', type: 'image/jpeg' } as const;
  if (/^GIF8[79]a/.test(ascii(0, 6))) return { kind: 'image', type: 'image/gif' } as const;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    return { kind: 'image', type: 'image/webp' } as const;
  if (ascii(0, 5) === '%PDF-') return { kind: 'pdf', type: 'application/pdf' } as const;
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', type: 'video/webm' } as const;
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return brand === 'qt  '
      ? ({ kind: 'video', type: 'video/quicktime' } as const)
      : ({ kind: 'video', type: 'video/mp4' } as const);
  }
  if (
    (claimed.startsWith('text/') || claimed === 'application/json' || textNames.test(name)) &&
    text(bytes)
  )
    return { kind: 'text', type: 'text/plain; charset=utf-8' } as const;
  return { kind: 'file', type: 'application/octet-stream' } as const;
}
function validName(name: string) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 240 ||
    [...name].some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\',
    )
  )
    fail('Invalid file name');
  return name.trim();
}
function present(row: any): PullFile {
  return {
    id: row.id,
    pullId: row.pullId,
    name: row.name,
    kind: row.kind,
    type: row.type,
    bytes: row.bytes,
    url: `/api/v2/pulls/${encodeURIComponent(row.pullId)}/files/${row.id}`,
    createdAt: row.createdAt,
  };
}
export function pullFiles(owner: string, pullId: string): PullFile[] {
  return list('v2-pull-file', owner)
    .filter((row) => row.pullId === pullId)
    .map(present);
}
export function storePullFile(
  owner: string,
  pullId: string,
  bytes: Buffer,
  claimed: string,
  name: string,
) {
  const pull = get('pull-request', owner, pullId);
  if (pull.status === 'merged') fail('Merged pull requests cannot be changed', 409);
  if (!bytes.length) fail('The file is empty');
  if (bytes.length > pullFileLimit) fail('File exceeds the 100 MiB limit', 413);
  const fileName = validName(name);
  const { kind, type } = classify(bytes, claimed, fileName);
  const artifact = putArtifactBytes(bytes, { type: 'pull-description-file', mediaType: type });
  return present(
    save('v2-pull-file', owner, {
      id: id(),
      pullId: pull.id,
      name: fileName,
      kind,
      type,
      bytes: bytes.length,
      digest: artifact.digest,
      createdAt: now(),
    }),
  );
}
/** Images, video, PDFs and text open in place; everything else only downloads. */
function serve(req: IncomingMessage, res: ServerResponse, row: any) {
  const artifact = getArtifact(row.digest);
  if (!artifact) fail('File unavailable', 404);
  const size = statSync(artifact.localPath).size;
  const inline = row.kind !== 'file';
  const headers: Record<string, string | number> = {
    'Content-Type': row.type,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'Accept-Ranges': 'bytes',
  };
  // Safari plays video only from byte ranges.
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return true;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(artifact.localPath, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(artifact.localPath).pipe(res);
  return true;
}
export async function pullFilesApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const path = new URL(req.url!, 'http://localhost').pathname;
  const route = path.match(/^\/api\/v2\/pulls\/([^/]+)\/files(?:\/([a-f0-9-]+))?$/);
  if (!route) return false;
  const pullId = decodeURIComponent(route[1]);
  get('pull-request', owner, pullId);
  if (!route[2]) {
    if (req.method === 'GET') return sendJson(res, { files: pullFiles(owner, pullId) });
    if (req.method === 'POST') {
      const claimed = String(req.headers['content-type'] || '')
        .split(';')[0]
        .trim();
      let name = '';
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
      } catch {
        fail('Invalid file name');
      }
      const bytes = await readBytes(req, pullFileLimit);
      return sendJson(res, { file: storePullFile(owner, pullId, bytes, claimed, name) }, 201);
    }
    fail('Method not allowed', 405);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') fail('Method not allowed', 405);
  const row = get('v2-pull-file', owner, route[2]);
  if (row.pullId !== pullId) fail('Not found', 404);
  return serve(req, res, row);
}
