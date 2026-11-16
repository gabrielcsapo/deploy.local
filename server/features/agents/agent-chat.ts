import { requireAgentChatSource } from '../../v2/agent-chat-source-port.ts';
import { readFile } from 'node:fs/promises';
import type { Attachment } from '../../../shared/v2/contracts.ts';
import { getArtifact } from '../../content-store.ts';
import { get, list } from '../../workspace/store.ts';
import { getModels } from '../computers/computers.ts';
import { fail } from '../../kernel/errors.ts';

export function attachmentRecord(owner: string, ref: string) {
  const match =
    typeof ref === 'string' && ref.match(/^\/api\/conversation-attachments\/([a-f0-9-]+)$/);
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
/** Agent chats use the existing compatible connection, with no tools or implicit task. */
export async function sendAgentMessage(owner: string, agentId: string, body: any) {
  const { agentsForOwner, agentConversation, agentTeachingPrompt, saveAgentReply } =
    await requireAgentChatSource('agent chat')();
  const { providerConnections } = await import('../../workspace/provider-connections.ts');
  const agent = agentsForOwner(owner).find((item) => item.id === agentId);
  if (!agent) fail('Agent not found', 404);
  const { agentControl } = await import('../../v2/phone-preferences.ts');
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
