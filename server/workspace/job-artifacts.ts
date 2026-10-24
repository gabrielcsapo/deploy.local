// Coordinator side of job artifacts: accept a finished job's files from the worker that ran it,
// store them through the task attachment pipeline, and let the agent read bounded text excerpts.
import { closeSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createTextAttachment, deleteAttachment, streamAttachment } from './attachments.ts';
import { redactDeploymentLog } from './application-deployment.ts';
import { db, event, get, root, save, now } from './store.ts';
import { sniffImage } from './media-files.ts';
import { sniffVideo } from './video-files.ts';
import {
  artifactLimits,
  isTextArtifactName,
  matchesArtifactRequest,
  type ArtifactResult,
} from './job-artifact-spec.ts';
import type { AgentScope } from './coordination.ts';

const status = (message: string, code: number) =>
  Object.assign(new Error(message), { status: code });
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Common credential shapes, in addition to the deployment log's key=value and URL redaction. */
export function redactArtifactText(value: string) {
  return redactDeploymentLog(value)
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      '[redacted private key]',
    )
    .replace(
      /("(?:password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key|client[_-]?secret|private[_-]?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"[redacted]"',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer [redacted]')
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]');
}

/** Reads up to `limit` bytes, then fails; never buffers more than one chunk past the limit. */
async function* bounded(
  chunks: AsyncIterable<Buffer | Uint8Array>,
  limit: number,
  prefix: Buffer[] = [],
) {
  let size = 0;
  for (const chunk of prefix) {
    size += chunk.length;
    yield chunk;
  }
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > limit)
      throw status(`Artifact exceeds the ${megabytes(limit)} limit for this job`, 413);
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

function assigned(
  owner: string,
  workerId: string,
  jobId: string,
  generation: string,
  instance: string,
) {
  const job = get('job', owner, jobId);
  if (
    job.workerId !== workerId ||
    job.generation !== generation ||
    job.instanceId !== instance ||
    job.status !== 'running'
  )
    throw status('Artifact upload is not assigned to this worker and job', 403);
  if (!job.artifactPaths?.length) throw status('This job did not request artifacts', 403);
  return job;
}

/**
 * Store one artifact for a running job. Only the worker process that holds the job generation may
 * upload, only paths the agent requested are accepted, and per-file, per-job and count caps apply.
 */
export async function receiveJobArtifact(
  stream: AsyncIterable<Buffer | Uint8Array> | AsyncIterator<Buffer | Uint8Array>,
  owner: string,
  workerId: string,
  jobId: string,
  params: URLSearchParams,
  instanceId: string,
): Promise<ArtifactResult> {
  const generation = params.get('generation') || '';
  const job = assigned(owner, workerId, jobId, generation, instanceId);
  const path = String(params.get('path') || '');
  if (!path || path.length > 300 || !matchesArtifactRequest(path, job.artifactPaths))
    throw status('Artifact path was not requested for this job', 403);
  const caption = String(params.get('caption') || '').slice(0, 300);
  const name = path.split('/').at(-1)!;
  const operationId = `job-artifact:${job.id}:${job.generation}:${path}`;
  const stored = (job.artifacts || []).filter((entry: ArtifactResult) => entry.attachmentId);
  const existing = stored.find((entry: ArtifactResult) => entry.path === path);
  if (existing) return existing;
  if (stored.length >= artifactLimits.files)
    throw status(`Artifact limit of ${artifactLimits.files} files per job reached`, 413);
  const used = stored.reduce((sum: number, entry: ArtifactResult) => sum + (entry.bytes || 0), 0);
  const remaining = artifactLimits.jobBytes - used;
  if (remaining <= 0)
    throw status(`Per-job artifact limit of ${megabytes(artifactLimits.jobBytes)} reached`, 413);

  // Classify from content, never from the worker's claim: media sniffing first, then UTF-8 text.
  const iterator =
    Symbol.asyncIterator in stream
      ? (stream as AsyncIterable<Buffer | Uint8Array>)[Symbol.asyncIterator]()
      : stream;
  const rest = { [Symbol.asyncIterator]: () => iterator };
  const head: Buffer[] = [];
  let headLength = 0;
  while (headLength < 65536) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    head.push(chunk);
    headLength += chunk.length;
    if (headLength > Math.min(artifactLimits.fileBytes, remaining))
      throw status(
        `Artifact exceeds the ${megabytes(Math.min(artifactLimits.fileBytes, remaining))} limit for this job`,
        413,
      );
  }
  const prefix = Buffer.concat(head);
  const input = {
    operationId,
    name,
    caption,
    source: 'job-artifact',
    runId: job.runId,
    jobId: job.id,
  };
  let attachment: any;
  if (sniffImage(prefix) || sniffVideo(prefix) || (prefix[0] === 0xff && prefix[1] === 0xd8)) {
    attachment = await streamAttachment(
      bounded(rest, Math.min(artifactLimits.fileBytes, remaining), [prefix]),
      owner,
      job.taskId,
      { ...input, kind: 'media' },
    );
  } else if (isTextArtifactName(name)) {
    const limit = Math.min(artifactLimits.textBytes, remaining);
    const chunks: Buffer[] = [];
    for await (const chunk of bounded(rest, limit, [prefix])) chunks.push(chunk);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw status('Text artifact is not valid UTF-8', 415);
    }
    if (text.includes('\u0000')) throw status('Text artifact contains binary data', 415);
    const redacted = redactArtifactText(text.replace(/^﻿/, ''));
    attachment = createTextAttachment(owner, job.taskId, Buffer.from(redacted), {
      ...input,
      preview: redacted.slice(0, 600),
    });
  } else
    throw status(
      'Only images (PNG, JPEG, GIF, WebP), videos (MP4, MOV, WebM) and text files (.txt, .log, .json, .xml, .md and similar) can be job artifacts',
      415,
    );
  const result: ArtifactResult = {
    path,
    name: attachment.name,
    caption: attachment.caption,
    attachmentId: attachment.id,
    kind: attachment.kind,
    bytes: attachment.size,
  };
  try {
    db.transaction(() => {
      const current = assigned(owner, workerId, jobId, generation, instanceId);
      const entries = current.artifacts || [];
      if (!entries.some((entry: ArtifactResult) => entry.attachmentId === attachment.id))
        save('job', owner, { ...current, artifacts: [...entries, result], updatedAt: now() });
    }).immediate();
  } catch (error) {
    // The job moved on while the file streamed; do not keep an attachment nothing references.
    if (
      !(get('job', owner, jobId).artifacts || []).some(
        (entry: ArtifactResult) => entry.attachmentId === attachment.id,
      )
    )
      deleteAttachment(owner, attachment.id);
    throw error;
  }
  event(owner, job.taskId, job.runId, 'job.artifact', {
    jobId: job.id,
    attachmentId: attachment.id,
    kind: attachment.kind,
  });
  return result;
}

/** HTTP entry point. Unread bodies are drained (bounded) so the worker always reads the reason. */
export async function jobArtifactRequest(
  req: IncomingMessage,
  owner: string,
  workerId: string,
  jobId: string,
  params: URLSearchParams,
  workerIdentity?: string,
) {
  try {
    if (!workerIdentity || workerIdentity !== workerId)
      throw status('Only the worker that ran this job can upload its artifacts', 403);
    // Leaving the iterator early (a cap, a bad type) must not destroy the socket: the worker
    // still needs to read the JSON reason.
    return await receiveJobArtifact(
      req.iterator({ destroyOnReturn: false }),
      owner,
      workerId,
      jobId,
      params,
      String(req.headers['x-worker-instance'] || ''),
    );
  } finally {
    await drain(req);
  }
}
function drain(req: IncomingMessage) {
  if (req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise<void>((done) => {
    let size = 0;
    const timer = setTimeout(finish, 30000);
    function finish() {
      clearTimeout(timer);
      req.off('data', count);
      done();
    }
    function count(chunk: Buffer) {
      size += chunk.length;
      if (size > artifactLimits.fileBytes) {
        req.destroy();
        finish();
      }
    }
    req.on('data', count);
    req.once('end', finish);
    req.once('close', finish);
    req.once('error', finish);
    req.resume();
  });
}

/** Bounded excerpt of a stored text artifact for the agent; never returns media bytes. */
export function readJobArtifact(scope: AgentScope, args: any) {
  if (typeof args?.attachmentId !== 'string' || !args.attachmentId)
    throw new Error('attachmentId required');
  const row = get('attachment', scope.owner, args.attachmentId);
  if (row.taskId !== scope.taskId) throw status('Attachment belongs to another task', 403);
  if (
    row.source !== 'job-artifact' ||
    row.kind !== 'file' ||
    !String(row.mimeType).startsWith('text/')
  )
    throw new Error(
      'Only text job artifacts can be read. Show images and videos in your reply as ![caption](/api/workspace/attachments/<attachmentId>).',
    );
  const offset = args.offset ?? 0,
    maxBytes = args.maxBytes ?? 8192;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('offset must be a non-negative integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16384)
    throw new Error('maxBytes must be 1–16384');
  const start = Math.min(offset, row.size);
  const buffer = Buffer.alloc(Math.min(maxBytes, row.size - start));
  const fd = openSync(resolve(root, 'attachments', row.sha256), 'r');
  let length = 0;
  try {
    for (let n = 1; n && length < buffer.length; length += n)
      n = readSync(fd, buffer, length, buffer.length - length, start + length);
  } finally {
    closeSync(fd);
  }
  // Never split a UTF-8 sequence: drop a partial trailing character and resume from it next time.
  let end = length;
  if (start + length < row.size) {
    let back = end - 1;
    while (back >= 0 && back > end - 4 && (buffer[back] & 0xc0) === 0x80) back--;
    if (back >= 0) {
      const lead = buffer[back],
        width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (back + width > end) end = back;
    }
  }
  const next = start + end;
  return {
    attachmentId: row.id,
    name: row.name,
    jobId: row.jobId,
    offset: start,
    bytes: end,
    totalBytes: row.size,
    nextOffset: next < row.size ? next : null,
    text: buffer.subarray(0, end).toString('utf8'),
  };
}
