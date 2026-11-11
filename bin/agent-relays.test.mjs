import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import {
  ensureRelay,
  publishedHostPort,
  relayRepairs,
  containerHasRelay,
  reportedApps,
  runtimeStartCommand,
} from './agent-relays.mjs';

function app(body) {
  const server = createServer((_req, res) => res.end(body));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })),
  );
}
const stop = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
const get = async (port) =>
  (await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } })).text();
const closeRelays = async (relays) => {
  for (const relay of relays.values()) {
    for (const socket of relay.sockets) socket.destroy();
    await new Promise((resolve) => relay.server.close(resolve));
  }
};

test('a relay keeps its port and follows the container to the port it restarted on', async () => {
  const relays = new Map();
  let saves = 0;
  const persist = () => saves++;
  // The container before the computer restarts.
  const first = await app('before restart');
  const relayPort = await ensureRelay(relays, persist, {
    name: 'release-abc',
    targetPort: first.port,
    containerName: 'deploy-sh-forma-web-1-dd4662d9',
  });
  assert.equal(await get(relayPort), 'before restart');
  // Docker restarts it on a new host port; the old one is gone.
  await stop(first.server);
  const second = await app('after restart');
  await assert.rejects(get(relayPort));
  const [repair] = relayRepairs(
    [{ name: 'release-abc', ...relays.get('release-abc') }],
    new Map([['deploy-sh-forma-web-1-dd4662d9', second.port]]),
  );
  assert.deepEqual(repair, {
    name: 'release-abc',
    targetPort: second.port,
    relayPort,
    containerName: 'deploy-sh-forma-web-1-dd4662d9',
  });
  const saved = saves;
  assert.equal(
    await ensureRelay(relays, persist, { ...repair, preferredPort: repair.relayPort }),
    relayPort,
  );
  assert.equal(saves, saved + 1);
  assert.equal(await get(relayPort), 'after restart');
  // Nothing left to repair, and nothing is written again.
  assert.deepEqual(
    relayRepairs(
      [{ name: 'release-abc', ...relays.get('release-abc') }],
      new Map([['deploy-sh-forma-web-1-dd4662d9', second.port]]),
    ),
    [],
  );
  await closeRelays(relays);
  await stop(second.server);
});

test('a relay whose saved port was busy at startup takes it back once it is free', async () => {
  const relays = new Map();
  const target = await app('forma');
  const squatter = createTcpServer();
  const wanted = await new Promise((resolve) =>
    squatter.listen(0, () => resolve(squatter.address().port)),
  );
  // Restoring after a restart: the port the coordinator knows is taken.
  const fallback = await ensureRelay(relays, () => {}, {
    name: 'release-abc',
    targetPort: target.port,
    preferredPort: wanted,
    containerName: 'deploy-sh-forma-web-1-dd4662d9',
  });
  assert.notEqual(fallback, wanted);
  assert.equal(relays.get('release-abc').wantedPort, wanted);
  const hostPorts = new Map([['deploy-sh-forma-web-1-dd4662d9', target.port]]);
  const list = () => [{ name: 'release-abc', ...relays.get('release-abc') }];
  // Still taken: the working relay stays where it is.
  let [repair] = relayRepairs(list(), hostPorts);
  assert.equal(repair.relayPort, wanted);
  assert.equal(
    await ensureRelay(relays, () => {}, { ...repair, preferredPort: repair.relayPort }),
    fallback,
  );
  assert.equal(await get(fallback), 'forma');
  await new Promise((resolve) => squatter.close(resolve));
  [repair] = relayRepairs(list(), hostPorts);
  assert.equal(
    await ensureRelay(relays, () => {}, { ...repair, preferredPort: repair.relayPort }),
    wanted,
  );
  assert.equal(await get(wanted), 'forma');
  assert.deepEqual(relayRepairs(list(), hostPorts), []);
  await closeRelays(relays);
  await stop(target.server);
});

test('relays for stopped containers are left alone', () => {
  assert.deepEqual(
    relayRepairs(
      [
        { name: 'forma', targetPort: 1, relayPort: 64500, containerName: 'deploy-sh-forma-old' },
        { name: 'legacy', targetPort: 2, relayPort: 64501 },
      ],
      new Map([['deploy-sh-other', 9]]),
    ),
    [],
  );
  // A relay saved without a container name serves the container named after it.
  assert.deepEqual(
    relayRepairs(
      [{ name: 'Legacy', targetPort: 2, relayPort: 64501 }],
      new Map([['deploy-sh-legacy', 9]]),
    ),
    [{ name: 'Legacy', targetPort: 9, relayPort: 64501, containerName: undefined }],
  );
});

test('discovery does not add a second relay for a container that has one', () => {
  const relays = [
    { name: 'release-abc', relayPort: 59593, containerName: 'deploy-sh-forma-web-1-dd4662d9' },
    { name: 'groffee', relayPort: 50000 },
  ];
  assert.equal(containerHasRelay(relays, 'deploy-sh-forma-web-1-dd4662d9'), true);
  assert.equal(containerHasRelay(relays, 'deploy-sh-groffee'), true);
  assert.equal(containerHasRelay(relays, 'deploy-sh-wander'), false);
});

test('the heartbeat reports the running copy of an app, not an older stopped one', () => {
  // What the iMac reported on 2026-11-10: the stopped copy hid the one that was serving.
  const apps = reportedApps(
    [
      {
        id: 'new',
        containerName: 'deploy-sh-forma-web-1-dd4662d9',
        status: 'running',
        detail: 'Up 40 minutes',
        label: 'forma',
      },
      {
        id: 'old',
        containerName: 'deploy-sh-forma-web-1-a75f027a',
        status: 'exited',
        detail: 'Exited (0) 3 days ago',
        label: 'forma',
      },
      { id: 'x', containerName: 'unrelated', status: 'running', detail: '', label: '' },
    ],
    [
      { name: 'forma', relayPort: 64500, containerName: 'deploy-sh-forma-web-1-a75f027a' },
      { name: 'release-abc', relayPort: 59593, containerName: 'deploy-sh-forma-web-1-dd4662d9' },
    ],
  );
  assert.deepEqual(apps, [
    {
      id: 'new',
      name: 'forma',
      containerName: 'deploy-sh-forma-web-1-dd4662d9',
      status: 'running',
      detail: 'Up 40 minutes',
      relayPort: 59593,
    },
  ]);
  // Without a label the name comes from the container, as before.
  assert.equal(
    reportedApps(
      [{ id: 'g', containerName: 'deploy-sh-groffee', status: 'running', detail: '', label: '' }],
      [{ name: 'groffee', relayPort: 50000 }],
    )[0].relayPort,
    50000,
  );
});

test('docker port output gives the host port', () => {
  assert.equal(publishedHostPort('3000/tcp -> 127.0.0.1:55123\n'), 55123);
  assert.equal(publishedHostPort(''), 0);
});

test('the worker starts Colima on a Mac and leaves every other runtime alone', () => {
  assert.deepEqual(
    runtimeStartCommand({
      platform: 'darwin',
      dockerHost: 'unix:///Users/someone/.colima/default/docker.sock',
    }),
    { command: 'colima', args: ['start'] },
  );
  assert.deepEqual(
    runtimeStartCommand({
      platform: 'darwin',
      dockerHost: 'unix:///Users/someone/.colima/work/docker.sock',
    }),
    { command: 'colima', args: ['start', '--profile', 'work'] },
  );
  assert.equal(
    runtimeStartCommand({
      platform: 'darwin',
      dockerHost: 'unix:///Users/someone/.orbstack/run/docker.sock',
    }),
    null,
  );
  assert.equal(
    runtimeStartCommand({
      platform: 'linux',
      dockerHost: 'unix:///home/someone/.colima/default/docker.sock',
    }),
    null,
  );
});
