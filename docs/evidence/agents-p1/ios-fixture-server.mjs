// Standalone iPhone evidence fixture. Transport follows v2/12-ios-2/fixture-server.mjs.
// Synthetic phase-1 data below mirrors fixture-server.mjs; never import its Vite proxy.
// Only node:http and node:url: no coordinator, DB, filesystem writes or outbound requests.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const now = '2026-10-30T18:00:00-04:00';
const ago = (minutes) => new Date(Date.parse(now) - minutes * 60000).toISOString();
const timezone = 'America/New_York';
const writerId = 'release-notes-writer';
const reviewerId = 'code-reviewer';
const releaseJob =
  'Every Friday, draft release notes for what merged in home-gym that week. Warm and plain, grouped by feature and fix. Ask me before publishing.';
const reviewJob =
  'Check home-gym, tally and deploy.local for code quality and updates on Mondays at 08:40. Prepare small fixes within my limits and bring tested pull requests. Bring visible changes as a design review first and larger work as a question.';
const routineWhat =
  'Draft release notes for what merged in home-gym this week. Use warm, plain language, grouped by feature and fix. Send the draft here and ask before publishing.';
const releaseItem = {
  id: 'draft-release-notes',
  what: 'Draft release notes',
  where: { projects: ['home-gym'] },
  when: { every: 'week', day: 5, time: '16:00', timezone },
  brings: 'message',
  confirmedAt: ago(60),
  nextAt: '2026-11-06T16:00:00-05:00',
};
const reviewItem = {
  id: 'code-quality-and-updates',
  what: 'Code quality and updates',
  where: { projects: ['home-gym', 'tally', 'deploy.local'] },
  when: { every: 'week', day: 1, time: '08:40', timezone },
  brings: 'pull-request',
  confirmedAt: ago(60),
  nextAt: '2026-11-02T08:40:00-05:00',
};
const agents = [
  {
    id: writerId,
    name: 'Release notes writer',
    avatar: { glyph: 'variant28', color: '#af61f2' },
    job: releaseJob,
    computers: ['SER'],
    projectId: 'home-gym',
    looksAfter: [releaseItem],
    lastMessage: { text: "I'll draft a first pass.", at: now },
  },
  {
    id: 'ops-watcher',
    name: 'Ops watcher',
    avatar: { glyph: 'variant21', color: '#2fb5a3' },
    job: 'Watch my apps and tell me when something fails',
    computers: ['SER', 'bazzite'],
    looksAfter: [],
    lastMessage: { text: 'All apps healthy overnight.', at: '2026-10-30T07:02:00-04:00' },
  },
  {
    id: reviewerId,
    name: 'Code reviewer',
    avatar: { glyph: 'variant29', color: '#76a7ff' },
    job: reviewJob,
    computers: ['SER', 'bazzite'],
    looksAfter: [reviewItem],
    lastMessage: { text: 'Left 3 comments on #48.', at: '2026-10-29T12:00:00-04:00' },
  },
  {
    id: 'researcher',
    name: 'Researcher',
    avatar: { glyph: 'variant10', color: '#ffaa64' },
    job: 'Research a question for me',
    computers: ['SER'],
    looksAfter: [],
    lastMessage: { text: "Here's what I found on passkeys.", at: '2026-10-26T12:00:00-04:00' },
  },
  {
    id: 'designer',
    name: 'Designer',
    avatar: { glyph: 'variant03', color: '#e66bb8' },
    job: 'Propose visible changes as a design review first.',
    computers: ['SER'],
    looksAfter: [],
    lastMessage: { text: 'Proposed a calmer Tally header.', at: '2026-10-27T12:00:00-04:00' },
  },
].map((agent) => ({ ...agent, createdBy: 'Gabriel' }));
const actions = [
  'start-task',
  'open-pull-request',
  'merge',
  'restart',
  'rollback',
  'install',
  'change-secrets',
  'use-screen',
  'spend',
];
const rules = agents.flatMap((agent) =>
  actions.map((action) => ({
    id: `${agent.id}:${action}`,
    agent: agent.id,
    action,
    mode: agent.id === writerId && action === 'start-task' ? 'allow' : 'ask',
  })),
);
const projects = ['home-gym', 'tally', 'deploy.local', 'recipes', 'immich'].map((id) => ({
  id,
  name: id,
  apps: [{ id, name: id, kind: 'web' }],
}));
const nodes = [
  { id: 'coordinator', name: 'SER', online: true },
  { id: 'bazzite', name: 'bazzite', online: true },
];
const event = (id, kind, values, at = now) => ({ id, kind, at, ...values });
const you = (id, text) => event(id, 'you', { text, attachments: [] });
const reply = (id, agent, paragraphs, receipts) =>
  event(id, 'reply', {
    agent,
    paragraphs,
    ...(receipts ? { receipts } : {}),
  });
const taught = [
  you('teach-friday', releaseJob),
  reply(
    'saved-friday',
    writerId,
    [
      'I’ll draft the week’s home-gym changes in warm, plain language, grouped into features and fixes. I’ll ask before publishing.',
      'I’ve saved those instructions. For Fridays, I suggest 16:00 on SER’s clock; review and confirm the Looks after item before it starts.',
    ],
    [{ kind: 'job' }, { kind: 'looks-after', itemId: releaseItem.id }],
  ),
];
const beat = [
  you('teach-code-quality', 'Look after code quality on my active projects.'),
  reply(
    'saved-code-quality',
    reviewerId,
    [
      'I suggest checking home-gym, tally and deploy.local on Mondays at 08:40. Within your limits, I’ll prepare small fixes on a branch and bring tested pull requests. Visible changes come as a design review first; bigger work comes as a question.',
      'recipes is Active, but outside this agent’s project access.',
      'Later, you can include Maintained projects and dependency updates. Each Looks after item follows project stages within the access you grant.',
    ],
    [{ kind: 'looks-after', itemId: reviewItem.id }],
  ),
];
const writerConversation = [
  you('sync-question', 'How would you describe the sync fix to home-gym users?'),
  reply('sync-answer', writerId, [
    '“Your workouts now sync reliably after an update.” Lead with what changed for them; leave the database details out.',
  ]),
  you('draft-request', 'That’s the tone. Draft this week’s notes.'),
  reply('draft-answer', writerId, ['I’ll draft a first pass. I’ll ask before publishing.']),
  event('draft-task', 'task', { taskId: 'draft-this-week' }),
];
const running = [
  { id: 'draft-this-week', title: 'Draft this week’s release notes', computer: 'SER', at: now },
];
const history = [
  {
    id: 'notes-latest',
    itemId: releaseItem.id,
    title: 'No new merges this week',
    status: 'Finished',
    at: '2026-10-30T16:00:00-04:00',
  },
  {
    id: 'notes-previous',
    itemId: releaseItem.id,
    title: 'Drafted notes for 3 changes',
    status: 'Finished',
    at: '2026-10-23T16:00:00-04:00',
  },
];
const headCommit = 'b'.repeat(40);
const baseCommit = 'a'.repeat(40);
const taskId = 'last-updated-time';
const checks = ['Tests', 'Build', 'Review'].map((name, i) => ({
  id: `check-${i}`,
  name,
  source: 'workspace',
  commit: headCommit,
  headCommit,
  status: 'passed',
  finishedAt: ago(2),
  durationMs: 1000,
}));
const pull = {
  id: '5',
  number: 5,
  title: 'Format the last-updated time as HH:MM:SS',
  status: 'open',
  revision: 1,
  sourceBranch: 'task/last-updated-24h',
  targetBranch: 'main',
  taskIds: [taskId],
  createdAt: ago(34),
  updatedAt: ago(2),
  checksPassed: 3,
  checkCount: 3,
  checksCommit: headCommit,
};
const taskView = {
  task: {
    id: taskId,
    title: pull.title,
    projectId: 'tally',
    status: 'review',
    revision: 1,
    branch: pull.sourceBranch,
    createdAt: ago(40),
    updatedAt: ago(2),
    startedBy: 'you',
    startedFrom: 'New task',
    startedModel: 'Opus',
  },
  project: { id: 'tally', name: 'Tally', kind: 'Web app', address: 'tally.deploy.local' },
  computer: 'SER',
  computerId: 'coordinator',
  run: {
    adapter: 'fixture',
    model: 'opus',
    modelName: 'Opus',
    status: 'succeeded',
    updatedAt: ago(2),
  },
  comparison: { ahead: 1, behind: 0 },
  cursor: 1,
  firstTask: false,
  pulls: [pull],
  checks,
  screenshots: [],
  releases: [],
  events: [
    you(
      'task-request',
      'In Tally, format the last-updated time under the count as HH:MM:SS in 24-hour time',
    ),
    event('task-work', 'worklog', {
      summary: 'Worked for 6m',
      live: false,
      steps: [
        { icon: 'file', text: 'Read web/server.mjs and web/tally.test.mjs' },
        { icon: 'edit', text: 'Edited 3 files', added: 36, removed: 4 },
        { icon: 'terminal', text: 'Ran node --test web · 12 passed' },
        { icon: 'file', text: 'Opened pull request #5' },
      ],
    }),
    reply('task-answer', reviewerId, [
      'The time under the count now reads 14:07:32: hours, minutes and seconds, padded, in 24-hour time. It comes from a small formatTime in web/format-time.mjs instead of toLocaleTimeString, which followed each visitor’s locale and showed 2:07 PM in the US.',
      'The first version showed midnight as 24:00:00. It reads 00:00:00 now, and a test covers it.',
    ]),
  ],
};
const patch = ['web/server.mjs', 'web/format-time.mjs', 'web/tally.test.mjs']
  .map(
    (file) =>
      `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`,
  )
  .join('');

export const boards = [
  'WorkNoAgentsPhone',
  'WorkAgentsPhone',
  'NewAgentBlankPhone',
  'NewAgentPhone',
  'AgentAvatarPickerPhone',
  'AgentHelloPhone',
  'AgentTaughtPhone',
  'AgentBeatPhone',
  'AgentPhone',
  'AgentMenuPhone',
  'AgentInfoPhone',
  'AgentInfoNewPhone',
  'AgentCareDetailsPhone',
  'AgentRoutinePhone',
  'AgentBeatProjectsPhone',
  'AgentRunsPhone',
  'SettingsApprovalsPhone',
  'AgentRulesPhone',
  'TaskMentionPhone',
];
export const origin = 'http://127.0.0.1:5186';
const nativeActions = new Set(actions.slice(0, 5));
const workers = nodes.map((node) => ({
  id: node.id,
  name: node.name,
  status: 'online',
  capabilities: ['codex', 'claude'],
  modelOptions: [{ id: 'claude', models: [{ id: 'opus', name: 'Opus' }] }],
}));
const taskRecord = (values) => ({
  revision: 1,
  workspacePath: '/fixture/' + values.id,
  baseRevision: baseCommit,
  createdAt: ago(1),
  updatedAt: ago(1),
  workerId: 'coordinator',
  ...values,
});
// The phone board still shows the sync-worker task from 12-ios-2. Keep the web
// TaskMention Tally task too; route the phone to the task its own board depicts.
const syncTask = taskRecord({
  id: 'sync',
  title: 'Fix the sync worker',
  projectId: 'home-gym',
  workerId: 'bazzite',
  status: 'running',
});
const syncEvents = [
  you(
    'sync-request',
    'Make the home-gym sync worker read started_at, and add a test that runs it against the migrated schema',
  ),
  event('sync-work', 'worklog', {
    summary: 'Working on bazzite · Codex · 1m',
    live: true,
    steps: [
      { icon: 'file', text: 'Read src/sync/workouts.ts and migration 0042' },
      { icon: 'edit', text: 'Edited src/sync/workouts.ts', added: 6, removed: 6 },
      { icon: 'terminal', text: 'Running pnpm test src/sync' },
    ],
  }),
];
const allTasks = [
  taskRecord(taskView.task),
  syncTask,
  taskRecord({
    id: running[0].id,
    title: running[0].title,
    projectId: 'home-gym',
    status: 'running',
  }),
  ...history.map((run) =>
    taskRecord({
      id: run.id,
      title: run.title,
      projectId: 'home-gym',
      status: 'finished',
      createdAt: run.at,
      updatedAt: run.at,
    }),
  ),
];

export function scenario(board) {
  if (!boards.includes(board)) throw new Error('Unknown iPhone board: ' + board);
  const state = structuredClone({
    board,
    agents,
    rules,
    inbox: [],
    controls: {},
    conversations: { [writerId]: writerConversation, [reviewerId]: beat },
    taskEvents: { [taskId]: taskView.events, sync: syncEvents },
  });
  const writer = state.agents[0];
  if (board === 'WorkNoAgentsPhone') state.agents = [];
  if (['AgentHelloPhone', 'AgentInfoNewPhone'].includes(board)) {
    writer.job = '';
    writer.looksAfter = [];
    writer.computers = [];
    delete writer.projectId;
    delete writer.lastMessage;
    state.conversations[writerId] = [];
    // A brand-new agent has not yet been granted permission to start tasks.
    for (const rule of state.rules.filter((rule) => rule.agent === writerId)) rule.mode = 'ask';
  }
  if (['AgentTaughtPhone', 'AgentRoutinePhone'].includes(board)) {
    state.conversations[writerId] = structuredClone(taught);
    delete writer.looksAfter[0].confirmedAt;
    delete writer.looksAfter[0].nextAt;
    if (board === 'AgentRoutinePhone') writer.looksAfter[0].what = routineWhat;
  }
  if (['AgentBeatPhone', 'AgentBeatProjectsPhone'].includes(board)) {
    delete state.agents[2].looksAfter[0].confirmedAt;
    delete state.agents[2].looksAfter[0].nextAt;
  }
  return state;
}

// Exported for socket-free contract checks in sandboxes that prohibit listen().
export function createFixtureHandler() {
  let state = scenario('WorkAgentsPhone');
  return async (req, res) => {
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      let input = {};
      if (!['GET', 'HEAD'].includes(req.method)) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 1024 * 1024) return send({ error: 'Fixture request too large' }, 413);
          chunks.push(Buffer.from(chunk));
        }
        try {
          if (chunks.length) input = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return send({ error: 'Fixture expects JSON' }, 400);
        }
        if (!input || typeof input !== 'object' || Array.isArray(input))
          return send({ error: 'Fixture expects an object' }, 400);
      }
      if (path === '/fixture/board') {
        if (req.method === 'POST') {
          if (!boards.includes(input.board))
            return send({ error: 'Unknown iPhone board', boards }, 400);
          state = scenario(input.board);
        } else if (req.method !== 'GET') return send({ error: 'Use GET or POST' }, 405);
        return send({ fixture: 'agents-p1-ios', board: state.board, boards, now });
      }
      if (path === '/api/login' && req.method === 'POST') return send({ token: 'fixture-only' });
      if (req.headers['x-deploy-token'] !== 'fixture-only')
        return send({ error: 'Fixture credentials required' }, 401);
      // Complete canonical rules, including actions the native Codable enum cannot decode.
      if (path === '/fixture/state' && req.method === 'GET') return send(state);
      if (path === '/api/user') return send({ username: 'Gabriel', role: 'admin' });
      if (path === '/api/nodes')
        return send({
          nodes: nodes.map((node) => ({
            ...node,
            kind: node.id === 'coordinator' ? 'coordinator' : 'worker',
            roles: node.id === 'coordinator' ? ['coordinator', 'run-apps'] : ['take-tasks'],
          })),
        });
      if (path === '/api/v2/projects') return send({ projects });
      if (path === '/api/v2/live')
        return send({
          summary: {
            running: 0,
            failing: state.board === 'TaskMentionPhone' ? 1 : 0,
            warning: 0,
            checkedAt: now,
          },
          computers: nodes.map((node) => ({
            ...node,
            roles: node.id === 'coordinator' ? ['coordinator', 'run-apps'] : ['take-tasks'],
            apps: [],
          })),
        });
      if (path === '/api/workspace/state') {
        const taskIDs =
          state.board === 'WorkNoAgentsPhone'
            ? []
            : state.board === 'TaskMentionPhone'
              ? ['sync', taskId]
              : [
                    'AgentHelloPhone',
                    'AgentInfoNewPhone',
                    'AgentTaughtPhone',
                    'AgentBeatPhone',
                    'NewAgentBlankPhone',
                    'NewAgentPhone',
                    'AgentAvatarPickerPhone',
                  ].includes(state.board)
                ? []
                : [running[0].id];
        return send({
          version: 1,
          cursor: 0,
          projects,
          workers,
          tasks: allTasks.filter((task) => taskIDs.includes(task.id)),
          runs: [],
          adapters: [],
        });
      }
      if (path === '/api/v2/inbox') return send({ items: state.inbox });
      if (path === '/api/v2/events') {
        // Workspace events contain the task's actual typed conversation, not TaskDetail.events.
        const events = Object.entries(state.taskEvents)
          .flatMap(([id, entries]) =>
            entries.map((entry) => ({
              taskId: id,
              type: 'conversation',
              at: entry.at,
              event: entry,
            })),
          )
          .map((entry, i) => ({ ...entry, cursor: i + 1 }));
        const after = Number(url.searchParams.get('after')) || 0;
        if (after >= events.length) await new Promise((resolve) => setTimeout(resolve, 1000));
        return send({
          events: events.filter((entry) => entry.cursor > after),
          cursor: events.length,
          supportsWait: true,
        });
      }
      if (path === '/api/v2/agents') {
        if (req.method === 'POST') {
          const agent = {
            id: writerId,
            name: input.name,
            avatar: input.avatar,
            job: '',
            computers: [],
            looksAfter: [],
            createdBy: 'Gabriel',
          };
          state.agents = [agent, ...state.agents.filter((agent) => agent.id !== writerId)];
          state.conversations[writerId] = [];
          for (const rule of state.rules.filter((rule) => rule.agent === writerId))
            rule.mode = 'ask';
          return send({ agent }, 201);
        }
        return send({ agents: state.agents, timezone });
      }
      if (path === '/api/v2/approvals') {
        // iPhone knows five actions. Preserve the web fixture's other rules in memory.
        if (req.method === 'PUT') {
          if (
            !Array.isArray(input.rules) ||
            input.rules.some(
              (rule) =>
                !nativeActions.has(rule.action) || !['allow', 'ask', 'never'].includes(rule.mode),
            )
          )
            return send({ error: 'Invalid native rules' }, 400);
          state.rules = [
            ...state.rules.filter((rule) => !nativeActions.has(rule.action)),
            ...input.rules,
          ];
        }
        return send({ rules: state.rules.filter((rule) => nativeActions.has(rule.action)) });
      }
      const agentMessage = path.match(/^\/api\/v2\/composer\/agents\/([^/]+)\/messages$/);
      if (agentMessage && req.method === 'POST') {
        const agent = state.agents.find(
          (agent) => agent.id === decodeURIComponent(agentMessage[1]),
        );
        if (!agent) return send({ error: 'Missing fixture agent' }, 404);
        if ([writerId, reviewerId].includes(agent.id)) {
          const item = structuredClone(agent.id === writerId ? releaseItem : reviewItem);
          delete item.confirmedAt;
          delete item.nextAt;
          agent.job = agent.id === writerId ? releaseJob : reviewJob;
          agent.looksAfter = [item];
          if (agent.id === writerId) agent.projectId = 'home-gym';
          state.conversations[agent.id] = structuredClone(agent.id === writerId ? taught : beat);
        } else state.conversations[agent.id] = [you('fixture-message', input.text || '')];
        return send({ events: state.conversations[agent.id] });
      }
      const agentPath = path.match(/^\/api\/v2\/agents\/([^/]+)(.*)$/);
      if (agentPath) {
        const id = decodeURIComponent(agentPath[1]);
        const agent = state.agents.find((agent) => agent.id === id);
        if (!agent) return send({ error: 'Missing fixture agent' }, 404);
        const suffix = agentPath[2];
        if (!suffix) {
          if (req.method === 'PATCH') {
            for (const key of ['name', 'job', 'avatar', 'projectId', 'computers', 'looksAfter'])
              if (Object.hasOwn(input, key)) agent[key] = input[key];
          }
          if (req.method === 'DELETE') {
            state.agents = state.agents.filter((agent) => agent.id !== id);
            return send({ deleted: id });
          }
          return send({ agent });
        }
        if (suffix === '/conversation')
          return send({
            events: state.conversations[id] || [],
            tracking: {
              running:
                id === writerId &&
                !['AgentHelloPhone', 'AgentInfoNewPhone', 'AgentTaughtPhone'].includes(state.board)
                  ? running
                  : [],
              watching: [],
              shipped: [],
              runs: history,
            },
          });
        if (suffix === '/control') {
          state.controls[id] ??= { paused: false, mutedUntil: null };
          if (req.method === 'PATCH' || req.method === 'POST') {
            if (typeof input.paused === 'boolean') state.controls[id].paused = input.paused;
            if (typeof input.muteMinutes === 'number')
              state.controls[id].mutedUntil = input.muteMinutes
                ? new Date(Date.parse(now) + input.muteMinutes * 60000).toISOString()
                : null;
          }
          return send(state.controls[id]);
        }
        const itemPath = suffix.match(/^\/items\/([^/]+)\/(confirm|runs|run)$/);
        if (itemPath) {
          const item = agent.looksAfter?.find(
            (item) => item.id === decodeURIComponent(itemPath[1]),
          );
          if (!item) return send({ error: 'Missing fixture item' }, 404);
          if (itemPath[2] === 'runs')
            return send({ runs: item.id === releaseItem.id ? history : [] });
          if (itemPath[2] === 'confirm' && req.method === 'POST') {
            item.confirmedAt = now;
            item.nextAt = id === writerId ? releaseItem.nextAt : reviewItem.nextAt;
            return send({ agent, item });
          }
          if (itemPath[2] === 'run' && req.method === 'POST')
            return send({ task: { id: running[0].id } });
        }
      }
      const taskPath = path.match(/^\/api\/workspace\/tasks\/([^/]+)(?:\/(diff|messages))?$/);
      if (taskPath) {
        const task = allTasks.find((task) => task.id === decodeURIComponent(taskPath[1]));
        if (!task) return send({ error: 'Missing fixture task' }, 404);
        if (taskPath[2] === 'diff')
          return send({
            baseRevision: baseCommit,
            headRevision: headCommit,
            status: 'ready',
            files:
              task.id === 'sync'
                ? [{ path: 'src/sync/workouts.ts', status: 'modified' }]
                : task.id === taskId
                  ? ['web/server.mjs', 'web/format-time.mjs', 'web/tally.test.mjs'].map((path) => ({
                      path,
                      status: 'modified',
                    }))
                  : [],
            patch: task.id === taskId ? patch : '',
            checks: task.id === taskId ? checks : [],
          });
        const run = {
          id: 'run:' + task.id,
          taskId: task.id,
          adapter: task.id === 'sync' ? 'codex' : 'claude',
          model: task.id === 'sync' ? null : 'opus',
          status: task.status === 'running' ? 'running' : 'succeeded',
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        };
        if (taskPath[2] === 'messages' && req.method === 'POST') {
          state.taskEvents[task.id] ??= [];
          const id = 'message:' + input.operationId;
          if (!state.taskEvents[task.id].some((entry) => entry.id === id))
            state.taskEvents[task.id].push(you(id, input.content || ''));
          return send(run);
        }
        return send({ task, messages: [], runs: [run], events: [], cursor: 0 });
      }
      if (path === `/api/v2/tasks/${taskId}`)
        return send({ ...taskView, events: state.taskEvents[taskId] });
      if (/^\/api\/v2\/projects\/[^/]+\/releases$/.test(path)) return send({ releases: [] });
      // Never pretend to execute unsupported model, release, upload or coordinator operations.
      return send({ error: `Fixture route unavailable: ${req.method} ${path}` }, 404);
    } catch (error) {
      return send({ error: String(error) }, 500);
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.PORT && process.env.PORT !== '5186')
    throw new Error('This fixture uses only port 5186');
  const server = createServer(createFixtureHandler());
  server.listen(5186, '127.0.0.1', () => console.log(`Agents phase 1 iPhone fixture: ${origin}`));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
