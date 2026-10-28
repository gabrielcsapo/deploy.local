import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Agent, ConversationEvent } from '../../shared/v2/contracts.ts';
import { db, id, list, now, save, events } from '../workspace/store.ts';
import { providerConnections } from '../workspace/provider-connections.ts';
import { fail, syncInbox } from './inbox.ts';
import { approvalActions } from './releases.ts';
import { mapConversationEvent } from './events.ts';

const builtIns = [
  {
    id: 'scout',
    name: 'Scout',
    job: "Keep deploy.local's development loop moving. Review open gaps and failed checks. Propose improvements and turn approved proposals into tasks. Never merge or release without my approval.",
  },
  {
    id: 'warden',
    name: 'Warden',
    job: 'Watch every app and computer. When something fails, find the release or change that caused it. Propose the smallest fix: a restart, a rollback, or handing it to Scout. Never touch data without asking.',
  },
];
export function agentsForOwner(owner: string): Agent[] {
  const stored: Agent[] = list('agent', owner);
  return [
    ...builtIns.map(
      (agent) =>
        stored.find((row) => row.id === agent.id) ?? { ...agent, computers: [], createdBy: owner },
    ),
    ...stored.filter((row) => !builtIns.some((agent) => agent.id === row.id)),
  ];
}
function agentForOwner(owner: string, agentId: string) {
  const agent = agentsForOwner(owner).find((row) => row.id === agentId);
  if (!agent) fail('Agent not found', 404);
  return agent;
}
function text(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail(`${label} is required (maximum ${max} characters)`);
  return value.trim();
}
function fields(body: any, previous?: Agent) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid agent');
  if (Object.keys(body).some((key) => !['name', 'job', 'computers'].includes(key)))
    fail('Only name, job and computers can be changed');
  const computers = body.computers ?? previous?.computers ?? [];
  if (
    !Array.isArray(computers) ||
    computers.length > 100 ||
    computers.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200) ||
    new Set(computers).size !== computers.length
  )
    fail('Invalid computers');
  return {
    name: text(body.name ?? previous?.name, 'Name', 80),
    job: text(body.job ?? previous?.job, 'Instructions', 12000),
    computers,
  };
}
export function createAgent(owner: string, body: unknown): Agent {
  const values = fields(body);
  return db
    .transaction(() => {
      const agent: Agent = { ...values, id: id(), createdBy: owner };
      save('agent', owner, agent);
      for (const action of approvalActions)
        save('v2-approval', owner, { id: id(), agent: agent.id, action, mode: 'ask' });
      return agent;
    })
    .immediate();
}
export function patchAgent(owner: string, agentId: string, body: unknown): Agent {
  const previous = agentForOwner(owner, agentId);
  return save('agent', owner, { ...previous, ...fields(body, previous) });
}

/** Uses the same owner-scoped, encrypted compatible-provider connections as workers. No tools run. */
async function complete(owner: string, system: string, prompt: string): Promise<string> {
  const connection = list('provider-connection', owner).find(
    (row) => row.provider === 'compatible' && row.enabled && row.baseUrl && row.model,
  );
  const provider = connection
    ? providerConnections(owner, connection.workerId, true).find(
        (row) => row.provider === 'compatible',
      )
    : undefined;
  if (!provider)
    fail(
      'Scout needs a connected model endpoint. Connect a compatible provider in Computers › Models, then try again.',
      503,
    );
  let response: Response;
  try {
    response = await fetch(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        stream: false,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
  } catch {
    fail(
      'The model endpoint could not be reached. Check its connection in Computers › Models and try again.',
      502,
    );
  }
  if (!response.ok)
    fail(
      'The model endpoint rejected the request. Check its connection in Computers › Models and try again.',
      502,
    );
  const reader = response.body?.getReader();
  if (!reader) fail('The model endpoint returned no reply', 502);
  let result = '';
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
      if (result.length > 131072) {
        await reader.cancel();
        fail('The model reply was too large', 502);
      }
    }
    const content = JSON.parse(result).choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      fail('The model endpoint returned no reply', 502);
    return content;
  } catch (error: any) {
    if (error.status) throw error;
    fail('The model endpoint returned an invalid reply', 502);
  }
}
export async function draftAgent(owner: string, body: any) {
  const job = text(body?.job, 'The job', 12000);
  const reply = await complete(
    owner,
    'You are Scout. Draft a standing agent from the described job. Return only a JSON object with name (short role name), job (plain instructions), computers (array of computer IDs supplied by the user, or empty). Do not claim work has run. All actions require approval. Agents never ship releases. Never include permissions, credentials, schedules or tools.',
    job,
  );
  try {
    return fields(JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, '')));
  } catch {
    fail('Scout returned an invalid agent draft. Try describing the job again.', 502);
  }
}
export function agentConversation(owner: string, agentId: string): ConversationEvent[] {
  agentForOwner(owner, agentId);
  const runs = new Map(
    list('run', owner)
      .filter((row) => row.agentId === agentId || row.agent === agentId)
      .map((row) => [row.id, row]),
  );
  const result: ConversationEvent[] = list('agent-message', owner)
    .filter((row) => row.agentId === agentId)
    .map((row) => row.event);
  let cursor = 0;
  for (;;) {
    const rows = events(owner, cursor);
    for (const row of rows) {
      if (runs.has(row.runId)) {
        const event = mapConversationEvent(row, runs.get(row.runId));
        if (event) result.push(event);
      }
      cursor = row.cursor;
    }
    if (rows.length < 1000) break;
  }
  for (const item of syncInbox(owner).filter((item) => item.from === agentId)) {
    if (!result.some((event) => event.kind === 'decision' && event.inboxItemId === item.id))
      result.push({
        kind: 'decision',
        id: `decision:${item.id}`,
        at: item.createdAt,
        inboxItemId: item.id,
      });
  }
  return [...new Map(result.map((event) => [event.id, event])).values()].sort((a, b) =>
    a.at.localeCompare(b.at),
  );
}
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 32768) {
      req.resume();
      fail('Request body too large', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail('Invalid JSON');
  }
}
export async function agentsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const path = new URL(req.url!, 'http://localhost').pathname.slice('/api/v2'.length);
  const match = path.match(/^\/agents\/([^/]+)(\/conversation)?$/);
  if (path !== '/agents' && !match) return false;
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
    return true;
  };
  if (req.method === 'GET' && path === '/agents') return send({ agents: agentsForOwner(owner) });
  if (req.method === 'POST' && path === '/agents/draft')
    return send({ draft: await draftAgent(owner, await readBody(req)) });
  if (req.method === 'POST' && path === '/agents')
    return send({ agent: createAgent(owner, await readBody(req)) }, 201);
  if (match) {
    const agentId = decodeURIComponent(match[1]);
    const agent = agentForOwner(owner, agentId);
    if (match[2]) {
      if (req.method === 'GET') return send({ events: agentConversation(owner, agentId) });
      if (req.method === 'POST') {
        const content = text((await readBody(req))?.text, 'Message', 12000);
        const reply = await complete(
          owner,
          `You are ${agent.name}. ${agent.job}\nReply briefly. You have no tools in this conversation. Do not claim to have run tasks or changed anything. Agents never ship.`,
          [
            ...agentConversation(owner, agentId)
              .filter((event) => event.kind === 'you' || event.kind === 'reply')
              .slice(-20)
              .map((event) =>
                event.kind === 'you'
                  ? `You: ${event.text}`
                  : event.kind === 'reply'
                    ? `${agent.name}: ${event.paragraphs.join('\n')}`
                    : '',
              ),
            `You: ${content}`,
          ]
            .join('\n\n')
            .slice(-40000),
        );
        const at = now();
        db.transaction(() => {
          for (const event of [
            { kind: 'you', id: id(), at, text: content, attachments: [] },
            { kind: 'reply', id: id(), at, agent: agentId, paragraphs: reply.split(/\n\s*\n/) },
          ])
            save('agent-message', owner, { id: event.id, agentId, event });
        }).immediate();
        return send({ events: agentConversation(owner, agentId) });
      }
    } else if (req.method === 'PATCH')
      return send({ agent: patchAgent(owner, agentId, await readBody(req)) });
    if (req.method === 'DELETE' && builtIns.some((row) => row.id === agentId))
      return send({ error: 'Built-in agents cannot be deleted' }, 403);
  }
  return send({ error: 'Method not allowed' }, 405);
}
