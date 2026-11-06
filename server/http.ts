import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import { fail } from './errors.ts';

export function sendJson(res: ServerResponse, value: unknown, status?: number): true;
export function sendJson(
  res: ServerResponse,
  value: unknown,
  status: number,
  options: { headers?: OutgoingHttpHeaders; guard?: boolean },
): true | undefined;
export function sendJson(
  res: ServerResponse,
  value: unknown,
  status = 200,
  options: { headers?: OutgoingHttpHeaders; guard?: boolean } = {},
) {
  if (options.guard && (res.destroyed || res.writableEnded)) return;
  res.writeHead(
    status,
    options.headers ?? { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  );
  res.end(JSON.stringify(value));
  return true as const;
}

export async function readBytes(
  req: IncomingMessage,
  limit = 10 * 1024 * 1024,
  tooLarge = `File exceeds the ${limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)} MiB` : `${Math.round(limit / 1024)} KiB`} limit`,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      fail(tooLarge, 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readJson(
  req: IncomingMessage,
  limit = 128 * 1024,
  options: { tooLarge?: string; preserveReadErrors?: boolean } = {},
) {
  // Releases and agents propagate transport errors; attachments label them Invalid JSON.
  const bytes = options.preserveReadErrors
    ? await readBytes(req, limit, options.tooLarge)
    : undefined;
  try {
    return JSON.parse((bytes ?? (await readBytes(req, limit, options.tooLarge))).toString());
  } catch (error: any) {
    if (error.status) throw error;
    fail('Invalid JSON');
  }
}

export class RequestBodyTooLargeError extends Error {}

export function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(`Request body exceeds the ${maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
