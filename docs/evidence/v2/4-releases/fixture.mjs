// Isolated browser fixture; never proxies to a coordinator.
import { createServer } from 'node:http';
const apps = [
  { id: 'home-gym', name: 'home-gym', kind: 'web' },
  { id: 'home-gym-sync', name: 'home-gym sync', kind: 'worker' },
];
const step = (name, state, detail) => ({ name, state, detail });
const release = (id, projectId, state, ref) => ({
  id,
  projectId,
  state,
  startedBy: 'Gabriel',
  source: { kind: 'ship', ref },
  apps: apps.map((app) => ({ appId: app.id, from: '81be0d2', to: id })),
  migrations: [],
  steps: [
    step('prepare', 'done', 'Built for SER and bazzite · 41 s'),
    step('verify', 'done', 'GET /healthz 200 · workers healthy'),
    step('activate', 'done', 'All apps switched'),
    step('watch', 'done', 'Watched for 10 minutes'),
  ],
});
const live = release(
  '2a91c0e',
  'deploy.local',
  'live',
  'Stop the repositories cancellation test timing out',
);
const progress = release('7f3b2d4', 'deploy.local', 'running', live.source.ref);
progress.steps = [
  step('prepare', 'done', 'Built for SER and the task workers · 41 s'),
  step('verify', 'running', 'GET /healthz 200 · a sample task is running on bazzite'),
  step('activate', 'waiting', 'Switch every app'),
  step('watch', 'waiting', 'Warden, for 10 minutes'),
];
const failed = release('b81e4c0', 'home-gym', 'failed', 'Add rest-timer sounds');
failed.steps = [
  step('prepare', 'done', 'Prepared both apps · 19.4 s'),
  step('verify', 'failed', 'Web app GET /healthz returned 500 on the copy'),
  step('activate', 'skipped'),
  step('watch', 'skipped'),
];
const previous = release('81be0d2', 'home-gym', 'live', 'Previous release');
const bad = release('9c3e1fa', 'home-gym', 'rolled-back', 'Improve workout sync');
bad.migrations = [{ id: '0042', title: 'Migration 0042', reversible: true }];
const rollback = {
  id: 'rollback-42',
  projectId: 'home-gym',
  from: bad.id,
  to: previous.id,
  reason:
    'The sync worker failed 38% of jobs after the 1:58 PM release. Both apps and migration 0042 went back together.',
  approvedBy: 'rule',
  ruleId: 'warden-home-gym',
  steps: [
    step('prepare', 'done'),
    step('verify', 'done'),
    step('activate', 'done', 'Both apps and migration 0042 went back together'),
    step('watch', 'done', 'Healthy'),
  ],
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const referer = req.headers.referer || '';
  res.setHeader('Content-Type', 'application/json');
  if (path.endsWith('/events')) {
    const timer = setTimeout(
      () => res.end(JSON.stringify({ events: [], cursor: 1, supportsWait: true })),
      1000,
    );
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (path === '/api/v2/projects')
    return res.end(
      JSON.stringify({
        projects: [
          {
            id: 'deploy.local',
            name: 'deploy.local',
            apps: [
              { id: 'home-gym', name: 'Coordinator', kind: 'web' },
              { id: 'home-gym-sync', name: 'Task workers', kind: 'worker' },
            ],
          },
          { id: 'home-gym', name: 'home-gym', apps },
        ],
      }),
    );
  if (path.endsWith('/rollbacks'))
    return res.end(JSON.stringify({ rollbacks: referer.includes('/9c3e1fa') ? [rollback] : [] }));
  if (path.endsWith('/releases'))
    return res.end(
      JSON.stringify({
        releases: path.includes('deploy.local')
          ? [
              ...(referer.includes('/7f3b2d4') ? [progress] : []),
              live,
              release('0d96f82', 'deploy.local', 'superseded', 'PR #17'),
              release('d279f45', 'deploy.local', 'superseded', 'PR #16'),
            ]
          : [failed, previous, bad, release('4c2a7d1', 'home-gym', 'superseded', 'PR #39')],
      }),
    );
  if (path.endsWith('/rollback') && req.method === 'POST')
    return res.end(
      JSON.stringify({
        rollback: {
          ...rollback,
          approvedBy: 'Gabriel',
          steps: [
            step('prepare', 'running'),
            step('verify', 'waiting'),
            step('activate', 'waiting'),
            step('watch', 'waiting'),
          ],
        },
      }),
    );
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Fixture route not found' }));
});
server.listen(5195, '127.0.0.1', () => console.log('Release fixture on 5195'));
