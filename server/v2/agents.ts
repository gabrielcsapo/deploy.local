import { dispatch, routes } from '../kernel/routes.ts';
import { sendJson } from '../kernel/http.ts';
import { readJson } from '../kernel/http.ts';
import { agentControl, putAgentControl } from './phone-preferences.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentConfiguration as Agent,
  AgentApprovalAction,
  AgentApprovalRule,
  ApprovalSuggestion,
  AgentTracking,
  ConversationEvent,
  LooksAfterItem,
  AgentReceipt,
} from '../../shared/v2/contracts.ts';
import { db, id, list, now, remove, save, events } from '../workspace/store.ts';
import { providerConnections } from '../workspace/provider-connections.ts';
import { syncInbox } from './inbox.ts';
import { fail } from '../kernel/errors.ts';

import { mapConversationEvent } from './events.ts';
import {
  migrateAgent,
  validateAvatar,
  validateItem,
  nextItemAt,
  agentChanged,
  coordinatorTimezone,
} from './agent-foundation.ts';
import { randomAgentAvatar } from '../../shared/v2/agents.ts';
import { agentRuns, holdScheduleUntilTomorrow, startAgentRun } from './agent-runs.ts';

export const agentApprovalActions: AgentApprovalAction[] = [
  'start-task',
  'open-pull-request',
  'merge',
  'rollback',
  'restart',
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
      for (const agentId of new Set(rules.map((rule) => rule.agent as string)))
        agentChanged(owner, agentId);
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
  // Rollbacks are asked by deploy.local's release checks, stored under the `warden` actor.
  const items = answered.filter((item) => item.from === rollbackActor);
  const rule = rules.find(
    (rule) => rule.agent === rollbackActor && rule.action === 'rollback' && !rule.projectId,
  );
  return items.length >= 4 &&
    items.every((item) => item.answer?.actionId === 'rollback') &&
    (!rule || rule.mode === 'ask')
    ? [{ agent: rollbackActor, action: 'rollback' as const, count: items.length }]
    : [];
}
export function agentTracking(owner: string, agentId: string): AgentTracking {
  const runs = list('run', owner).filter((run) => run.agentId === agentId || run.agent === agentId);
  const tasks = list('task', owner).filter(
    (task) => task.agentId === agentId || runs.some((run) => run.taskId === task.id),
  );
  const workers = list('worker', owner);
  // Queued and starting runs are already this agent's work, so they read Running everywhere.
  const active = (taskId: string) =>
    ['queued', 'starting', 'running', 'unknown'].includes(
      runs.findLast((run) => run.taskId === taskId)?.status,
    );
  return {
    running: tasks
      .filter((task) => active(task.id) || task.status === 'running')
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
    runs: agentRuns(owner, agentId)
      .reverse()
      .slice(0, 10)
      .map((task) => ({
        id: task.id,
        title: task.title,
        at: task.createdAt,
        ...(task.agentItemId ? { itemId: task.agentItemId } : {}),
        status: active(task.id)
          ? 'running'
          : list('run', owner).findLast((run) => run.taskId === task.id)?.status || task.status,
      })),
    schedule: (({ day, result, error }) => (day ? { day, result, error } : undefined))(
      list('v2-agent-schedule', owner).find((row) => row.id === agentId) || {},
    ),
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

/** The release checks' approval identity. Not an agent; kept so existing rules and answers still apply. */
export const rollbackActor = 'warden';
// No agent ships by default: you create each one, usually from a template on the new-agent page.
export function agentsForOwner(owner: string): Agent[] {
  const agents = list('agent', owner);
  if (!agents.length) return [];
  // Read chat, tasks and messages once for every agent, not once per agent.
  const lastChat = new Map<string, any>();
  for (const m of list('agent-message', owner))
    if (['you', 'reply'].includes(m.event?.kind)) lastChat.set(m.agentId, m.event);
  const taskAgent = new Map<string, string>();
  for (const t of list('task', owner)) if (t.agentId) taskAgent.set(t.id, t.agentId);
  const lastRunReply = new Map<string, any>();
  for (const m of list('message', owner)) {
    const agentId = taskAgent.get(m.taskId);
    if (!agentId || m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const previous = lastRunReply.get(agentId);
    if (!previous || previous.createdAt.localeCompare(m.createdAt) <= 0)
      lastRunReply.set(agentId, m);
  }
  return agents.map((row) => {
    const agent = migrateAgent(owner, row);
    let last = lastChat.get(agent.id);
    const runReply = lastRunReply.get(agent.id);
    if (runReply && (!last || runReply.createdAt > last.at))
      last = { kind: 'reply', paragraphs: [runReply.content], at: runReply.createdAt };
    return {
      ...agent,
      looksAfter: agent.looksAfter?.map((item) => ({ ...item, nextAt: nextItemAt(item) })),
      ...(last
        ? {
            lastMessage: {
              text: last.kind === 'reply' ? last.paragraphs.join(' ') : last.text,
              at: last.at,
            },
          }
        : {}),
    };
  });
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
      (key) =>
        ![
          'name',
          'job',
          'computers',
          'schedule',
          'triggers',
          'apps',
          'projectId',
          'avatar',
          'looksAfter',
        ].includes(key),
    )
  )
    fail('Only name, job, computers, apps, project, schedule and triggers can be changed');
  const projectId =
    body.projectId === undefined ? previous?.projectId : body.projectId || undefined;
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.length > 200))
    fail('Invalid project');
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
  const avatar = validateAvatar(body.avatar ?? previous?.avatar ?? randomAgentAvatar());
  if (
    body.looksAfter !== undefined &&
    (!Array.isArray(body.looksAfter) || body.looksAfter.length > 100)
  )
    fail('Invalid Looks after items');
  const looksAfter: LooksAfterItem[] = (body.looksAfter ?? previous?.looksAfter ?? []).map(
    (raw: any) => {
      const item = validateItem(raw);
      const old = previous?.looksAfter?.find((i) => i.id === item.id);
      // A changed instruction must be confirmed again. Only the explicit confirm endpoint grants it.
      const { confirmedAt: _at, nextAt: _next, ...definition } = item;
      const { confirmedAt, nextAt: _oldNext, ...oldDefinition } = old ?? {};
      return {
        ...definition,
        ...(confirmedAt && JSON.stringify(definition) === JSON.stringify(oldDefinition)
          ? { confirmedAt }
          : {}),
      };
    },
  );
  if (new Set(looksAfter.map((i) => i.id)).size !== looksAfter.length)
    fail('Duplicate Looks after item');
  const job = body.job ?? previous?.job ?? '';
  if (typeof job !== 'string' || job.length > 12000) fail('Invalid instructions');
  return {
    avatar,
    looksAfter,
    apps,
    schedule,
    triggers,
    ...(projectId ? { projectId } : {}),
    name: text(body.name ?? previous?.name, 'Name', 80),
    job: job.trim(),
    computers,
  };
}
function validateAgentProjects(
  owner: string,
  values: Agent | ReturnType<typeof fields>,
  body: any,
) {
  const projects = new Set(list('project', owner).map((p) => p.id));
  if (body.projectId && !projects.has(body.projectId)) fail('Project not found', 404);
  for (const item of body.looksAfter ? (values.looksAfter ?? []) : [])
    if (typeof item.where !== 'string' && item.where.projects.some((p) => !projects.has(p)))
      fail('Item project not found', 404);
}
export function confirmAgentItem(owner: string, agentId: string, itemId: string) {
  return db
    .transaction(() => {
      const agent = agentForOwner(owner, agentId);
      const item = agent.looksAfter?.find((i) => i.id === itemId);
      if (!item) fail('Looks after item not found', 404);
      if (!item.confirmedAt) {
        item.confirmedAt = now();
        save('agent', owner, agent);
        agentChanged(owner, agent.id);
      }
      return agentForOwner(owner, agent.id);
    })
    .immediate();
}
export function createAgent(owner: string, body: unknown): Agent {
  const values = fields(body);
  validateAgentProjects(owner, values, body);
  return db
    .transaction(() => {
      const agent: Agent = { ...values, id: id(), createdBy: owner };
      if ((body as any)?.schedule && !(body as any)?.looksAfter) {
        agent.looksAfter = undefined;
        Object.assign(agent, migrateAgent(owner, agent));
      }
      save('agent', owner, agent);
      agentChanged(owner, agent.id);
      holdScheduleUntilTomorrow(owner, agent);
      for (const action of agentApprovalActions)
        save('v2-approval', owner, { id: id(), agent: agent.id, action, mode: 'ask' });
      return agent;
    })
    .immediate();
}
export function deleteAgent(owner: string, agentId: string) {
  db.transaction(() => {
    remove('agent', owner, agentId);
    agentChanged(owner, agentId);
    for (const rule of rulesForOwner(owner).filter((rule) => rule.agent === agentId))
      remove('v2-approval', owner, rule.id);
  }).immediate();
}
export function patchAgent(owner: string, agentId: string, body: unknown): Agent {
  const previous = agentForOwner(owner, agentId);
  const { projectId: _previousProject, ...rest } = previous;
  const values = fields(body, previous);
  validateAgentProjects(owner, values, body);
  const agent = save('agent', owner, { ...rest, ...values });
  if (
    agent.schedule?.enabled &&
    JSON.stringify(agent.schedule) !== JSON.stringify(previous.schedule)
  )
    holdScheduleUntilTomorrow(owner, agent);
  agentChanged(owner, agentId);
  return agent;
}

/** Uses the same owner-scoped, encrypted compatible-provider connections as workers. No tools run. */
async function complete(
  owner: string,
  system: string,
  prompt: string,
  structured = false,
): Promise<string> {
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
      'Agents need a connected model endpoint. Connect a compatible provider in Computers › Models, then try again.',
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
        ...(structured ? { response_format: { type: 'json_object' } } : {}),
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
    'Draft a standing agent from the described job. Return only a JSON object with name (short role name), job (plain instructions), computers (array of computer IDs supplied by the user, or empty). Do not claim work has run. All actions require approval. Agents never ship releases. Never include permissions, credentials, schedules or tools.',
    job,
  );
  try {
    const draft = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    text(draft.job, 'Instructions', 12000);
    return fields(draft);
  } catch {
    fail('The model returned an invalid agent draft. Try describing the job again.', 502);
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
export function agentTeachingPrompt(owner: string, agent: Agent) {
  return `You are ${agent.name}. Current What it does: ${agent.job || '(not taught yet)'}. Current Looks after: ${JSON.stringify(agent.looksAfter)}.
Return only JSON: {"reply": "plain prose", "job": null or "complete updated standing job", "item": null or {"what":"instruction", "where":"all-active" or "active-and-maintained" or {"projects":["project id"]}, "when":{"every":"week" or "day" or "change","day":0..6 (Sunday=0, required for week),"time":"HH:MM","timezone":"${coordinatorTimezone()}"},"brings":"pull-request" or "design-review" or "question" or "message"}}.
Only explicit standing instructions update the job. A time/schedule or something to look after proposes an item, never confirms it. If the intent is uncertain, ask a clarifying question in reply and return null job and item. Do not infer learned preferences (a later feature). You have no tools; never claim to have run work or granted access. Explain proposed items start only after confirmation. Agents never ship.
Available project identities (scope never grants access): ${JSON.stringify(
    list('project', owner)
      .filter((p) => !agent.projectId || p.id === agent.projectId)
      .map((p) => ({ id: p.id, name: p.name })),
  )}.`;
}
export function saveAgentReply(
  owner: string,
  agent: Agent,
  content: string,
  reply: string,
  attachments: any[] = [],
  model?: string,
  operationId?: string,
) {
  const agentId = agent.id;
  let extracted: { reply: string; job: string | null; item: LooksAfterItem | null };
  try {
    const raw = JSON.parse(reply);
    if (
      Object.keys(raw).some((k) => !['reply', 'job', 'item'].includes(k)) ||
      (raw.job !== null &&
        (typeof raw.job !== 'string' || !raw.job.trim() || raw.job.length > 12000))
    )
      throw new Error();
    extracted = {
      reply: text(raw.reply, 'Reply', 20000),
      job: raw.job,
      item:
        raw.item === null ? null : validateItem({ ...raw.item, id: id(), confirmedAt: undefined }),
    };
  } catch {
    fail(
      'The model returned an invalid reply. Your instructions were not changed. Try again.',
      502,
    );
  }
  const at = now();
  db.transaction(() => {
    // Re-read after the model request so a concurrent settings edit is never overwritten.
    if (
      operationId &&
      list('agent-message-operation', owner).some((r) => r.id === `${agentId}:${operationId}`)
    )
      return;
    if (agentControl(owner, agentId).paused) fail('This agent is paused.', 409);
    const current = agentForOwner(owner, agentId);
    if (current.job !== agent.job) fail('Instructions changed while replying. Try again.', 409);
    const receipts: AgentReceipt[] = [];
    // A changed job is saved quietly; only a new Looks after item gets a receipt to confirm.
    if (extracted.job !== null) current.job = extracted.job.trim();
    if (extracted.item) {
      if ((current.looksAfter?.length ?? 0) >= 100)
        fail('An agent can have at most 100 Looks after items');
      validateAgentProjects(
        owner,
        { ...current, looksAfter: [extracted.item] },
        { looksAfter: true },
      );
      current.looksAfter = [...(current.looksAfter ?? []), extracted.item];
      receipts.push({ kind: 'looks-after', itemId: extracted.item.id });
    }
    save('agent', owner, current);
    for (const event of [
      { kind: 'you', id: id(), at, text: content, attachments, model },
      {
        kind: 'reply',
        id: id(),
        at,
        agent: agentId,
        paragraphs: extracted.reply.split(/\n\s*\n/),
        receipts,
      },
    ])
      save('agent-message', owner, { id: event.id, agentId, event });
    if (operationId) save('agent-message-operation', owner, { id: `${agentId}:${operationId}` });
    agentChanged(owner, agentId);
  }).immediate();
  return { events: agentConversation(owner, agentId), tracking: agentTracking(owner, agentId) };
}

export async function agentsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const path = new URL(req.url!, 'http://localhost').pathname.slice('/api/v2'.length);
  const itemMatch = path.match(/^\/agents\/([^/]+)\/items\/([^/]+)(\/confirm|\/runs|\/run)?$/);
  if (itemMatch) {
    const agent = agentForOwner(owner, decodeURIComponent(itemMatch[1]));
    const itemId = decodeURIComponent(itemMatch[2]);
    const item = agent.looksAfter?.find((i) => i.id === itemId);
    if (!item) fail('Looks after item not found', 404);
    const route = routes<undefined>();
    const sendItem = (result: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    };
    return dispatch(
      [
        route({
          method: 'POST',
          path: '/agents/:agent/items/:item/confirm',
          handler: () => sendItem({ agent: confirmAgentItem(owner, agent.id, itemId) }),
        }),
        route({
          method: 'POST',
          path: '/agents/:agent/items/:item/run',
          handler: () => {
            if (!item.confirmedAt) fail('Confirm this item before running it.', 409);
            return sendItem({ task: startAgentRun(owner, agent, 'manual', item) });
          },
        }),
        route({
          method: 'GET',
          path: '/agents/:agent/items/:item/runs',
          handler: () => {
            return sendItem({
              runs: agentRuns(owner, agent.id, itemId)
                .reverse()
                .map((task) => ({
                  id: task.id,
                  title: task.title,
                  at: task.createdAt,
                  itemId,
                  status:
                    list('run', owner).findLast((run) => run.taskId === task.id)?.status ??
                    task.status,
                })),
            });
          },
        }),
      ],
      { path: () => path, notFound: () => fail('Method not allowed', 405) },
    )(req, res, undefined);
  }
  const match = path.match(/^\/agents\/([^/]+)(\/(?:conversation|control|run))?$/);
  if (path !== '/agents' && path !== '/approvals' && !match) return false;
  const send = (value: unknown, status = 200) => sendJson(res, value, status);
  const route = routes<undefined>();
  const read = () =>
    readJson(req, 32768, { tooLarge: 'Request body too large', preserveReadErrors: true });
  return dispatch(
    [
      route({
        method: 'GET',
        path: '/approvals',
        handler: () =>
          send({ rules: rulesForOwner(owner), suggestions: approvalSuggestions(owner) }),
      }),
      route({
        method: 'PUT',
        path: '/approvals',
        handler: async () =>
          send({
            rules: putRules(owner, (await read()).rules),
            suggestions: approvalSuggestions(owner),
          }),
      }),
      route({
        method: '*',
        path: '/approvals',
        handler: () => send({ error: 'Method not allowed' }, 405),
      }),
      route({
        method: 'GET',
        path: '/agents',
        handler: () => send({ agents: agentsForOwner(owner), timezone: coordinatorTimezone() }),
      }),
      route({
        method: 'POST',
        path: '/agents/draft',
        handler: async () => send({ draft: await draftAgent(owner, await read()) }),
      }),
      route({
        method: 'POST',
        path: '/agents',
        handler: async () => send({ agent: createAgent(owner, await read()) }, 201),
      }),
      route({
        method: '*',
        path: '/agents/:rest*',
        handler: async () => {
          // Match and resolve before selecting the method, including unknown ids and DELETE conversation.
          if (!match) return false;
          const agentId = decodeURIComponent(match[1]);
          const agent = agentForOwner(owner, agentId);
          return dispatch(
            [
              route({
                method: 'POST',
                path: '/agents/:agent/run',
                handler: () => send({ task: startAgentRun(owner, agent, 'manual') }, 201),
              }),
              route({
                method: '*',
                path: '/agents/:agent/run',
                handler: () => send({ error: 'Method not allowed' }, 405),
              }),
              route({
                method: 'GET',
                path: '/agents/:agent/control',
                handler: () => send(agentControl(owner, agentId)),
              }),
              route({
                method: 'PATCH',
                path: '/agents/:agent/control',
                handler: async () => send(putAgentControl(owner, agentId, await read())),
              }),
              route({
                method: '*',
                path: '/agents/:agent/control',
                handler: () => send({ error: 'Method not allowed' }, 405),
              }),
              route({
                method: 'GET',
                path: '/agents/:agent/conversation',
                handler: () =>
                  send({
                    events: agentConversation(owner, agentId),
                    tracking: agentTracking(owner, agentId),
                  }),
              }),
              route({
                method: 'POST',
                path: '/agents/:agent/conversation',
                handler: async () => {
                  if (agentControl(owner, agentId).paused)
                    fail('This agent is paused. Resume it before sending a message.', 409);
                  const content = text((await read())?.text, 'Message', 12000);
                  const { sendAgentMessage } = await import('./attachments.ts');
                  return send(await sendAgentMessage(owner, agentId, { text: content }));
                },
              }),
              route({
                method: 'PATCH',
                path: '/agents/:agent',
                handler: async () => send({ agent: patchAgent(owner, agentId, await read()) }),
              }),
              route({
                method: 'DELETE',
                path: '/agents/:rest*',
                handler: () => {
                  deleteAgent(owner, agent.id);
                  return send({ deleted: agent.id });
                },
              }),
            ],
            { path: () => path },
          )(req, res, undefined);
        },
      }),
    ],
    { path: () => path, notFound: () => send({ error: 'Method not allowed' }, 405) },
  )(req, res, undefined);
}
