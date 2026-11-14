// Isolated fixture. API data is synthetic; only web assets are proxied to Vite on 5185.
import { createServer, request as httpRequest } from 'node:http';
const actions = [
  'merge',
  'ship',
  'rollback',
  'restart',
  'install',
  'change-secrets',
  'use-screen',
  'spend',
];
const agents = [
  {
    id: 'scout',
    name: 'Scout',
    job: "Keep deploy.local's development loop moving.\n- Each morning, review open gaps, failed checks and last week's tasks; propose at most 3 improvements.\n- Turn approved proposals into tasks with a clear brief and tests.\n- Have a different model review every pull request before asking me to merge.\n- Never merge or release without my approval.",
    computers: [],
    createdBy: 'Gabriel',
  },
  {
    id: 'warden',
    name: 'Warden',
    job: 'Watch every app and computer.\n- Check health every minute and for 10 minutes after each release.\n- When something fails, find the release or change that caused it.\n- Propose the smallest fix: a restart, a rollback, or handing it to Scout.\n- Never touch data without asking.',
    computers: [],
    createdBy: 'Gabriel',
  },
  {
    id: 'keeper',
    name: 'Keeper',
    job: 'Watch disk space on every computer.\n- Each morning, check free space on SER and bazzite and how fast each app is growing.\n- If a disk will fill within 7 days, tell me which app is growing and suggest what to clean up.\n- Never delete files or data. Suggest; I decide.',
    computers: ['SER', 'bazzite'],
    createdBy: 'Gabriel',
  },
];
let rules = agents.flatMap((agent) =>
  actions.map((action) => ({
    id: `${agent.id}:${action}`,
    agent: agent.id,
    action,
    mode: agent.id === 'warden' && action === 'restart' ? 'allow' : 'ask',
  })),
);
const at = '2026-10-27T11:00:00Z';
const items = [
  {
    id: 'merge',
    from: 'scout',
    kind: 'merge',
    title: 'Merge PR #18',
    text: 'Stops the repositories cancellation test timing out. Reviewed by GPT-6.1-Sol, 4 checks passed on this version.',
    actions: [
      { id: 'merge', label: 'Merge and release', primary: true },
      { id: 'review', label: 'Review' },
      { id: 'later', label: 'Not now' },
    ],
  },
  {
    id: 'pipeline',
    from: 'scout',
    kind: 'question',
    title: 'Start a self-release pipeline?',
    text: 'Releases still need SSH to SER. Two tasks: prepare, verify and activate with rollback, then worker auto-update.',
    actions: [
      { id: 'start', label: 'Start tasks', primary: true },
      { id: 'issue', label: 'Make an issue' },
      { id: 'dismiss', label: 'Dismiss' },
    ],
  },
  {
    id: 'rollback',
    from: 'warden',
    kind: 'rollback',
    title: 'Roll back home-gym?',
    text: 'Health checks failed after the release.',
    actions: [{ id: 'rollback', label: 'Roll back', primary: true }],
  },
  {
    id: 'keeper',
    from: 'keeper',
    kind: 'question',
    title: 'Keep 14 home-gym backups instead of 30?',
    text: 'Frees about 11 GB on bazzite and moves the full date out to about 5 weeks. The oldest copy would then be from October 13.',
    actions: [
      { id: '14', label: 'Keep 14', primary: true },
      { id: '30', label: 'Keep 30' },
      { id: 'later', label: 'Not now' },
    ],
  },
].map((item) => ({ ...item, createdAt: at, state: 'waiting' }));
const event = (id, kind, values, date = at) => ({ id, kind, at: date, ...values });
const scout = [
  event('work', 'worklog', {
    summary: 'Worked for 1m · morning brief',
    steps: [
      { icon: 'file', text: "Reviewed 14 pull requests and last week's tasks" },
      { icon: 'pulse', text: 'Checked SER 2a91c0e with Warden · healthy' },
      { icon: 'search', text: 'Compared open gaps against merged work' },
    ],
    live: false,
  }),
  event('reply', 'reply', {
    agent: 'scout',
    paragraphs: ['PR #17 shipped overnight. Two things need you, and I have one proposal.'],
  }),
  event('merge', 'decision', { inboxItemId: 'merge' }),
  event('pipeline', 'decision', { inboxItemId: 'pipeline' }),
  event('you', 'you', {
    text: "Yes to the pipeline, but have Warden review the rollback plan first. I'll look at #18 after lunch.",
    attachments: [],
  }),
  event('work2', 'worklog', {
    summary: 'Worked for 2m',
    steps: [
      { icon: 'pulse', text: 'Asked Warden to review the rollback plan · approved' },
      { icon: 'file', text: 'Started Self-release pipeline on MacBook Pro' },
    ],
    live: false,
  }),
  event('reply2', 'reply', {
    agent: 'scout',
    paragraphs:
      "The pipeline task is running on MacBook Pro, and I'll ask before it activates anything on SER. #18 stays in Waiting on you.".split(
        '\n',
      ),
  }),
];
const keeper = [
  event('work', 'worklog', {
    summary: 'Worked for 30s · 8:00 AM · morning check',
    steps: [
      { icon: 'pulse', text: 'Checked free space on SER and bazzite' },
      { icon: 'search', text: 'Compared growth with the last 7 days' },
    ],
    live: false,
  }),
  event('reply', 'reply', {
    agent: 'keeper',
    paragraphs: [
      'Good morning. SER is at 61% and gains about 4 GB a day, mostly Immich imports. At that rate it fills in about 96 days, so there is nothing to do yet.',
      'bazzite is at 72%. Backups grew 9 GB this week because home-gym keeps 30 nightly copies. At this rate bazzite fills in about 19 days.',
    ],
  }),
  event('decision', 'decision', { inboxItemId: 'keeper' }),
];
const job =
  'Watch disk space on SER and bazzite. Tell me a week before a disk fills, say which app is growing, and suggest what to clean up. Never delete anything yourself.';
// Fixture-only interaction setup; shipped application has no screenshot switches or canned agent drafts.
const setup = `
const board = new URL(location.href).searchParams.get('board');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i=0;i<100;i++) {
 if (board === 'NewAgent' || board === 'NewAgentDraft') {
  const field=document.querySelector('#agent-job');
  if(field) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(job)}); field.dispatchEvent(new Event('input',{bubbles:true})); await sleep(50); if(board==='NewAgentDraft') [...document.querySelectorAll('button')].find(b=>b.textContent==='Draft it')?.click(); break; }
 } else if(board==='RuleEdit') {
  const button=document.querySelector('[aria-label="Edit Warden: Restart an app"]'); if(button){button.click();break;}
 } else break;
 await sleep(50);
}
`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5184');
  const board = new URL(req.headers.referer || url.href).searchParams.get('board');
  const path = url.pathname;
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (path === '/fixture-setup.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(setup);
    return;
  }
  if (path.startsWith('/api/')) {
    let body = {};
    if (req.method !== 'GET') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {}
    }
    if (path.endsWith('/events')) {
      const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 1000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (path === '/api/user') return send({ username: 'Gabriel' });
    if (path === '/api/nodes')
      return send({ nodes: [{ online: true }, { online: true }, { online: true }] });
    if (path === '/api/state')
      return send({
        tasks: [
          {
            id: 'pipeline',
            title: 'Self-release pipeline',
            status: 'running',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'sync',
            title: 'Fix the sync migration',
            status: 'running',
            createdAt: new Date().toISOString(),
          },
        ],
        projects: [],
        runs: [],
      });
    if (path === '/api/live') return send({ summary: { running: 7, failing: 1 }, computers: [] });
    if (path === '/api/agents/draft')
      return send({
        draft: { name: agents[2].name, job: agents[2].job, computers: agents[2].computers },
      });
    if (path === '/api/agents') {
      if (req.method === 'POST') {
        const agent = { ...body, id: 'keeper', createdBy: 'Gabriel' };
        return send({ agent }, 201);
      }
      return send({
        agents: ['KeeperPage', 'SettingsAgentsNew', 'NewAgentDraft'].includes(board)
          ? agents
          : agents.slice(0, 2),
      });
    }
    if (path === '/api/projects')
      return send({
        projects: [
          { id: 'gym', name: 'home-gym', apps: [] },
          { id: 'deploy', name: 'deploy.local', apps: [] },
        ],
      });
    if (path === '/api/approvals') {
      if (req.method === 'PUT') rules = body.rules;
      return send({
        rules: rules.filter(
          (rule) => ['SettingsAgentsNew'].includes(board) || rule.agent !== 'keeper',
        ),
      });
    }
    if (path === '/api/inbox')
      return send({
        items:
          url.searchParams.get('state') === 'answered'
            ? []
            : items.filter((item) => item.from !== 'keeper' || board === 'KeeperPage'),
      });
    if (path.includes('/inbox/') && path.endsWith('/answer')) {
      const item = items.find((item) => item.id === path.split('/')[4]);
      if (item) {
        item.state = 'answered';
        item.answer = {
          actionId: body.actionId,
          by: 'Gabriel',
          on: 'web',
          at: new Date().toISOString(),
        };
        return send({ item });
      }
    }
    if (path.endsWith('/conversation')) {
      if (path.includes('/keeper/')) return send({ events: keeper });
      if (board === 'LongChat')
        return send({
          events: [
            event(
              'last-week',
              'reply',
              { agent: 'scout', paragraphs: ['5 briefs · 9 tasks started, 7 shipped, 2 closed'] },
              '2026-10-20T11:00:00Z',
            ),
            event(
              'yesterday',
              'reply',
              {
                agent: 'scout',
                paragraphs: ['Brief and 3 follow-ups · started Self-release pipeline'],
              },
              '2026-10-26T11:00:00Z',
            ),
            ...scout.slice(0, 3),
          ],
        });
      return send({ events: scout });
    }
    if (path.startsWith('/api/agents/') && req.method === 'PATCH')
      return send({
        agent: { ...agents.find((agent) => agent.id === path.split('/')[4]), ...body },
      });
    return send({ error: 'Fixture route unavailable' }, 404);
  }
  const proxy = httpRequest(
    { hostname: '127.0.0.1', port: 5185, path: req.url, method: req.method, headers: req.headers },
    (response) => {
      if (response.headers['content-type']?.includes('text/html')) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          res.writeHead(response.statusCode, { 'Content-Type': 'text/html' });
          res.end(
            Buffer.concat(chunks)
              .toString()
              .replace('</body>', '<script type="module" src="/fixture-setup.js"></script></body>'),
          );
        });
      } else {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    },
  );
  proxy.on('error', () => send({ error: 'Start fixture Vite on 5185' }, 503));
  req.pipe(proxy);
});
server.listen(5184, '127.0.0.1', () =>
  console.log('Agent fixture: http://127.0.0.1:5184 (Vite assets on 5185)'),
);
