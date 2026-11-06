import { packageWorkerFile } from './worker-file.ts';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { IncomingMessage } from 'node:http';
import { fail, limiter, MAX_DOC, MAX_FILE, tempRoot } from './store.ts';
let active = 0;
export async function publishBody(req: IncomingMessage) {
  if (active >= 2) fail('Two publishes are already being read. Try again shortly.', 429);
  active++;
  const path = join(tempRoot(), randomUUID());
  try {
    const limit = Math.ceil(MAX_FILE / 3) * 4 + MAX_DOC;
    if (Number(req.headers['content-length']) > limit) fail('Package body too large', 413);
    await mkdir(tempRoot(), { recursive: true, mode: 0o700 });
    await pipeline(
      Readable.from(req.iterator({ destroyOnReturn: false })),
      limiter(limit),
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      {
        signal: AbortSignal.timeout(600000),
      },
    );
    const worker = new Worker(
      packageWorkerFile(import.meta.url, 'package-body-worker.mjs', './body-worker.mjs'),
      { workerData: { path } },
    );
    const result = await new Promise<{
      document: any;
      attachment?: {
        filename: string;
        path: string;
        size: number;
        integrity: string;
        shasum: string;
      };
    }>((resolve, reject) => {
      worker.once('message', (value) =>
        value.error
          ? reject(Object.assign(new Error(value.error), { status: 422 }))
          : resolve(value),
      );
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code) reject(new Error('Package decoder failed'));
      });
    });
    return {
      ...result,
      dispose: async () => {
        await rm(path + '.tgz', { force: true });
      },
    };
  } catch (error) {
    req.resume();
    await rm(path + '.tgz', { force: true });
    throw error;
  } finally {
    active--;
    await rm(path, { force: true });
  }
}
export async function smallBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65536) {
      req.resume();
      fail('Body too large', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail('Invalid JSON');
  }
}
