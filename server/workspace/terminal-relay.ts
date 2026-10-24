import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { terminalSize } from './terminal-pty.ts';

export type TerminalAssignment = {
  id: string;
  owner: string;
  workerId: string;
  instanceId: string;
  cols: number;
  rows: number;
};
type Session = TerminalAssignment & {
  browser: WebSocket;
  worker?: WebSocket;
  started: number;
  inputAt: number;
  ip: string;
  userAgent: string;
  pendingBytes: number;
};
export type TerminalComputer = {
  id: string;
  name: string;
  instanceId: string;
  enabled: boolean;
  online: boolean;
  supported: boolean;
  locallyDisabled: boolean;
};
export type TerminalAudit = {
  id: string;
  workerId: string;
  owner: string;
  ip: string;
  userAgent: string;
  startedAt: string;
  durationMs: number;
  code: number | null;
  reason: string;
};
const MAX_BUFFER = 1024 * 1024;
export class TerminalRelay {
  readonly sessions = new Map<string, Session>();
  private waiters = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval>;
  private deps: {
    computer(owner: string, workerId: string): TerminalComputer;
    audit(type: 'terminal.started' | 'terminal.ended', entry: TerminalAudit): void;
    now?: () => number;
    idleMs?: number;
    maxMs?: number;
  };
  constructor(deps: TerminalRelay['deps']) {
    this.deps = deps;
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private allowed(owner: string, workerId: string) {
    const computer = this.deps.computer(owner, workerId);
    if (!computer.supported) throw new Error(`Update deploy.local on ${computer.name}`);
    if (!computer.enabled) throw new Error('Terminal access is disabled');
    if (computer.locallyDisabled)
      throw new Error('Terminal access is disabled locally (DEPLOY_TERMINAL=0)');
    if (!computer.online) throw new Error('Computer is offline');
    return computer;
  }
  start(
    owner: string,
    workerId: string,
    browser: WebSocket,
    cols: number,
    rows: number,
    metadata: { ip: string; userAgent: string },
  ) {
    const computer = this.allowed(owner, workerId);
    terminalSize(cols, rows);
    if (
      [...this.sessions.values()].filter((s) => s.owner === owner && s.workerId === workerId)
        .length >= 4
    )
      throw new Error('This computer already has four terminal sessions');
    const session: Session = {
      id: randomUUID(),
      owner,
      workerId,
      instanceId: computer.instanceId,
      cols,
      rows,
      browser,
      started: this.now(),
      inputAt: this.now(),
      pendingBytes: 0,
      ...metadata,
    };
    this.sessions.set(session.id, session);
    this.audit('terminal.started', session, null, 'requested');
    browser.on('message', (data, binary) => this.browserMessage(session, data, binary));
    browser.once('close', () => this.end(session.id, null, 'Browser disconnected'));
    browser.on('error', () => this.end(session.id, null, 'Browser connection failed'));
    this.send(browser, { type: 'exec:start', id: session.id });
    this.waiters.get(`${owner}:${workerId}`)?.();
    return session.id;
  }
  assignments(owner: string, workerId: string, instanceId: string): TerminalAssignment[] {
    return [...this.sessions.values()]
      .filter(
        (s) =>
          s.owner === owner && s.workerId === workerId && s.instanceId === instanceId && !s.worker,
      )
      .map((session) => ({
        id: session.id,
        owner: session.owner,
        workerId: session.workerId,
        instanceId: session.instanceId,
        cols: session.cols,
        rows: session.rows,
      }));
  }
  async poll(owner: string, workerId: string, instanceId: string, signal: AbortSignal) {
    const key = `${owner}:${workerId}`;
    if (!this.assignments(owner, workerId, instanceId).length && !signal.aborted)
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          if (this.waiters.get(key) === finish) this.waiters.delete(key);
          resolve();
        };
        const timer = setTimeout(finish, 25000);
        this.waiters.get(key)?.();
        this.waiters.set(key, finish);
        signal.addEventListener('abort', finish, { once: true });
      });
    return this.assignments(owner, workerId, instanceId);
  }
  attachWorker(
    identity: { owner: string; workerId: string },
    assignment: TerminalAssignment,
    socket: WebSocket,
  ) {
    const session = this.sessions.get(assignment.id);
    if (
      !session ||
      session.worker ||
      session.owner !== identity.owner ||
      session.workerId !== identity.workerId ||
      assignment.owner !== session.owner ||
      assignment.workerId !== session.workerId ||
      assignment.instanceId !== session.instanceId
    )
      throw new Error('Terminal assignment mismatch');
    const computer = this.allowed(identity.owner, identity.workerId);
    if (computer.instanceId !== session.instanceId) throw new Error('Worker process changed');
    session.worker = socket;
    socket.on('message', (data, binary) => {
      if (!this.sessions.has(session.id)) return;
      try {
        if (binary) {
          const bytes = rawBuffer(data);
          session.pendingBytes += bytes.length;
          if (session.pendingBytes > MAX_BUFFER || session.browser.bufferedAmount > MAX_BUFFER)
            throw new Error('Terminal output consumer is too slow');
          session.browser.send(bytes, { binary: true });
        } else {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'exec:ready') this.send(session.browser, { type: 'exec:ready' });
          else if (msg.type === 'exec:exit')
            this.end(
              session.id,
              Number.isInteger(msg.code) ? msg.code : null,
              typeof msg.error === 'string' ? msg.error.slice(0, 500) : 'Shell exited',
            );
          else throw new Error('Invalid worker terminal message');
        }
      } catch (error) {
        this.end(session.id, null, (error as Error).message);
      }
    });
    socket.once('close', () => this.end(session.id, null, 'Worker disconnected'));
    socket.on('error', () => this.end(session.id, null, 'Worker connection failed'));
    this.send(socket, {
      type: 'exec:start',
      ...assignment,
      cols: session.cols,
      rows: session.rows,
    });
  }
  private browserMessage(session: Session, data: RawData, binary: boolean) {
    if (!this.sessions.has(session.id)) return;
    try {
      this.allowed(session.owner, session.workerId);
      if (binary) {
        const bytes = rawBuffer(data);
        if (bytes.length > 65536) throw new Error('Terminal input is too large');
        if (!session.worker) return;
        if (session.worker.bufferedAmount > MAX_BUFFER)
          throw new Error('Terminal input consumer is too slow');
        if (bytes.length) session.inputAt = this.now();
        session.worker.send(bytes, { binary: true });
      } else {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'exec:resize') {
          const size = terminalSize(msg.cols, msg.rows);
          Object.assign(session, size);
          if (session.worker) this.send(session.worker, { type: 'exec:resize', ...size });
        } else if (msg.type === 'exec:ack') {
          if (!Number.isInteger(msg.bytes) || msg.bytes < 1 || msg.bytes > session.pendingBytes)
            throw new Error('Invalid terminal acknowledgement');
          session.pendingBytes -= msg.bytes;
          if (session.worker) this.send(session.worker, { type: 'exec:ack', bytes: msg.bytes });
        } else if (msg.type === 'exec:end') this.end(session.id, null, 'Ended by owner');
        else throw new Error('Invalid terminal message');
      }
    } catch (error) {
      this.end(session.id, null, (error as Error).message);
    }
  }
  disable(owner: string, workerId: string) {
    for (const s of this.sessions.values())
      if (s.owner === owner && s.workerId === workerId)
        this.end(s.id, null, 'Terminal access disabled');
  }
  sweep() {
    for (const s of this.sessions.values()) {
      try {
        const computer = this.allowed(s.owner, s.workerId);
        if (computer.instanceId !== s.instanceId) throw new Error('Worker process changed');
        if (this.now() - s.inputAt >= (this.deps.idleMs ?? 30 * 60_000))
          throw new Error('Ended after 30 minutes without input');
        if (this.now() - s.started >= (this.deps.maxMs ?? 12 * 60 * 60_000))
          throw new Error('Maximum session length reached');
        if (!s.worker && this.now() - s.started > 30000) throw new Error('Worker did not connect');
      } catch (error) {
        this.end(s.id, null, (error as Error).message);
      }
    }
  }
  end(id: string, code: number | null, reason: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.audit('terminal.ended', s, code, reason);
    for (const socket of [s.browser, s.worker])
      if (socket) {
        this.send(socket, { type: 'exec:exit', code, error: reason });
        socket.close(1000);
        const timer = setTimeout(() => socket.terminate(), 1000);
        timer.unref();
      }
  }
  private audit(
    type: 'terminal.started' | 'terminal.ended',
    s: Session,
    code: number | null,
    reason: string,
  ) {
    this.deps.audit(type, {
      id: s.id,
      workerId: s.workerId,
      owner: s.owner,
      ip: s.ip,
      userAgent: s.userAgent,
      startedAt: new Date(s.started).toISOString(),
      durationMs: this.now() - s.started,
      code,
      reason,
    });
  }
  private send(socket: WebSocket, message: unknown) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  dispose() {
    clearInterval(this.timer);
    for (const id of this.sessions.keys()) this.end(id, null, 'Coordinator stopped');
    for (const wake of this.waiters.values()) wake();
  }
}
export function rawBuffer(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
}
