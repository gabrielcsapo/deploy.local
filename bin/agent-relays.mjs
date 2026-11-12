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
  if (relay?.containerName) return relay.containerName;
  // A release receipt's key is not a container name. Older app relays used the container's name.
  if (typeof name !== 'string' || !name || name.startsWith('release-')) return null;
  return `deploy-sh-${name.toLowerCase()}`;
}

function containerAppName(row) {
  return row.label || row.containerName.replace(/^deploy-sh-/, '').replace(/-prev-\d+$/, '');
}

/** A failed, timed out or unreadable Docker listing is unknown, never an empty inventory. */
export function relayContainerRows(result) {
  if (result?.status !== 0 || result.timedOut || typeof result.stdout !== 'string') return null;
  try {
    const rows = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      rows.some(
        (row) =>
          !row ||
          typeof row.containerName !== 'string' ||
          !row.containerName ||
          typeof row.status !== 'string' ||
          !row.status ||
          typeof row.label !== 'string',
      )
    )
      return null;
    return rows;
  } catch {
    return null;
  }
}

/**
 * The place a container fills in its app: its name without the per-start id, so
 * `deploy-sh-forma-web-1-a75f027a` and `deploy-sh-forma-web-1-dd4662d9` are the same place and
 * `deploy-sh-forma-worker-1-…` is not. In an app of several components a running worker must not
 * count as the replacement of a stopped web container.
 */
function containerPlace(row) {
  const place = row.containerName.replace(/-prev-\d+$/, '').replace(/-[0-9a-f]{8}$/, '');
  return `${containerAppName(row)}\n${place}`;
}

/** Relays safe to retire from a successful `docker ps -a` snapshot in this repair pass. */
export function relayRemovals(relays, rows) {
  if (!Array.isArray(rows)) return [];
  const filled = new Set(
    rows
      .filter((row) => row.status === 'running' && row.containerName.startsWith('deploy-sh-'))
      .map(containerPlace),
  );
  return relays.filter((relay) => {
    const containerName = relayContainerName(relay.name, relay);
    if (!containerName) return false;
    const container = rows.find((row) => row.containerName === containerName);
    if (!container) return true;
    if (container.status === 'running') return false;
    return filled.has(containerPlace(container));
  });
}

/** How long a relay must stay removable before it is closed. */
export const RELAY_GRACE_MS = 60 * 60_000;

/**
 * A failed release starts its previous containers again, and the coordinator still routes to
 * their relay ports; a recreated container is missing for a moment. So a removable relay is
 * closed only after it has been removable on every pass for the grace period. `since` is kept
 * by the caller between passes and maps a relay's name to when it first became removable.
 */
export function relaysDueForRemoval(removals, since, now = Date.now(), graceMs = RELAY_GRACE_MS) {
  const names = new Set(removals.map((relay) => relay.name));
  for (const name of [...since.keys()]) if (!names.has(name)) since.delete(name);
  const due = [];
  for (const relay of removals) {
    if (!since.has(relay.name)) since.set(relay.name, now);
    else if (now - since.get(relay.name) >= graceMs) due.push(relay);
  }
  return due;
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
    const name = containerAppName(row);
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

function listenRelay(server, preferredPort, host) {
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
    server.listen(preferredPort || 0, host);
  });
}

/**
 * Makes sure a relay named `name` forwards to `targetPort`, and returns the port it listens on.
 * `relays` is the worker's Map of live relays; `persist` saves it.
 */
export async function ensureRelay(
  relays,
  persist,
  { name, targetPort, preferredPort, containerName, host },
) {
  const previous = relays.get(name);
  if (previous && previous.targetPort !== targetPort) {
    // The relay keeps its port, so the coordinator's address for the app stays valid. Only where
    // it forwards changes: Docker gives a container a new host port every time it starts.
    previous.targetPort = targetPort;
    // Established streams finish against their original target; new connections use this one.
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
    relayPort = await listenRelay(server, preferredPort, host);
  } catch (err) {
    if (!preferredPort) throw err;
    // The wanted port is busy. A relay that already works keeps its port until it frees up.
    if (previous) {
      if (previous.wantedPort !== preferredPort) {
        previous.wantedPort = preferredPort;
        persist();
      }
      return previous.relayPort;
    }
    relayPort = await listenRelay(server, 0, host);
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
