import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DockerExecSession } from './docker.ts';

interface AgentExecState {
  id: string;
  nodeId: string;
  deploymentName: string;
  containerName?: string;
  cols: number;
  rows: number;
  claimed: boolean;
  closed: boolean;
  input: string[];
  resize: { cols: number; rows: number } | null;
  kill: boolean;
  updatedAt: number;
  session: DockerExecSession;
}

const sessions = new Map<string, AgentExecState>();

export function createAgentExecSession(
  nodeId: string,
  deploymentName: string,
  cols: number,
  rows: number,
  containerName?: string,
): DockerExecSession {
  const emitter = new EventEmitter() as DockerExecSession;
  const state: AgentExecState = {
    id: randomUUID(),
    nodeId,
    deploymentName,
    containerName,
    cols,
    rows,
    claimed: false,
    closed: false,
    input: [],
    resize: null,
    kill: false,
    updatedAt: Date.now(),
    session: emitter,
  };
  Object.defineProperty(emitter, 'closed', { get: () => state.closed });
  emitter.write = (data) => {
    if (state.closed) return false;
    state.input.push(Buffer.from(data).toString('base64'));
    state.updatedAt = Date.now();
    return true;
  };
  emitter.resize = (nextCols, nextRows) => {
    if (state.closed) return;
    state.resize = { cols: nextCols, rows: nextRows };
    state.updatedAt = Date.now();
  };
  emitter.kill = () => {
    if (state.closed) return;
    state.kill = true;
    state.updatedAt = Date.now();
  };
  sessions.set(state.id, state);
  return emitter;
}

export function claimAgentExecSession(nodeId: string) {
  const state = [...sessions.values()].find(
    (candidate) => candidate.nodeId === nodeId && !candidate.claimed && !candidate.closed,
  );
  if (!state) return null;
  state.claimed = true;
  state.updatedAt = Date.now();
  return {
    id: state.id,
    deploymentName: state.deploymentName,
    containerName: state.containerName,
    cols: state.cols,
    rows: state.rows,
  };
}

export function pollAgentExecSession(id: string, nodeId: string) {
  const state = sessions.get(id);
  if (!state || state.nodeId !== nodeId || state.closed) return null;
  const result = {
    input: state.input.splice(0),
    resize: state.resize,
    kill: state.kill,
  };
  state.resize = null;
  state.updatedAt = Date.now();
  return result;
}

export function writeAgentExecOutput(id: string, nodeId: string, output: string) {
  const state = sessions.get(id);
  if (!state || state.nodeId !== nodeId || state.closed) return false;
  state.updatedAt = Date.now();
  state.session.emit('data', Buffer.from(output, 'base64'));
  return true;
}

export function closeAgentExecSession(
  id: string,
  nodeId: string,
  info: { code: number | null; error?: string },
) {
  const state = sessions.get(id);
  if (!state || state.nodeId !== nodeId || state.closed) return false;
  state.closed = true;
  state.session.emit('exit', info);
  sessions.delete(id);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const state of sessions.values()) {
    if (state.updatedAt >= cutoff) continue;
    state.closed = true;
    state.session.emit('exit', { code: null, error: 'Remote terminal session expired' });
    sessions.delete(state.id);
  }
}, 60_000).unref();
