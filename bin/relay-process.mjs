import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureRelay } from './agent-relays.mjs';

// Protocol 1 deliberately has no build version: an updated worker can use the supervisor's
// older relay process. Keep these messages and the relays.json array compatible across builds.
export const RELAY_PROTOCOL = 1;
export function relayState(relays) {
  return [...relays].map(([deploymentName, relay]) => ({
    deploymentName,
    targetPort: relay.targetPort,
    relayPort: relay.relayPort,
    wantedPort: relay.wantedPort,
    containerName: relay.containerName,
  }));
}
export function readRelayState(path) {
  let rows;
  try {
    rows = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const port = (n) => Number.isInteger(n) && n >= 0 && n <= 65535;
  if (!Array.isArray(rows)) throw new Error('Invalid relay state');
  return rows
    .filter(
      (row) =>
        typeof row?.deploymentName === 'string' && port(row.targetPort) && port(row.relayPort),
    )
    .map((row) => ({ ...row, wantedPort: port(row.wantedPort) ? row.wantedPort : row.relayPort }));
}
export function writeRelayState(path, relays) {
  mkdirSync(dirname(path), { recursive: true });
  // Only the worker writes this file. Rename keeps crashes and concurrent readers from seeing
  // half a desired set; the on-disk schema is unchanged for older workers.
  writeFileSync(`${path}.tmp`, JSON.stringify(relayState(relays), null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export async function closeRelay(relays, name) {
  const relay = relays.get(name);
  if (!relay) return;
  if (relay.server) {
    for (const socket of relay.sockets) socket.destroy();
    await new Promise((resolve) => relay.server.close(resolve));
  }
  relays.delete(name);
}

/** The only data path in the supervised relay child. No Docker, jobs or worker heartbeat. */
export async function runRelayProcess({ path = process.env.DEPLOY_RELAY_STATE, host } = {}) {
  if (!process.connected || !path) throw new Error('Relay process requires supervisor IPC');
  const relays = new Map();
  const apply = async () => {
    const rows = readRelayState(path);
    const errors = [];
    for (const row of rows) {
      try {
        // Recover the last advertised (possibly fallback) port first. If the wanted port is
        // still occupied, ensureRelay can keep this working listener rather than randomize it.
        if (!relays.has(row.deploymentName) && row.relayPort)
          await ensureRelay(relays, () => {}, {
            name: row.deploymentName,
            targetPort: row.targetPort,
            preferredPort: row.relayPort,
            containerName: row.containerName,
            host,
          });
        await ensureRelay(relays, () => {}, {
          name: row.deploymentName,
          targetPort: row.targetPort,
          preferredPort: row.wantedPort || row.relayPort,
          containerName: row.containerName,
          host,
        });
      } catch (error) {
        errors.push(`${row.deploymentName}: ${error.message}`);
      }
    }
    const desired = new Set(rows.map((row) => row.deploymentName));
    for (const name of relays.keys()) if (!desired.has(name)) await closeRelay(relays, name);
    return { relays: relayState(relays), errors };
  };
  const send = (message) => {
    if (process.connected) process.send(message, () => {});
  };
  process.once('disconnect', () => process.exit(0));
  let queue = Promise.resolve();
  process.on('message', (message) => {
    if (message?.type !== 'relay-sync' || message.protocol !== RELAY_PROTOCOL) return;
    queue = queue.then(async () => {
      try {
        send({ type: 'relay-result', id: message.id, ...(await apply()) });
      } catch (error) {
        send({ type: 'relay-result', id: message.id, error: error.message });
      }
    });
  });
  // Restore the whole file before the worker starts. No incremental restore writes can erase
  // another relay, including when the worker is dead while this process is recovering.
  const state = await apply();
  send({ type: 'relay-ready', protocol: RELAY_PROTOCOL, ...state });
}
