import { randomUUID } from 'node:crypto';
import { ensureRelay } from './agent-relays.mjs';
import { RELAY_PROTOCOL, closeRelay, readRelayState, writeRelayState } from './relay-process.mjs';

export function relayRequest(channel = process, timeoutMs = 35_000) {
  return () =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (error, result) => {
        clearTimeout(timer);
        channel.off('message', receive);
        channel.off('disconnect', disconnected);
        if (error) reject(error);
        else resolve(result);
      };
      const receive = (message) => {
        if (message?.type === 'relay-result' && message.id === id) finish(null, message);
      };
      const disconnected = () => finish(new Error('Relay supervisor disconnected'));
      const timer = setTimeout(() => finish(new Error('Relay request timed out')), timeoutMs);
      channel.on('message', receive);
      channel.once('disconnect', disconnected);
      channel.send({ type: 'relay-sync', protocol: RELAY_PROTOCOL, id }, (error) => {
        if (error) finish(error);
      });
    });
}

/** Worker-owned decisions and durable state, with exactly one serialized mutation at a time. */
export function createRelayController({
  path,
  relays = new Map(),
  request = process.env.DEPLOY_RELAY_PROTOCOL === String(RELAY_PROTOCOL) && process.connected
    ? relayRequest()
    : null,
  host,
}) {
  let initialized = false;
  let remote = !!request;
  let queue = Promise.resolve();
  const persist = () => writeRelayState(path, relays);
  const serialized = (action) => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  async function localRestore() {
    const saved = [...relays];
    relays.clear();
    for (const [name, row] of saved) {
      try {
        await ensureRelay(relays, () => {}, {
          name,
          targetPort: row.targetPort,
          preferredPort: row.wantedPort || row.relayPort,
          containerName: row.containerName,
          host,
        });
      } catch (error) {
        // Match legacy startup: one unbindable relay must not prevent the remaining restores.
        console.error(`Unable to restore relay for ${name}: ${error.message}`);
      }
    }
    persist();
  }
  async function sync() {
    if (!remote) return;
    const result = await request();
    // Never infer ownership from a timeout. Only the supervisor can grant fallback after it
    // has reaped its relay child and disabled restarts for this worker's lifetime.
    if (result.unavailable) {
      remote = false;
      await localRestore();
      return;
    }
    if (result.error) throw new Error(result.error);
    for (const row of result.relays) {
      const { deploymentName, ...relay } = row;
      relays.set(deploymentName, relay);
    }
    persist();
    if (result.errors?.length) throw new Error(result.errors.join('; '));
  }
  async function initialize() {
    if (initialized) return;
    for (const { deploymentName, ...row } of readRelayState(path)) relays.set(deploymentName, row);
    if (remote) await sync();
    else await localRestore();
    initialized = true;
  }
  return {
    relays,
    restore: () => serialized(initialize),
    refresh: () =>
      serialized(async () => {
        await initialize();
        await sync();
      }),
    ensure: (name, targetPort, preferredPort, containerName) =>
      serialized(async () => {
        await initialize();
        if (!remote)
          return ensureRelay(relays, persist, {
            name,
            targetPort,
            preferredPort,
            containerName,
            host,
          });
        const previous = relays.get(name);
        relays.set(name, {
          targetPort,
          relayPort: previous?.relayPort || preferredPort || 0,
          wantedPort: preferredPort || previous?.wantedPort || previous?.relayPort || 0,
          containerName: containerName || previous?.containerName,
        });
        persist();
        await sync();
        return relays.get(name).relayPort;
      }),
    remove: (name) =>
      serialized(async () => {
        await initialize();
        await closeRelay(relays, name);
        persist();
        await sync();
      }),
  };
}
