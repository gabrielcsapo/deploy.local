// Phase-1 parity fixture: synthetic API on 5184, web assets only from Vite on 5185.
// No coordinator, server modules, database, model provider, or persistent writes.
import { createServer, request as httpRequest } from 'node:http';

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
    [{ kind: 'looks-after', itemId: releaseItem.id }],
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

function scenario(board) {
  const state = structuredClone({
    agents,
    rules,
    inbox: [],
    conversations: {
      [writerId]: writerConversation,
      [reviewerId]: beat,
    },
  });
  const writer = state.agents[0];
  if (board === 'AgentsEmpty') state.agents = [];
  if (['AgentHello', 'AgentSettingsNew'].includes(board)) {
    writer.job = '';
    writer.looksAfter = [];
    writer.computers = [];
    delete writer.projectId;
    state.conversations[writerId] = [];
    if (board === 'AgentSettingsNew') delete writer.lastMessage;
  }
  if (['AgentTaught', 'AgentRoutine'].includes(board)) {
    state.conversations[writerId] = structuredClone(taught);
    delete writer.looksAfter[0].confirmedAt;
    delete writer.looksAfter[0].nextAt;
    if (board === 'AgentRoutine') writer.looksAfter[0].what = routineWhat;
  }
  if (['AgentBeat', 'AgentBeatProjects'].includes(board)) {
    delete state.agents[2].looksAfter[0].confirmedAt;
    delete state.agents[2].looksAfter[0].nextAt;
  }
  return state;
}
const sessions = new Map();

// Injected BEFORE the application modules: only the fixture reads ?board=.
// Seed UI through real controls after hydration; never replace rendered product markup.
const setup = `(() => {
  const requestedBoard = new URL(location.href).searchParams.get('board');
  const board = requestedBoard || sessionStorage.getItem('agents-p1-board') || 'AgentPage';
  // An explicit capture URL resets the scenario; ordinary navigation retains edits.
  const session = requestedBoard ? crypto.randomUUID() : sessionStorage.getItem('agents-p1-session') || crypto.randomUUID();
  sessionStorage.setItem('agents-p1-board', board);
  sessionStorage.setItem('agents-p1-session', session);
  const NativeDate = Date;
  const instant = NativeDate.parse(${JSON.stringify(now)});
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  localStorage.setItem('deploy-v2-first-task-seen', 'yes');
  localStorage.setItem('deploy.sidebar.collapsed', 'false');
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('x-fixture-board', board);
    headers.set('x-fixture-session', session);
    return nativeFetch(input, { ...init, headers });
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el && el.getClientRects().length > 0 && !el.closest('dialog:not([open])');
  async function waitFor(find, label) {
    for (let i = 0; i < 160; i++) {
      const result = find();
      if (result) return result;
      await sleep(25);
    }
    throw new Error('Fixture setup timed out: ' + label);
  }
  const button = (text, root = document) => [...root.querySelectorAll('button')].find(el => visible(el) && el.textContent.trim() === text);
  const dialog = title => [...document.querySelectorAll('dialog[open]')].find(el => el.querySelector('h2')?.textContent === title);
  const inputValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  async function prepare() {
    await waitFor(() => document.querySelector('.dl-main'), 'application mount');
    if (!requestedBoard) return;
    await sleep(150);
    if (['NewAgentBlank', 'NewAgent', 'AgentAvatarPicker'].includes(board)) {
      const field = await waitFor(() => document.querySelector('dialog[open] input[placeholder="Name your agent"]'), 'New agent name');
      inputValue(field, board === 'NewAgentBlank' ? '' : 'Release notes writer');
      (await waitFor(() => document.querySelector('dialog[open] .dl-agent-avatar-choice'), 'avatar control')).click();
      const picker = await waitFor(() => dialog('Choose avatar'), 'avatar picker');
      const glyph = board === 'NewAgentBlank' ? 'variant07' : 'variant28';
      const color = board === 'NewAgentBlank' ? 'Red' : 'Violet';
      picker.querySelector('[aria-label="' + glyph + '"]').click();
      await sleep(30);
      picker.querySelector('[aria-label="' + color + '"]').click();
      await sleep(30);
      if (board !== 'AgentAvatarPicker') {
        button('Done', picker).click();
        await waitFor(() => !dialog('Choose avatar'), 'picker close');
      }
    } else if (['AgentRoutine', 'AgentBeatProjects'].includes(board)) {
      const title = board === 'AgentRoutine' ? ${JSON.stringify(routineWhat)} : 'Code quality and updates';
      const row = await waitFor(() => [...document.querySelectorAll('button')].find(el => visible(el) && el.textContent.includes(title) && el.textContent.includes('Edit')), 'Looks after item');
      row.click();
      await waitFor(() => dialog('Looks after'), 'item editor');
    } else if (board === 'AgentRuns') {
      if (!location.pathname.endsWith('/history')) {
        const link = await waitFor(() => [...document.querySelectorAll('a')].find(el => visible(el) && el.textContent.trim() === 'History'), 'History link');
        link.click();
        return;
      }
      await waitFor(() => document.querySelector('main')?.textContent.includes('Drafted notes for 3 changes'), 'run history page');
    } else if (['AgentSettings', 'AgentCareDetails', 'AgentSettingsNew'].includes(board)) {
      await waitFor(() => document.querySelector('[aria-label="Start a task"]'), 'agent details and rules');
    } else if (board === 'TaskMention') {
      const field = await waitFor(() => document.querySelector('.dl-composer input:not([type="file"])'), 'task composer');
      await sleep(150);
      inputValue(field, '@');
      await waitFor(() => document.querySelectorAll('[role="option"]').length === 5, 'five mention choices');
    } else if (board === 'AgentsEmpty') {
      await waitFor(() => document.querySelector('.dl-main')?.textContent.includes('Make an agent to talk to'), 'empty agents');
    }
    document.documentElement.dataset.fixtureReady = board;
  }
  prepare().catch(error => {
    document.documentElement.dataset.fixtureError = error.message;
    console.error(error);
  });
})();`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5184');
  const path = url.pathname;
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (path === '/fixture-setup.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(setup);
  }
  if (path.startsWith('/api/')) {
    // The fetch header isolates each capture/tab. Referer also supports direct API inspection.
    const board =
      req.headers['x-fixture-board'] ||
      new URL(req.headers.referer || url.href).searchParams.get('board') ||
      'AgentPage';
    const key = req.headers['x-fixture-session'] || board;
    if (!sessions.has(key)) sessions.set(key, scenario(board));
    const state = sessions.get(key);
    let body = {};
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return send({ error: 'Fixture expects JSON' }, 400);
        }
      }
    }
    // Current phase-1 hooks use JSON long polling. SSE consumers get a genuinely idle stream.
    if (
      path === '/api/activity-events' ||
      path === '/api/events' ||
      path === '/api/events/stream' ||
      path === '/api/activity-events/stream'
    ) {
      if (req.headers.accept?.includes('text/event-stream') || path !== '/api/activity-events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': idle fixture\n\n');
        const heartbeat = setInterval(() => res.write(': idle fixture\n\n'), 15000);
        res.on('close', () => clearInterval(heartbeat));
      } else {
        const timer = setTimeout(
          () =>
            send({
              events: [],
              cursor: Number(url.searchParams.get('after')) || 1,
              supportsWait: true,
            }),
          1000,
        );
        res.on('close', () => clearTimeout(timer));
      }
      return;
    }
    if (path === '/api/user') return send({ username: 'Gabriel' });
    if (path === '/api/auth/account')
      return send({
        username: 'Gabriel',
        welcomed: true,
        firstTaskSeen: true,
        passkeyOffered: true,
      });
    if (path === '/api/nodes') return send({ nodes });
    if (path === '/api/live')
      return send({
        summary: { running: 0, failing: board === 'TaskMention' ? 1 : 0 },
        computers: [],
      });
    if (path === '/api/state')
      return send({
        projects,
        runs: [],
        tasks: [
          'AgentHello',
          'AgentTaught',
          'AgentSettingsNew',
          'AgentsEmpty',
          'SettingsAgents',
          'TaskMention',
        ].includes(board)
          ? []
          : [
              {
                id: 'draft-this-week',
                title: 'Release notes writer · run 2026-10-29',
                status: 'running',
                createdAt: ago(1),
              },
            ],
      });
    if (path === '/api/projects') return send({ projects });
    if (path === '/api/model-settings')
      return send({
        choices: [
          { id: 'connected', name: 'Connected model', provider: 'fixture', model: 'connected' },
          { id: 'opus', name: 'Opus', provider: 'fixture', model: 'opus' },
        ],
        defaults: {
          'writing-code': 'opus',
          reviewing: 'connected',
          'answering-questions': 'connected',
        },
        providers: [{ id: 'fixture', name: 'Fixture', computers: ['SER', 'bazzite'] }],
        local: [],
      });
    if (path === '/api/agents') {
      if (req.method === 'POST') {
        // Name-only creation opens a new empty chat without duplicating the five identities.
        const agent = {
          id: writerId,
          name: body.name,
          avatar: body.avatar,
          job: '',
          computers: [],
          looksAfter: [],
          createdBy: 'Gabriel',
        };
        state.agents = [agent, ...state.agents.filter((a) => a.id !== writerId)];
        state.conversations[writerId] = [];
        return send({ agent }, 201);
      }
      return send({ agents: state.agents, timezone });
    }
    if (path === '/api/approvals') {
      if (req.method === 'PUT') state.rules = body.rules;
      return send({ rules: state.rules });
    }
    if (path === '/api/inbox')
      return send({
        items: state.inbox.filter(
          (item) => item.state === (url.searchParams.get('state') || 'waiting'),
        ),
      });
    const answer = path.match(/^\/api\/inbox\/([^/]+)\/answer$/);
    if (answer && req.method === 'POST') {
      const item = state.inbox.find((item) => item.id === decodeURIComponent(answer[1]));
      if (!item) return send({ error: 'No such fixture inbox item' }, 404);
      Object.assign(item, {
        state: 'answered',
        answer: { actionId: body.actionId, by: 'Gabriel', on: 'web', at: now },
      });
      return send({ item });
    }
    const agentMessage = path.match(/^\/api\/composer\/agents\/([^/]+)\/messages$/);
    if (agentMessage && req.method === 'POST') {
      const agent = state.agents.find((a) => a.id === decodeURIComponent(agentMessage[1]));
      if (!agent) return send({ error: 'No such fixture agent' }, 404);
      const isWriter = agent.id === writerId;
      const item = structuredClone(isWriter ? releaseItem : reviewItem);
      delete item.confirmedAt;
      delete item.nextAt;
      if (isWriter || agent.id === reviewerId) {
        agent.job = isWriter ? releaseJob : reviewJob;
        agent.looksAfter = [item];
        if (isWriter) agent.projectId = 'home-gym';
        state.conversations[agent.id] = structuredClone(isWriter ? taught : beat);
      } else {
        state.conversations[agent.id] = [you('fixture-message', body.text || '')];
      }
      return send({ events: state.conversations[agent.id] });
    }
    if (path === '/api/composer/messages' && req.method === 'POST') {
      // Record the message, but never invoke a model or execute the task.
      state.taskEvents ??= structuredClone(taskView.events);
      state.taskEvents.push(you(`message-${state.taskEvents.length}`, body.text || ''));
      return send({ taskId: body.taskId || taskId }, 201);
    }
    const agentPath = path.match(/^\/api\/agents\/([^/]+)(.*)$/);
    if (agentPath) {
      const agent = state.agents.find((a) => a.id === decodeURIComponent(agentPath[1]));
      if (!agent) return send({ error: 'No such fixture agent' }, 404);
      const suffix = agentPath[2];
      if (!suffix) {
        if (req.method === 'PATCH') Object.assign(agent, body);
        if (req.method === 'DELETE') state.agents = state.agents.filter((a) => a !== agent);
        return send({ agent });
      }
      if (suffix === '/conversation')
        return send({
          events: state.conversations[agent.id] || [],
          tracking: {
            running:
              agent.id === writerId && !['AgentHello', 'AgentTaught'].includes(board)
                ? running
                : [],
            watching: [],
            shipped: [],
            runs: history,
          },
        });
      const itemPath = suffix.match(/^\/items\/([^/]+)\/(confirm|runs|run)$/);
      if (itemPath) {
        const item = agent.looksAfter?.find((i) => i.id === decodeURIComponent(itemPath[1]));
        if (!item) return send({ error: 'No such fixture item' }, 404);
        if (itemPath[2] === 'confirm' && req.method === 'POST') {
          item.confirmedAt = now;
          item.nextAt = agent.id === writerId ? releaseItem.nextAt : reviewItem.nextAt;
          return send({ agent, item });
        }
        if (itemPath[2] === 'runs')
          return send({ runs: item.id === releaseItem.id ? history : [] });
        if (itemPath[2] === 'run' && req.method === 'POST')
          return send({ task: { id: running[0].id } });
      }
    }
    if (path === `/api/task-snapshots/${taskId}`)
      return send({ ...taskView, events: state.taskEvents || taskView.events });
    if (/^\/api\/tasks\/(draft-this-week|notes-latest|notes-previous)$/.test(path)) {
      const id = path.split('/').at(-1);
      return send({
        ...taskView,
        task: {
          ...taskView.task,
          id,
          title: running[0].title,
          projectId: 'home-gym',
          status: 'running',
        },
        project: projects[0],
        pulls: [],
        checks: [],
        events: [],
        run: { ...taskView.run, status: 'running' },
      });
    }
    if (path === '/api/projects/tally/pulls/5/diff')
      return send({ patch, headCommit, baseCommit, mergeable: true, conflicts: [] });
    if (path === '/api/projects/tally/pulls/5') return send({ record: pull, checks });
    if (/^\/api\/tasks\/[^/]+\/diff$/.test(path))
      return send({ patch: '', headCommit, baseCommit });
    if (/^\/api\/projects\/[^/]+\/releases$/.test(path)) return send({ releases: [] });
    if (/^\/api\/projects\/[^/]+\/design\/changes$/.test(path))
      return send({ base: baseCommit, commit: headCommit, files: [] });
    if (/^\/api\/projects\/[^/]+\/design\/proposals$/.test(path)) return send({ proposals: [] });
    if (/^\/api\/projects\/[^/]+\/design$/.test(path)) return send({ canvas: null });
    // Captures never submit model work, upload attachments, merge, or release.
    // Fail explicitly instead of pretending an unimplemented action succeeded.
    console.warn(`Unimplemented fixture API: ${req.method} ${path}`);
    return send({ error: `Fixture route unavailable: ${req.method} ${path}` }, 404);
  }
  const proxy = httpRequest(
    {
      hostname: '127.0.0.1',
      port: 5185,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'accept-encoding': 'identity' },
    },
    (response) => {
      if (response.headers['content-type']?.includes('text/html')) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          res.writeHead(response.statusCode, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-store',
          });
          res.end(
            Buffer.concat(chunks)
              .toString()
              .replace(/<head([^>]*)>/i, '<head$1><script src="/fixture-setup.js"></script>'),
          );
        });
      } else {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    },
  );
  proxy.on('error', () => {
    if (res.headersSent) res.destroy();
    else send({ error: 'Start fixture Vite on 5185' }, 503);
  });
  req.pipe(proxy);
});
server.listen(5184, '127.0.0.1', () =>
  console.log('Agents phase 1 fixture: http://127.0.0.1:5184 (Vite assets on 5185)'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
