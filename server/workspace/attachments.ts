import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync, createReadStream, linkSync } from 'node:fs';
import { open, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { sniffVideo, videoLimit, mp4Duration } from './video-files.ts';
import { resolve, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { root, db, get, list, save, remove, command, id, now, event } from './store.ts';
import { imageLimit, sniffImage, sniffImageFile } from './media-files.ts';
export function taskAttachments(owner: string, taskId: string) {
  get('task', owner, taskId);
  return list('attachment', owner).filter((a) => a.taskId === taskId);
}
export function attachmentBytes(owner: string, attachmentId: string) {
  const row = get('attachment', owner, attachmentId);
  get('task', owner, row.taskId);
  return readFile(resolve(root, 'attachments', row.sha256)).then((data) => ({ row, data }));
}
export function validateAttachments(owner: string, taskId: string, ids: unknown = []) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string'))
    throw new Error('At most 20 attachment ids are allowed');
  return [...new Set(ids)].map((id) => {
    const row = get('attachment', owner, id);
    if (row.taskId !== taskId || row.source !== 'user' || row.messageId)
      throw new Error('Attachment is unavailable for this message');
    if (!['image', 'video'].includes(row.kind))
      throw new Error('Message input attachments must be images or videos');
    return row;
  });
}
export function createAttachment(
  owner: string,
  taskId: string,
  data: Buffer,
  input: {
    operationId: string;
    name?: string;
    caption?: string;
    source?: string;
    runId?: string;
    messageId?: string;
    kind?: string;
    sessionId?: string;
    actionId?: string;
    jobId?: string;
  },
) {
  const image = sniffImage(data);
  const video = sniffVideo(data);
  checkMedia(data.length, image, video, input.kind);
  const sha256 = createHash('sha256').update(data).digest('hex');
  return commitAttachment(
    owner,
    taskId,
    {
      size: data.length,
      image,
      video,
      sha256,
      duration: video && video.mimeType !== 'video/webm' ? mp4Duration(data) : null,
    },
    input,
    (path) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
  );
}
type AttachmentInput = Parameters<typeof createAttachment>[3];
/** Text files (job logs and reports) skip media checks; callers validate and redact content. */
export function createTextAttachment(
  owner: string,
  taskId: string,
  data: Buffer,
  input: AttachmentInput & { preview: string },
) {
  if (!data.length) throw new Error('Attachments must be nonempty');
  const { preview, ...rest } = input;
  return commitAttachment(
    owner,
    taskId,
    {
      size: data.length,
      image: null,
      video: null,
      sha256: createHash('sha256').update(data).digest('hex'),
      duration: null,
      // Always served as plain text with nosniff, whatever the original extension.
      mimeType: 'text/plain; charset=utf-8',
      preview,
    },
    rest,
    (path) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
  );
}
function checkMedia(
  size: number,
  image: ReturnType<typeof sniffImage>,
  video: ReturnType<typeof sniffVideo>,
  kind?: string,
) {
  const limit = video ? videoLimit() : imageLimit;
  if (!size || size > limit)
    throw Object.assign(
      new Error(
        video
          ? `Video exceeds ${limit} bytes (default 200 MB)`
          : 'Attachments must be nonempty and at most 20 MB',
      ),
      { status: 413 },
    );
  if ((kind === 'image' || image) && !video && (!image || !image.width || !image.height))
    throw new Error('Only PNG, JPEG, GIF and WebP images are accepted');
  if (kind === 'media' && !image && !video)
    throw new Error('Only PNG, JPEG, GIF, WebP, MP4, MOV and WebM media are accepted');
  if (kind === 'video' && !video) throw new Error('Only MP4, MOV and WebM videos are accepted');
}
function commitAttachment(
  owner: string,
  taskId: string,
  media: {
    size: number;
    image: ReturnType<typeof sniffImage>;
    video: ReturnType<typeof sniffVideo>;
    sha256: string;
    duration: number | null;
    /** Non-media files only: a safe served type and a short preview for clients. */
    mimeType?: string;
    preview?: string;
  },
  input: AttachmentInput,
  persist: (path: string) => void,
) {
  get('task', owner, taskId);
  const { image, video, sha256, size, duration } = media;
  const signature = createHash('sha256')
    .update(JSON.stringify({ taskId, sha256, ...input }))
    .digest('hex');
  return command(
    owner,
    input.operationId,
    () => {
      let rows = taskAttachments(owner, taskId);
      if (input.source === 'computer-use' && !video) {
        const frames = rows.filter(
          (a) =>
            a.sessionId === input.sessionId && a.source === 'computer-use' && a.kind === 'image',
        );
        const duplicate = frames.find((a) => a.actionId === input.actionId);
        if (duplicate) return duplicate;
        for (const old of frames.slice(0, Math.max(0, frames.length - 49)))
          deleteAttachment(owner, old.id);
        rows = taskAttachments(owner, taskId);
      }
      const configured = Number(process.env.DEPLOY_TASK_MEDIA_LIMIT_BYTES || 200 * 1024 * 1024);
      const limit =
        Number.isSafeInteger(configured) && configured > 0 ? configured : 200 * 1024 * 1024;
      if (rows.reduce((n, row) => n + row.size, 0) + size > limit)
        throw Object.assign(
          new Error(
            'Task attachment storage limit reached; increase DEPLOY_TASK_MEDIA_LIMIT_BYTES',
          ),
          { status: 413 },
        );
      const directory = resolve(root, 'attachments');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        persist(resolve(directory, sha256));
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
      }
      const attachment = save('attachment', owner, {
        id: id(),
        owner,
        taskId,
        runId: input.runId,
        messageId: input.messageId,
        sha256,
        kind: video ? 'video' : image ? 'image' : 'file',
        mimeType:
          video?.mimeType || image?.mimeType || media.mimeType || 'application/octet-stream',
        ...(media.preview !== undefined ? { preview: media.preview } : {}),
        size,
        duration,
        width: image?.width,
        height: image?.height,
        name: basename(input.name || 'attachment').slice(0, 255),
        caption: String(input.caption || '').slice(0, 2000),
        source: input.source || 'user',
        sessionId: input.sessionId,
        actionId: input.actionId,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        createdAt: now(),
      });
      event(owner, taskId, input.runId || null, 'attachment.created', { id: attachment.id });
      return attachment;
    },
    signature,
  );
}
export function deleteAttachment(owner: string, attachmentId: string) {
  const row = get('attachment', owner, attachmentId);
  remove('attachment', owner, attachmentId);
  const references = db
    .prepare(
      "SELECT 1 FROM records WHERE kind='attachment' AND json_extract(data,'$.sha256')=? LIMIT 1",
    )
    .get(row.sha256);
  if (!references)
    setImmediate(() => {
      // A surrounding transaction may roll back; check again after it has committed.
      if (
        db.open &&
        !db
          .prepare(
            "SELECT 1 FROM records WHERE kind='attachment' AND json_extract(data,'$.sha256')=? LIMIT 1",
          )
          .get(row.sha256)
      ) {
        try {
          unlinkSync(resolve(root, 'attachments', row.sha256));
        } catch (error: any) {
          if (error.code !== 'ENOENT') console.error('Attachment cleanup:', error.message);
        }
      }
    });
}
export async function uploadAttachment(
  req: IncomingMessage,
  owner: string,
  taskId: string,
  params: URLSearchParams,
) {
  get('task', owner, taskId);
  return streamAttachment(req, owner, taskId, {
    operationId: String(req.headers['x-operation-id'] || params.get('operationId') || ''),
    name: params.get('name') || 'attachment',
    caption: params.get('caption') || '',
    kind: params.get('kind') || 'media',
  });
}
/** Bounded memory: backpressure on every disk write; only retain a 64 KiB sniff prefix. */
export async function streamAttachment(
  stream: AsyncIterable<Buffer | Uint8Array>,
  owner: string,
  taskId: string,
  input: AttachmentInput,
) {
  get('task', owner, taskId);
  if (!input.operationId) throw new Error('operationId required');
  const directory = resolve(root, 'attachments');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, '.upload-' + randomUUID());
  const file = await open(path, 'wx', 0o600);
  let size = 0,
    prefix = Buffer.alloc(0);
  const hash = createHash('sha256');
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > Math.max(imageLimit, videoLimit()))
        throw Object.assign(new Error('Video exceeds configured limit (default 200 MB)'), {
          status: 413,
        });
      if (prefix.length < 65536)
        prefix = Buffer.concat([prefix, bytes.subarray(0, 65536 - prefix.length)]);
      const detectedVideo = sniffVideo(prefix);
      if (size > (detectedVideo ? videoLimit() : imageLimit))
        checkMedia(size, sniffImage(prefix), detectedVideo, input.kind);
      hash.update(bytes);
      // FileHandle.write may write fewer bytes than requested.
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        offset += bytesWritten;
      }
    }
    await file.close();
    const image = sniffImageFile(path, prefix),
      video = sniffVideo(prefix);
    checkMedia(size, image, video, input.kind);
    return commitAttachment(
      owner,
      taskId,
      {
        size,
        image,
        video,
        sha256: hash.digest('hex'),
        duration: video?.mimeType !== 'video/webm' && video ? mp4Duration(path) : null,
      },
      input,
      (target) => linkSync(path, target),
    );
  } finally {
    await file.close().catch(() => {});
    await rm(path, { force: true });
  }
}
export function parseMediaRange(
  value: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    ![start, end].every(Number.isSafeInteger) ||
    start < 0 ||
    start >= size ||
    end < start ||
    (!match[1] && Number(match[2]) === 0)
  )
    return null;
  return { start, end };
}
export async function serveAttachment(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  attachmentId: string,
) {
  const row = get('attachment', owner, attachmentId);
  get('task', owner, row.taskId);
  const path = resolve(root, 'attachments', row.sha256);
  const etag = `"${row.sha256}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'private, max-age=31536000, immutable',
    Vary: 'Authorization, X-Deploy-Username, X-Deploy-Token, Cookie',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': row.mimeType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${['image', 'video'].includes(row.kind) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const rangeHeader = req.headers.range;
  if (rangeHeader && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const range = parseMediaRange(rangeHeader, row.size);
    if (!range) {
      res.writeHead(416, {
        ...headers,
        'Content-Range': `bytes */${row.size}`,
        'Content-Length': 0,
      });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': `bytes ${range.start}-${range.end}/${row.size}`,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(createReadStream(path, range), res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': row.size });
  if (req.method === 'HEAD') res.end();
  else if (row.kind === 'video') await pipeline(createReadStream(path), res);
  else res.end(await readFile(path));
}
