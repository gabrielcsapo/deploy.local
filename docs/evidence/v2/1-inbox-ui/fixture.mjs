import { createServer } from 'node:http';
// Isolated capture data only. Never used by the application.
const answeredBoard = process.env.INBOX_FIXTURE_BOARD === 'Inbox';
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60000).toISOString();
const titles = [
  'Roll back home-gym to 81be0d2',
  'Start the self-release pipeline',
  'Launch the bazzite app one way, not two',
  'Merge PR #17',
  'Restart Vaultwarden',
  'Use your screen to check the iOS build',
  'Merge PR #16',
];
const items = titles.map((title, i) => ({
  id: `answered-${i}`,
  title,
  text: title,
  kind: i === 0 ? 'rollback' : 'other',
  from: i === 0 || i === 4 ? 'warden' : 'scout',
  createdAt: at(i > 4 ? 1500 : 120),
  actions: [
    {
      id: 'approve',
      label: [
        'Approved',
        'Approved with a change',
        'Not now',
        'Approved',
        'Allowed by rule',
        'Allowed',
        'Approved',
      ][i],
    },
  ],
  state: 'answered',
  answer: {
    actionId: 'approve',
    by: 'Gabriel',
    on: i === 3 ? 'iphone' : i === 0 ? 'desktop' : 'web',
    at: at(i > 4 ? 1440 : 15 + i * 8),
    ...(i === 1 ? { note: 'have Warden review the rollback plan first' } : {}),
  },
}));
items.push(
  ...['Roll back home-gym?', 'Merge PR #18', 'Keep 3 or 5 releases?'].map((title, i) => ({
    id: `waiting-${i}`,
    title,
    text: [
      '38% of jobs error since 1:58 PM. Roll back home-gym to the last healthy release?',
      'The checks passed. Merge this pull request?',
      'Choose how many releases to keep.',
    ][i],
    kind: ['rollback', 'merge', 'question'][i],
    from: i === 0 ? 'warden' : 'scout',
    createdAt: at([0, 4, 12][i]),
    actions:
      i === 2
        ? [
            { id: 'three', label: 'Keep 3', primary: true },
            { id: 'five', label: 'Keep 5' },
            { id: 'answer', label: 'Answer' },
          ]
        : [
            { id: 'approve', label: i === 0 ? 'Roll back' : 'Merge', primary: true },
            { id: 'later', label: 'Not now' },
          ],
    state: 'waiting',
  })),
);
if (answeredBoard)
  items.splice(
    items.findIndex((item) => item.id === 'waiting-0'),
    1,
  );
const tasks = [
  'Self-release pipeline',
  'Fix the sync migration',
  'Show checks on merged PRs',
  'Rename workouts.started safely',
  'Update from main after conflicts',
  'Keep leading zeros in SSH keys',
  'Queue runs per computer',
].map((title, i) => ({
  id: `task-${i}`,
  title,
  status: i < 2 ? 'running' : 'idle',
  createdAt: at([12, 3, 40, 120, 1500, 1501, 1502][i]),
}));
const events = [];
let cursor = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body;
  let status = 200;
  if (url.pathname === '/api/v2/inbox')
    body = { items: items.filter((i) => i.state === (url.searchParams.get('state') || 'waiting')) };
  else if (url.pathname === '/api/v2/events') {
    const after = Number(url.searchParams.get('after'));
    if (after === cursor) await new Promise((r) => setTimeout(r, 500));
    body = { events: events.filter((e) => e.cursor > after), cursor, supportsWait: true };
  } else if (url.pathname.endsWith('/answer')) {
    let input = '';
    for await (const chunk of req) input += chunk;
    const answer = JSON.parse(input);
    const item = items.find((i) => i.id === decodeURIComponent(url.pathname.split('/')[4]));
    if (!item) {
      status = 404;
      body = { error: 'Missing' };
    } else {
      if (item.state === 'answered') status = 409;
      else {
        item.state = 'answered';
        item.answer = {
          actionId: answer.actionId,
          on: answer.on,
          by: 'Gabriel',
          at: new Date().toISOString(),
          note: answer.note,
        };
        events.push({
          type: 'inbox',
          item: structuredClone(item),
          cursor: ++cursor,
          at: item.answer.at,
          taskId: 'fixture',
          runId: null,
        });
      }
      body = { item, answer: item.answer };
    }
  } else if (url.pathname === '/api/workspace/state') body = { tasks, runs: [] };
  else if (url.pathname === '/api/user') body = { username: 'Gabriel' };
  else if (url.pathname === '/api/nodes')
    body = {
      nodes: [
        { name: 'SER', online: true },
        { name: 'bazzite', online: true },
        { name: 'Mac', online: true },
      ],
    };
  else if (url.pathname === '/api/v2/live')
    body = { summary: { running: 7, failing: answeredBoard ? 0 : 1 } };
  else {
    status = 404;
    body = { error: 'Not found' };
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});
server.listen(5193, '127.0.0.1', () => console.log('Isolated inbox fixture on 5193'));
process.on('SIGINT', () => server.closeAllConnections() || server.close(() => process.exit()));
