import { db, get, list, save, event } from './store.ts';
import { TerminalRelay, type TerminalComputer } from './terminal-relay.ts';
export function terminalComputer(owner: string, workerId: string): TerminalComputer {
  const worker = get('worker', owner, workerId);
  if (worker.revokedAt) throw new Error('Computer was revoked');
  const permission = list('terminal-permission', owner).find((p) => p.id === workerId);
  return {
    id: workerId,
    name: worker.name,
    instanceId: worker.instanceId,
    enabled: permission?.enabled === true,
    online: Date.now() - Date.parse(worker.heartbeat) < 15000,
    supported: worker.capabilities?.includes('terminal') === true,
    locallyDisabled: worker.terminalDisabled === true,
  };
}
export const terminalRelay = new TerminalRelay({
  computer: terminalComputer,
  audit: (type, entry) => event(entry.owner, `computer:${entry.workerId}`, null, type, entry),
});
export function setTerminalPermission(owner: string, workerId: string, enabled: boolean) {
  terminalComputer(owner, workerId);
  save('terminal-permission', owner, { id: workerId, enabled });
  if (!enabled) terminalRelay.disable(owner, workerId);
  event(owner, `computer:${workerId}`, null, 'terminal.permission', { workerId, owner, enabled });
  return terminalStatus(owner, workerId);
}
export function terminalStatus(owner: string, workerId: string) {
  const recent = db
    .prepare(
      "SELECT type,payload,createdAt FROM events WHERE owner=? AND taskId=? AND type IN ('terminal.started','terminal.ended') ORDER BY cursor DESC LIMIT 20",
    )
    .all(owner, `computer:${workerId}`) as { type: string; payload: string; createdAt: string }[];
  return {
    ...terminalComputer(owner, workerId),
    recent: recent.map((r) => ({ ...JSON.parse(r.payload), type: r.type, createdAt: r.createdAt })),
  };
}
