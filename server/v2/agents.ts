import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentConfiguration as Agent,
  AgentApprovalAction,
  AgentApprovalRule,
  ApprovalSuggestion,
  AgentTracking,
  ConversationEvent,
} from '../../shared/v2/contracts.ts';
import { db, id, list, now, save, events } from '../workspace/store.ts';
import { providerConnections } from '../workspace/provider-connections.ts';
import { fail, syncInbox } from './inbox.ts';

import { mapConversationEvent } from './events.ts';

export const agentApprovalActions: AgentApprovalAction[] = [
  'start-task',
  'open-pull-request',
  'merge',
  'rollback',
  'restart',
  'install',
  'change-secrets',
  'use-screen',
  'spend',
];
function rulesForOwner(owner: string): AgentApprovalRule[] {
  return list('v2-approval', owner).filter((rule) => agentApprovalActions.includes(rule.action));
}
function putRules(owner: string, rules: unknown) {
  if (!Array.isArray(rules) || rules.length > 1000)
    fail('rules must be an array of at most 1000 rules');
  const ids = new Set<string>();
  const scopes = new Set<string>();
  for (const rule of rules) {
    if (rule?.action === 'ship')
      fail('Only you can start a release; ship is not an approvable action');
    if (
      !rule ||
      !agentApprovalActions.includes(rule.action) ||
      !['ask', 'allow', 'never'].includes(rule.mode)
    )
      fail('Invalid approval rule');
    text(rule.id, 'Rule id', 200);
    text(rule.agent, 'Agent', 200);
    if (rule.projectId !== undefined) text(rule.projectId, 'Project', 200);
    if (rule.limit !== undefined && (typeof rule.limit !== 'string' || rule.limit.length > 2000))
      fail('Invalid limit');
    const scope = JSON.stringify([rule.agent, rule.action, rule.projectId ?? null]);
    if (ids.has(rule.id) || scopes.has(scope)) fail('Duplicate approval rule');
    ids.add(rule.id);
    scopes.add(scope);
  }
  return db
    .transaction(() => {
      db.prepare("DELETE FROM records WHERE kind='v2-approval' AND owner=?").run(owner);
      for (const rule of rules) {
        const { id, agent, action, mode, projectId, limit } = rule;
        save('v2-approval', owner, { id, agent, action, mode, projectId, limit });
      }
      return rulesForOwner(owner);
    })
    .immediate();
}
export function approvalSuggestions(owner: string, time = Date.now()): ApprovalSuggestion[] {
  const answered = syncInbox(owner).filter(
    (item) =>
      item.kind === 'rollback' &&
      item.state === 'answered' &&
      item.answer &&
      Date.parse(item.answer.at) >= time - 30 * 86400000 &&
      Date.parse(item.answer.at) <= time,
  );
  const rules = rulesForOwner(owner);
  return agentsForOwner(owner).flatMap((agent) => {
    const items = answered.filter((item) => item.from === agent.id);
    const rule = rules.find(
      (rule) => rule.agent === agent.id && rule.action === 'rollback' && !rule.projectId,
    );
    return items.length >= 4 &&
      items.every((item) => item.answer?.actionId === 'rollback') &&
      (!rule || rule.mode === 'ask')
      ? [{ agent: agent.id, action: 'rollback' as const, count: items.length }]
      : [];
  });
}
export function agentTracking(owner: string, agentId: string): AgentTracking {
  const runs = list('run', owner).filter((run) => run.agentId === agentId || run.agent === agentId);
  const tasks = list('task', owner).filter(
    (task) => task.agentId === agentId || runs.some((run) => run.taskId === task.id),
  );
  const workers = list('worker', owner);
  return {
    running: tasks
      .filter(
        (task) =>
          runs.findLast((run) => run.taskId === task.id)?.status === 'running' ||
          task.status === 'running',
      )
      .map((task) => ({
        id: task.id,
        title: task.title,
        computer: workers.find((worker) => worker.id === task.workerId)?.name,
        at: task.updatedAt || task.createdAt,
      })),
    watching: list('issue', owner)
      .filter(
        (issue) =>
          (issue.agentId === agentId ||
            issue.agent === agentId ||
            issue.taskIds?.some((id: string) => tasks.some((task) => task.id === id))) &&
          !['closed', 'completed'].includes(issue.state || issue.status),
      )
      .map((issue) => ({ id: issue.id, title: issue.title, projectId: issue.projectId })),
    shipped: list('pull-request', owner)
      .filter(
        (pull) =>
          (pull.status || pull.state) === 'merged' &&
          Date.parse(pull.mergedAt || '') > Date.now() - 7 * 86400000 &&
          (pull.agentId === agentId ||
            pull.taskIds?.some((id: string) => tasks.some((task) => task.id === id))),
      )
      .map((pull) => ({ id: pull.id, title: pull.title, at: pull.mergedAt })),
  };
}

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
  if (
    Object.keys(body).some(
      (key) => !['name', 'job', 'computers', 'schedule', 'triggers', 'apps'].includes(key),
    )
  )
    fail('Only name, job, computers, apps, schedule and triggers can be changed');
  const computers = body.computers ?? previous?.computers ?? [];
  if (
    !Array.isArray(computers) ||
    computers.length > 100 ||
    computers.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200) ||
    new Set(computers).size !== computers.length
  )
    fail('Invalid computers');
  const apps = body.apps ?? previous?.apps ?? [];
  if (
    !Array.isArray(apps) ||
    apps.length > 100 ||
    apps.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200) ||
    new Set(apps).size !== apps.length
  )
    fail('Invalid apps');
  const schedule = body.schedule ?? previous?.schedule ?? { enabled: false, time: '08:00' };
  if (
    !schedule ||
    typeof schedule.enabled !== 'boolean' ||
    typeof schedule.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) ||
    Object.keys(schedule).some((key) => !['enabled', 'time'].includes(key))
  )
    fail('Invalid schedule');
  const triggers = body.triggers ?? previous?.triggers ?? { mention: true, disk: false };
  if (
    !triggers ||
    typeof triggers.mention !== 'boolean' ||
    typeof triggers.disk !== 'boolean' ||
    Object.keys(triggers).some((key) => !['mention', 'disk'].includes(key))
  )
    fail('Invalid triggers');
  return {
    apps,
    schedule,
    triggers,
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
      for (const action of agentApprovalActions)
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
  if (path !== '/agents' && path !== '/approvals' && !match) return false;
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
    return true;
  };
  if (path === '/approvals') {
    if (req.method === 'GET')
      return send({ rules: rulesForOwner(owner), suggestions: approvalSuggestions(owner) });
    if (req.method === 'PUT')
      return send({
        rules: putRules(owner, (await readBody(req)).rules),
        suggestions: approvalSuggestions(owner),
      });
    return send({ error: 'Method not allowed' }, 405);
  }
  if (req.method === 'GET' && path === '/agents') return send({ agents: agentsForOwner(owner) });
  if (req.method === 'POST' && path === '/agents/draft')
    return send({ draft: await draftAgent(owner, await readBody(req)) });
  if (req.method === 'POST' && path === '/agents')
    return send({ agent: createAgent(owner, await readBody(req)) }, 201);
  if (match) {
    const agentId = decodeURIComponent(match[1]);
    const agent = agentForOwner(owner, agentId);
    if (match[2]) {
      if (req.method === 'GET')
        return send({
          events: agentConversation(owner, agentId),
          tracking: agentTracking(owner, agentId),
        });
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
        return send({
          events: agentConversation(owner, agentId),
          tracking: agentTracking(owner, agentId),
        });
      }
    } else if (req.method === 'PATCH')
      return send({ agent: patchAgent(owner, agentId, await readBody(req)) });
    if (req.method === 'DELETE' && builtIns.some((row) => row.id === agentId))
      return send({ error: 'Built-in agents cannot be deleted' }, 403);
  }
  return send({ error: 'Method not allowed' }, 405);
}
