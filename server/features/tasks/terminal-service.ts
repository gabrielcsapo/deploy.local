import { workerAvailable } from '../../kernel/computers/policy.ts';
import {
  createShellMessage,
  shellEnded,
  shellOutput,
  setShellHidden,
} from '../../workspace/shell-commands.ts';
import { db, get, list, save, event } from '../../workspace/store.ts';
import { TerminalRelay, type TerminalComputer } from './terminal-relay.ts';
export function terminalComputer(owner: string, workerId: string): TerminalComputer {
  const worker = get('worker', owner, workerId);
  if (worker.revokedAt) throw new Error('Computer was revoked');
  const permission = list('terminal-permission', owner).find((p) => p.id === workerId);
  return {
    id: workerId,
    name: worker.name,
    instanceId: worker.instanceId,
    enabled: permission?.enabled === true && workerAvailable(owner, workerId),
    online: Date.now() - Date.parse(worker.heartbeat) < 15000,
    supported: worker.capabilities?.includes('terminal') === true,
    taskSupported: worker.capabilities?.includes('task-terminal') === true,
    locallyDisabled: worker.terminalDisabled === true,
  };
}
export const terminalRelay = new TerminalRelay({
  computer: terminalComputer,
  task: terminalTask,
  output: shellOutput,
  audit: (type, entry) => {
    event(entry.owner, `computer:${entry.workerId}`, null, type, entry);
    if (entry.taskId) event(entry.owner, entry.taskId, null, type, entry);
    if (type === 'terminal.ended') shellEnded(entry);
  },
});
export function startTerminalRelay() {
  terminalRelay.startSweep();
}
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

export function terminalTask(owner: string, workerId: string, taskId: string) {
  const task = get('task', owner, taskId);
  if (task.workerId !== workerId) throw new Error('Task is assigned to another computer');
  if (task.pendingPlacement)
    throw new Error('Task is waiting for a computer with its required tools');
  return { workspaceGeneration: task.workspaceGeneration as string | undefined };
}
export function shellCommand(
  owner: string,
  taskId: string,
  input: any,
  metadata = { ip: '', userAgent: '' },
) {
  const task = get('task', owner, taskId);
  if (input.id) {
    const message = get('message', owner, input.id);
    if (message.taskId !== taskId || !message.shell) throw new Error('Command not found');
    if (typeof input.hidden === 'boolean')
      return setShellHidden(owner, taskId, input.id, input.hidden);
    if (input.stop === true) {
      terminalRelay.end(input.id, null, 'Stopped by owner');
      return get('message', owner, input.id);
    }
    throw new Error('Command action required');
  }
  if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 16000)
    throw new Error('Command required (maximum 16000 characters)');
  const id = terminalRelay.start(owner, task.workerId, undefined, 80, 24, {
    ...metadata,
    taskId,
    command: input.command,
  });
  return createShellMessage(owner, taskId, id, input.command, task.workerId);
}

/** A coordinator restart closes worker sockets; never leave its persisted cards running. */
export function recoverShellCommands(owner: string, taskId: string) {
  for (const message of list('message', owner)) {
    if (
      message.taskId !== taskId ||
      message.shell?.status !== 'running' ||
      terminalRelay.sessions.has(message.id)
    )
      continue;
    const entry = {
      id: message.id,
      taskId,
      command: message.shell.command,
      owner,
      workerId: message.shell.workerId,
      ip: '',
      userAgent: '',
      startedAt: message.shell.startedAt,
      durationMs: Date.now() - Date.parse(message.shell.startedAt),
      code: null,
      reason: 'Coordinator restarted; command connection was lost',
    };
    shellEnded(entry);
    event(owner, taskId, null, 'terminal.ended', entry);
    event(owner, `computer:${entry.workerId}`, null, 'terminal.ended', entry);
  }
}
