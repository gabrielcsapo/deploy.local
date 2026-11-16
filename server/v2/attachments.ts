import './agent-chat-source-port.ts';
import { readBytes, readJson, sendJson } from '../kernel/http.ts';
export { readBytes, readJson, sendJson } from '../kernel/http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Attachment } from '../../shared/v2/contracts.ts';
import { putArtifactBytes } from '../content-store.ts';
import { db, id, list, save } from '../workspace/store.ts';
import { repositoryRead } from '../workspace/repositories.ts';
import './computers.ts';
import { fail } from '../kernel/errors.ts';
import { attachmentBytes } from '../features/agents/agent-chat.ts';
export { mapMediaEvent } from '../features/agents/media-event.ts';
export {
  attachmentBytes,
  attachmentRecord,
  chatModel,
  ownedAttachments,
  sendAgentMessage,
} from '../features/agents/agent-chat.ts';

export const uploadLimit = 10 * 1024 * 1024;
export function validateFile(bytes: Buffer, type: string) {
  if (!bytes.length) fail('The file is empty');
  if (bytes.length > uploadLimit) fail('File exceeds the 10 MiB limit', 413);
  const starts = (signature: number[]) =>
    bytes.subarray(0, signature.length).equals(Buffer.from(signature));
  const valid =
    type === 'image/png'
      ? starts([137, 80, 78, 71, 13, 10, 26, 10])
      : type === 'image/jpeg'
        ? starts([255, 216, 255])
        : type === 'image/gif'
          ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
          : type === 'image/webp'
            ? bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP'
            : type === 'application/pdf'
              ? bytes.subarray(0, 5).toString() === '%PDF-'
              : [
                    'application/zip',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  ].includes(type)
                ? starts([80, 75, 3, 4])
                : ['text/plain', 'text/csv', 'text/markdown', 'application/json'].includes(type)
                  ? !bytes.includes(0) && bytes.equals(Buffer.from(bytes.toString('utf8')))
                  : false;
  if (!valid) fail('Unsupported file type or file contents do not match its type', 415);
  if (type === 'application/json') {
    try {
      JSON.parse(bytes.toString());
    } catch {
      fail('Invalid JSON file', 415);
    }
  }
}
export function storeAttachment(
  owner: string,
  bytes: Buffer,
  type: string,
  name: string,
  kind?: Attachment['kind'],
) {
  validateFile(bytes, type);
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 240 ||
    [...name].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        character === '/' ||
        character === '\\',
    )
  )
    fail('Invalid file name');
  const artifact = putArtifactBytes(bytes, { type: 'conversation-attachment', mediaType: type });
  const attachment: Attachment = {
    kind: kind || (type.startsWith('image/') ? 'photo' : 'file'),
    name,
    bytes: bytes.length,
    ref: `/api/conversation-attachments/${id()}`,
  };
  save('v2-attachment', owner, {
    id: attachment.ref.split('/').at(-1),
    attachment,
    digest: artifact.digest,
    type,
  });
  return attachment;
}
export function bindRunAttachments(owner: string, run: any, attachments: Attachment[]) {
  save('run', owner, { ...run, attachments });
  const message = list('message', owner)
    .filter((m) => m.taskId === run.taskId && m.role === 'user')
    .at(-1);
  if (message) {
    save('message', owner, { ...message, attachments });
    // Keep the existing message ID so the typed conversation has one user turn.
    db.prepare(
      "UPDATE events SET payload=? WHERE owner=? AND type='message' AND json_extract(payload,'$.id')=?",
    ).run(JSON.stringify({ ...message, attachments }), owner, message.id);
  }
}
export async function attachmentsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname === '/api/conversation-attachments' && req.method === 'POST') {
    const type = String(req.headers['content-type'] || '').split(';')[0];
    const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    return sendJson(
      res,
      { attachment: storeAttachment(owner, await readBytes(req), type, name) },
      201,
    );
  }
  const file = url.pathname.match(/^\/api\/conversation-attachments\/([a-f0-9-]+)$/);
  if (file && req.method === 'GET') {
    const record = await attachmentBytes(owner, url.pathname);
    res.writeHead(200, {
      'Content-Type': record.type,
      'Content-Length': record.bytes.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${record.type.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(record.attachment.name)}`,
    });
    res.end(record.bytes);
    return true;
  }
  const project = url.pathname.match(/^\/api\/conversation-attachments\/projects\/([^/]+)$/);
  if (project) {
    const projectId = decodeURIComponent(project[1]);
    if (req.method === 'GET')
      return sendJson(res, await repositoryRead(owner, projectId, 'tree', url.searchParams));
    if (req.method === 'POST') {
      const body = await readJson(req);
      const file: any = await repositoryRead(
        owner,
        projectId,
        'blob',
        new URLSearchParams({ path: body.path, ref: body.ref || 'HEAD' }),
      );
      if (typeof file.content !== 'string') fail(file.omitted || 'File unavailable');
      return sendJson(
        res,
        {
          attachment: storeAttachment(
            owner,
            Buffer.from(file.content),
            'text/plain',
            file.path.split('/').at(-1),
            'project-file',
          ),
        },
        201,
      );
    }
  }
  return false;
}
