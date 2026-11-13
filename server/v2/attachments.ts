import { readBytes, readJson, sendJson } from '../kernel/http.ts';
export { readBytes, readJson, sendJson } from '../kernel/http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Attachment, ConversationEvent } from '../../shared/v2/contracts.ts';
import { getArtifact, putArtifactBytes } from '../content-store.ts';
import { db, get, id, list, save } from '../workspace/store.ts';
import { repositoryRead } from '../workspace/repositories.ts';
import { getModels } from './computers.ts';
import { fail } from '../kernel/errors.ts';

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
    ref: `/api/v2/attachments/${id()}`,
  };
  save('v2-attachment', owner, {
    id: attachment.ref.split('/').at(-1),
    attachment,
    digest: artifact.digest,
    type,
  });
  return attachment;
}
export function attachmentRecord(owner: string, ref: string) {
  const match = typeof ref === 'string' && ref.match(/^\/api\/v2\/attachments\/([a-f0-9-]+)$/);
  if (!match) fail('Invalid attachment reference');
  return get('v2-attachment', owner, match[1]);
}
export function ownedAttachments(owner: string, input: unknown): Attachment[] {
  if (!Array.isArray(input) || input.length > 8) fail('At most eight attachments are allowed');
  const attachments = input.map(
    (item) => attachmentRecord(owner, item?.ref).attachment as Attachment,
  );
  if (attachments.reduce((sum, item) => sum + item.bytes, 0) > 20 * 1024 * 1024)
    fail('Attachments exceed 20 MiB', 413);
  return attachments;
}
export function attachmentBytes(owner: string, ref: string) {
  const record = attachmentRecord(owner, ref);
  const artifact = getArtifact(record.digest);
  if (!artifact) fail('File unavailable', 404);
  return readFile(artifact.localPath).then((bytes) => ({ ...record, bytes }));
}
export function chatModel(
  owner: string,
  override?: string | null,
  job: 'writing-code' | 'answering-questions' = 'writing-code',
) {
  const models = getModels(owner);
  const selected = override || models.defaults[job];
  if (!selected) return {};
  const choice = models.choices.find((item) => item.id === selected);
  if (!choice) fail('That model is unavailable. Choose a model from Computers › Models.');
  return { adapter: choice.provider, model: choice.model };
}
export function mapMediaEvent(row: any): ConversationEvent | undefined {
  const event = row.payload?.event;
  if (
    row.type === 'v2.conversation' &&
    event?.kind === 'screenshot' &&
    ['id', 'at', 'screenshotId'].every((key) => typeof event[key] === 'string')
  )
    return { kind: 'screenshot', id: event.id, at: event.at, screenshotId: event.screenshotId };
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
  if (url.pathname === '/api/v2/attachments' && req.method === 'POST') {
    const type = String(req.headers['content-type'] || '').split(';')[0];
    const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    return sendJson(
      res,
      { attachment: storeAttachment(owner, await readBytes(req), type, name) },
      201,
    );
  }
  const file = url.pathname.match(/^\/api\/v2\/attachments\/([a-f0-9-]+)$/);
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
  const project = url.pathname.match(/^\/api\/v2\/attachments\/projects\/([^/]+)$/);
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

/** Agent chats use the existing compatible connection, with no tools or implicit task. */
export async function sendAgentMessage(owner: string, agentId: string, body: any) {
  const { agentsForOwner, agentConversation, agentTeachingPrompt, saveAgentReply } =
    await import('./agents.ts');
  const { providerConnections } = await import('../workspace/provider-connections.ts');
  const agent = agentsForOwner(owner).find((item) => item.id === agentId);
  if (!agent) fail('Agent not found', 404);
  const { agentControl } = await import('./phone-preferences.ts');
  if (agentControl(owner, agentId).paused) fail('This agent is paused.', 409);
  if (
    body.operationId !== undefined &&
    (typeof body.operationId !== 'string' || body.operationId.length > 200)
  )
    fail('Invalid operation id');
  if (
    body.operationId &&
    list('agent-message-operation', owner).some((r) => r.id === `${agentId}:${body.operationId}`)
  )
    return { events: agentConversation(owner, agentId) };
  const attachments = ownedAttachments(owner, body.attachments || []);
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 12000)
    fail('Message required (maximum 12000 characters)');
  const settings = chatModel(owner, body.model, 'answering-questions');
  if (settings.adapter && settings.adapter !== 'compatible')
    fail(
      'Agent chats currently use connected compatible models. Use a task for Claude or Codex.',
      409,
    );
  const connection = list('provider-connection', owner).find(
    (row) => row.provider === 'compatible' && row.enabled && row.baseUrl && row.model,
  );
  const provider =
    connection &&
    providerConnections(owner, connection.workerId, true).find(
      (row) => row.provider === 'compatible',
    );
  if (!provider) fail('Connect a model endpoint in Computers › Models first.', 503);
  const content: any[] = [{ type: 'text', text: body.text.trim() }];
  for (const a of attachments) {
    const record = await attachmentBytes(owner, a.ref);
    if (record.type.startsWith('image/'))
      content.push({
        type: 'image_url',
        image_url: { url: `data:${record.type};base64,${record.bytes.toString('base64')}` },
      });
    else if (record.type.startsWith('text/') || record.type === 'application/json')
      content.push({
        type: 'text',
        text: `Attached file ${a.name}:\n${record.bytes.toString('utf8').slice(0, 40000)}`,
      });
    else fail('Send this file in a task so the agent can read it from its files.', 415);
    if (record.markup)
      content.push({
        type: 'text',
        text: `Markup in original image pixels (0 red, 1 yellow, 2 blue): ${JSON.stringify(record.markup)}`,
      });
  }
  const response = await fetch(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model || provider.model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: agentTeachingPrompt(owner, agent),
        },
        ...agentConversation(owner, agentId)
          .filter((e) => e.kind === 'you' || e.kind === 'reply')
          .slice(-20)
          .map((e) =>
            e.kind === 'you'
              ? { role: 'user', content: e.text }
              : e.kind === 'reply'
                ? { role: 'assistant', content: e.paragraphs.join('\n\n') }
                : null,
          ),
        { role: 'user', content: attachments.length ? content : body.text.trim() },
      ],
      stream: false,
      max_tokens: 3000,
    }),
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  if (!response.ok)
    fail(
      'The model rejected the message. Check its connection and image support in Computers › Models.',
      502,
    );
  const reader = response.body?.getReader();
  if (!reader) fail('The model returned no reply', 502);
  let bytes = Buffer.alloc(0);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes = Buffer.concat([bytes, part.value]);
      if (bytes.length > 131072) fail('The model reply is too large', 502);
    }
  } finally {
    await reader.cancel();
  }
  let reply: string;
  try {
    reply = JSON.parse(bytes.toString()).choices[0].message.content;
  } catch {
    fail('The model returned an invalid reply', 502);
  }
  if (typeof reply !== 'string' || !reply.trim()) fail('The model returned no reply', 502);
  return saveAgentReply(
    owner,
    agent,
    body.text.trim(),
    reply,
    attachments,
    settings.model,
    body.operationId,
  );
}
