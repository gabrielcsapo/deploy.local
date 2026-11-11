import { createServer, connect } from 'node:net';

// Decisions the worker makes about app relays and the container runtime, kept free of Docker so they
// can be tested.
//
// An app container publishes its port on a random loopback port, and Docker picks a new one every
// time the container starts. The coordinator only knows the relay's port, so after Docker or the
// computer restarts the relay has to follow the container to its new port and keep its own.

/** Host port from `docker port <container>` output, or 0. */
export function publishedHostPort(output) {
  return Number(String(output || '').match(/->\s+.*:(\d+)\s*$/m)?.[1] || 0);
}

/** The container a relay serves. Relays made before container names were saved use their own name. */
export function relayContainerName(name, relay) {
  return relay?.containerName || `deploy-sh-${String(name).toLowerCase()}`;
}

/**
 * Relays that no longer reach their container, with what to change.
 * `relays`: [{ name, targetPort, relayPort, wantedPort?, containerName? }]
 * `hostPorts`: Map of running container name to its current host port.
 */
export function relayRepairs(relays, hostPorts) {
  const repairs = [];
  for (const relay of relays) {
    const containerName = relayContainerName(relay.name, relay);
    const hostPort = hostPorts.get(containerName);
    if (!hostPort) continue;
    const wantedPort = relay.wantedPort || relay.relayPort;
    if (hostPort === relay.targetPort && wantedPort === relay.relayPort) continue;
    repairs.push({
      name: relay.name,
      targetPort: hostPort,
      relayPort: wantedPort,
      containerName: relay.containerName,
    });
  }
  return repairs;
}

/** True when some relay already serves this container. */
export function containerHasRelay(relays, containerName) {
  return relays.some((relay) => relayContainerName(relay.name, relay) === containerName);
}

/**
 * Apps for the heartbeat: one entry per app. A running container wins over a stopped one, so an
 * old stopped copy can never hide the copy that is serving.
 * `rows`: [{ id, containerName, status, detail, label }] in `docker ps -a` order.
 */
export function reportedApps(rows, relays) {
  const apps = [];
  for (const row of rows) {
    if (!row.containerName?.startsWith('deploy-sh-')) continue;
    const name =
      row.label || row.containerName.replace(/^deploy-sh-/, '').replace(/-prev-\d+$/, '');
    const relay =
      relays.find((candidate) => candidate.containerName === row.containerName) ||
      relays.find(
        (candidate) =>
          !candidate.containerName &&
          (candidate.name === name || `deploy-sh-${candidate.name}` === row.containerName),
      );
    const app = {
      id: row.id,
      name,
      containerName: row.containerName,
      status: row.status,
      detail: row.detail,
      relayPort: relay?.relayPort,
    };
    const existing = apps.findIndex((candidate) => candidate.name === name);
    if (existing === -1) {
      apps.push(app);
      continue;
    }
    const current = apps[existing];
    const rank = (candidate) =>
      (candidate.status === 'running' ? 2 : 0) + (candidate.relayPort ? 1 : 0);
    if (rank(app) > rank(current)) apps[existing] = app;
  }
  return apps;
}

/**
 * The command that starts this computer's container runtime, or null when the worker should leave
 * it alone. Only Colima on a Mac: it has no service of its own, so nothing brings it back after a
 * restart. Docker Desktop and OrbStack start themselves at login, and Linux uses systemd.
 */
export function runtimeStartCommand({ platform, dockerHost, dockerError }) {
  if (platform !== 'darwin') return null;
  const profile = `${dockerHost || ''} ${dockerError || ''}`.match(
    /\/\.colima\/([^/\s]+)\/docker\.sock/,
  )?.[1];
  if (!profile) return null;
  return {
    command: 'colima',
    args: profile === 'default' ? ['start'] : ['start', '--profile', profile],
  };
}

function listenRelay(server, preferredPort) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (err) => {
      server.off('listening', onListening);
      rejectPromise(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(preferredPort || 0);
  });
}

/**
 * Makes sure a relay named `name` forwards to `targetPort`, and returns the port it listens on.
 * `relays` is the worker's Map of live relays; `persist` saves it.
 */
export async function ensureRelay(
  relays,
  persist,
  { name, targetPort, preferredPort, containerName },
) {
  const previous = relays.get(name);
  if (previous && previous.targetPort !== targetPort) {
    // The relay keeps its port, so the coordinator's address for the app stays valid. Only where
    // it forwards changes: Docker gives a container a new host port every time it starts.
    previous.targetPort = targetPort;
    for (const socket of previous.sockets) socket.destroy();
    persist();
  }
  if (previous && containerName && !previous.containerName) {
    previous.containerName = containerName;
    persist();
  }
  if (previous && (!preferredPort || previous.relayPort === preferredPort))
    return previous.relayPort;
  const sockets = new Set();
  const relay = { sockets, targetPort, containerName };
  const server = createServer((client) => {
    const target = connect({ host: '127.0.0.1', port: relay.targetPort });
    sockets.add(client);
    sockets.add(target);
    client.pipe(target);
    target.pipe(client);
    const close = () => {
      sockets.delete(client);
      sockets.delete(target);
      client.destroy();
      target.destroy();
    };
    client.on('close', close);
    target.on('close', close);
    client.on('error', close);
    target.on('error', close);
  });
  let relayPort;
  try {
    relayPort = await listenRelay(server, preferredPort);
  } catch (err) {
    if (!preferredPort) throw err;
    // The wanted port is busy. A relay that already works keeps its port until it frees up.
    if (previous) return previous.relayPort;
    relayPort = await listenRelay(server, 0);
  }
  if (previous) {
    for (const socket of previous.sockets) socket.destroy();
    await new Promise((resolvePromise) => previous.server.close(resolvePromise));
  }
  relays.set(
    name,
    Object.assign(relay, {
      server,
      relayPort,
      // The port the coordinator was told. Kept when it was busy, to take it back later.
      wantedPort: preferredPort || relayPort,
      containerName: containerName || previous?.containerName,
    }),
  );
  persist();
  return relayPort;
}
