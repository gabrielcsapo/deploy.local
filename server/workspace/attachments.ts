import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { root, db, get, list, save, remove, command, id, now, event } from './store.ts';
import { imageLimit, sniffImage } from './media-files.ts';
export function taskAttachments(owner: string, taskId: string) {
  get('task', owner, taskId);
  return list('attachment', owner).filter((a) => a.taskId === taskId);
}
export function attachmentBytes(owner: string, attachmentId: string) {
  const row = get('attachment', owner, attachmentId);
  get('task', owner, row.taskId);
  return { row, data: readFileSync(resolve(root, 'attachments', row.sha256)) };
}
export function validateAttachments(owner: string, taskId: string, ids: unknown = []) {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string'))
    throw new Error('At most 20 attachment ids are allowed');
  return [...new Set(ids)].map((id) => {
    const row = get('attachment', owner, id);
    if (row.taskId !== taskId || row.source !== 'user' || row.messageId)
      throw new Error('Attachment is unavailable for this message');
    if (row.kind !== 'image') throw new Error('Message input attachments must be images');
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
  },
) {
  get('task', owner, taskId);
  if (!data.length || data.length > imageLimit)
    throw Object.assign(new Error('Attachments must be nonempty and at most 20 MB'), {
      status: 413,
    });
  const image = sniffImage(data);
  if ((input.kind === 'image' || image) && (!image || !image.width || !image.height))
    throw new Error('Only PNG, JPEG, GIF and WebP images are accepted');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const signature = createHash('sha256')
    .update(JSON.stringify({ taskId, sha256, ...input }))
    .digest('hex');
  return command(
    owner,
    input.operationId,
    () => {
      let rows = taskAttachments(owner, taskId);
      if (input.source === 'computer-use') {
        const frames = rows.filter(
          (a) => a.sessionId === input.sessionId && a.source === 'computer-use',
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
      if (rows.reduce((n, row) => n + row.size, 0) + data.length > limit)
        throw Object.assign(
          new Error(
            'Task attachment storage limit reached; increase DEPLOY_TASK_MEDIA_LIMIT_BYTES',
          ),
          { status: 413 },
        );
      const directory = resolve(root, 'attachments');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(resolve(directory, sha256), data, { flag: 'wx', mode: 0o600 });
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
        kind: image ? 'image' : 'file',
        mimeType: image?.mimeType || 'application/octet-stream',
        size: data.length,
        width: image?.width,
        height: image?.height,
        name: basename(input.name || 'attachment').slice(0, 255),
        caption: String(input.caption || '').slice(0, 2000),
        source: input.source || 'user',
        sessionId: input.sessionId,
        actionId: input.actionId,
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
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > imageLimit)
      throw Object.assign(new Error('Attachment exceeds 20 MB'), { status: 413 });
    chunks.push(bytes);
  }
  return createAttachment(owner, taskId, Buffer.concat(chunks), {
    operationId: String(req.headers['x-operation-id'] || params.get('operationId') || ''),
    name: params.get('name') || 'image',
    caption: params.get('caption') || '',
    kind: params.get('kind') === 'file' ? 'file' : 'image',
  });
}
export function serveAttachment(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  attachmentId: string,
) {
  const { row, data } = attachmentBytes(owner, attachmentId);
  const etag = `"${row.sha256}"`;
  const headers = {
    ETag: etag,
    'Cache-Control': 'private, max-age=31536000, immutable',
    Vary: 'Authorization, X-Deploy-Username, X-Deploy-Token',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': row.mimeType,
    'Content-Disposition': `${row.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': data.length });
  res.end(data);
}
