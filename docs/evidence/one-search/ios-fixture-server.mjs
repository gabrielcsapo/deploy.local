// iPhone Search over the agents fixture's cast: local HTTP on loopback, fake credentials, and
// seeded search answers that match the SearchPhone board. No coordinator, database or Git.
import { createServer } from 'node:http';
import { createFixtureHandler } from '../agents-p1/ios-fixture-server.mjs';

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const line = (path, n, text) => ({
  projectId: 'home-gym',
  project: 'home-gym',
  ref: 'main',
  path,
  line: n,
  text,
});
const lines = [
  line('worker/sync.ts', 88, '.where(gte(workouts.started, since))'),
  line('app/routes/history.tsx', 41, '.orderBy(desc(workouts.started))'),
  line('worker/sync.ts', 131, 'const last = max(workouts.started);'),
  line('db/migrations/0042_started_at.sql', 1, '-- workouts.started becomes workouts.started_at'),
];
export function searchAnswer(url) {
  const q = url.searchParams.get('q') ?? '';
  const found = q.toLowerCase() === 'workouts.started';
  if (url.pathname === '/api/search/code')
    return {
      query: q,
      lines: found ? 12 : 0,
      files: found ? 5 : 0,
      projects: found ? 1 : 0,
      truncated: false,
      items: found ? lines.slice(0, Number(url.searchParams.get('limit')) || 2) : [],
    };
  return {
    query: q,
    names: found
      ? [
          {
            kind: 'task',
            id: 'sync',
            title: 'Rename workouts.started safely',
            projectId: 'home-gym',
            project: 'home-gym',
            status: 'done',
            agent: 'Code reviewer',
            at: ago(120),
          },
        ]
      : [],
    messages: {
      total: found ? 4 : 0,
      items: found
        ? [
            {
              id: 'e1',
              agentId: 'ops-watcher',
              title: 'Ops watcher',
              who: 'Ops watcher',
              fromYou: false,
              at: ago(21),
              snippet: '…the worker still reads workouts.started, which 0042 renamed.',
            },
            {
              id: 'm1',
              taskId: 'sync',
              agentId: 'code-reviewer',
              title: 'Fix the sync migration',
              who: 'Code reviewer',
              fromYou: false,
              at: ago(3),
              snippet: 'Changed the last reads of workouts.started in the worker.',
            },
          ]
        : [],
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inner = createFixtureHandler();
  createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:5186');
    if (url.pathname === '/api/search' || url.pathname === '/api/search/code') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(searchAnswer(url)));
    }
    return inner(req, res);
  }).listen(5186, '127.0.0.1', () =>
    console.log('One search iPhone fixture: http://127.0.0.1:5186'),
  );
}
