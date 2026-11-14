// In-memory visual fixture; imports no coordinator code and never opens app data.
import { createServer } from 'node:http';
const point = (id, name, sizeBytes, contents, computer, extra = {}) => ({
  id,
  name,
  projectId: name.toLowerCase(),
  apps: [name.toLowerCase()],
  kind: 'scheduled',
  createdAt: '2026-10-27T07:00:00Z',
  sizeBytes,
  contents,
  destination: '/mnt/backup',
  computer,
  verified: true,
  testStatus: 'untested',
  restoreAvailable: true,
  ...extra,
});
const backups = [
  point('pre-release', 'home-gym', 1.2e9, ['Postgres 17'], 'SER', {
    kind: 'pre-release',
    createdAt: '2026-10-27T17:57:00Z',
    releaseId: '9c3e1fa',
    testedAt: '2026-10-21T07:00:00Z',
    testStatus: 'passed',
  }),
  point('nightly', 'home-gym', 1.2e9, ['Postgres 17'], 'SER'),
  point('yesterday', 'home-gym', 1.2e9, ['Postgres 17'], 'SER', {
    createdAt: '2026-10-26T07:00:00Z',
  }),
  point('immich', 'Immich', 212e9, ['Photos and database'], 'SER'),
  point('vault', 'Vaultwarden', 40e6, ['Database'], 'bazzite'),
  point('recovery', 'deploy.local', 3.4e9, ['Projects, tasks, settings and secrets'], 'SER', {
    kind: 'recovery',
    restoreAvailable: false,
    unavailableReason:
      'Recover deploy.local on a new computer. Test-restore checks this bundle in a temporary folder.',
  }),
];
const restores = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/backups')
    return send({
      backups,
      restores,
      schedules: [
        {
          name: 'bazzite',
          enabled: true,
          schedule: '0 3 * * *',
          destination: '/mnt/backup',
          contents: 'App data and encrypted recovery bundles',
        },
      ],
    });
  const match = url.pathname.match(
    /^\/api\/backups\/([^/]+)\/(restore|test)(?:\/([^/]+)\/(switch|cancel))?$/,
  );
  if (match && req.method === 'POST') {
    if (match[2] === 'test') return send({ status: 'passed', testedAt: new Date().toISOString() });
    if (!match[3]) {
      const restore = {
        id: 'checked-copy',
        backupId: match[1],
        projectId: 'home-gym',
        state: 'ready',
        createdAt: new Date().toISOString(),
        addresses: [{ app: 'home-gym', url: 'http://127.0.0.1:5182/copy' }],
      };
      restores.push(restore);
      return send({ restore }, 201);
    }
    const restore = restores.find((entry) => entry.id === match[3]);
    if (!restore) return send({ error: 'Copy not found' }, 404);
    Object.assign(
      restore,
      match[4] === 'cancel'
        ? { state: 'cancelled' }
        : { state: 'live', releaseId: 'restored-release', retainedBackupId: 'previous-live-data' },
    );
    return send({ restore });
  }
  if (url.pathname === '/copy') {
    res.end('Fixture copy: home-gym data is ready to check.');
    return;
  }
  if (url.pathname === '/api/activity-events') {
    const timer = setTimeout(() => send({ events: [], cursor: 0, supportsWait: true }), 10000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (url.pathname === '/api/user') return send({ username: 'Gabriel' });
  if (url.pathname === '/api/nodes')
    return send({ nodes: [1, 2, 3].map(() => ({ online: true })) });
  if (url.pathname === '/api/live') return send({ summary: { running: 7, failing: 1 } });
  if (url.pathname === '/api/state') return send({ tasks: [], runs: [] });
  if (url.pathname === '/api/inbox')
    return send({
      items: [
        ['Roll back home-gym?', 0],
        ['Merge PR #18', 4],
        ['Keep 3 or 5 releases?', 12],
      ].map(([title, minutes], index) => ({
        id: `fixture-${index}`,
        title,
        kind: 'question',
        text: title,
        from: 'warden',
        state: 'waiting',
        actions: [],
        createdAt: new Date(Date.now() - minutes * 60000).toISOString(),
      })),
    });
  send({}, 404);
});
server.listen(5182, '127.0.0.1', () => console.log('Backup fixture on 5182'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
