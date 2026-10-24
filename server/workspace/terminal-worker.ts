import { taskShellDirectory, createShellCommand } from './task-shell.ts';
import { WebSocket } from 'ws';
import { createTerminalPty, terminalSize } from './terminal-pty.ts';
import { rawBuffer, type TerminalAssignment } from './terminal-relay.ts';

/** A session can only start from an assignment received over the authenticated poll. */
export function runWorkerTerminal(
  socket: WebSocket,
  assignment: TerminalAssignment,
  disabled = process.env.DEPLOY_TERMINAL === '0',
  root = process.env.DEPLOY_WORKER_ROOT || '.',
) {
  let pty: ReturnType<typeof createTerminalPty> | undefined;
  let pending = 0;
  let lastInput = Date.now();
  const started = Date.now();
  let lastPong = Date.now();
  const send = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const stop = () => {
    clearInterval(timer);
    pty?.kill();
    socket.close();
  };
  const timer = setInterval(() => {
    // Say why before closing, so the session history doesn't read as a dropped connection.
    const reason =
      process.env.DEPLOY_TERMINAL === '0'
        ? 'Terminal access is disabled on this computer'
        : Date.now() - lastInput >= 30 * 60_000
          ? 'Ended after 30 minutes without input'
          : Date.now() - started >= 12 * 60 * 60_000
            ? 'Maximum session length reached'
            : Date.now() - lastPong > 45000
              ? 'Coordinator stopped responding'
              : '';
    if (reason) {
      send({ type: 'exec:exit', code: null, error: reason });
      stop();
    } else if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, 15000);
  timer.unref();
  socket.on('pong', () => {
    lastPong = Date.now();
  });
  socket.once('close', stop);
  socket.on('error', stop);
  socket.on('message', (raw, binary) => {
    try {
      if (disabled || process.env.DEPLOY_TERMINAL === '0')
        throw new Error('Terminal disabled locally');
      if (binary) {
        if (!pty) throw new Error('Terminal not assigned');
        lastInput = Date.now();
        pty.write(rawBuffer(raw));
        return;
      }
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'exec:start') {
        if (
          pty ||
          msg.id !== assignment.id ||
          msg.owner !== assignment.owner ||
          msg.workerId !== assignment.workerId ||
          msg.instanceId !== assignment.instanceId ||
          msg.taskId !== assignment.taskId ||
          msg.command !== assignment.command
        )
          throw new Error('Terminal assignment mismatch');
        const { cols, rows } = terminalSize(msg.cols, msg.rows);
        const directory = taskShellDirectory(root, assignment.taskId);
        if (assignment.command && directory.notice) throw new Error(directory.notice);
        pty = assignment.command
          ? createShellCommand(assignment.command, directory.cwd)
          : createTerminalPty(cols, rows, { cwd: directory.cwd });
        pty.on('data', (data: Buffer) => {
          if (socket.readyState !== WebSocket.OPEN) return stop();
          pending += data.length;
          pty!.pause();
          if (pending > 1024 * 1024 || socket.bufferedAmount > 1024 * 1024) return stop();
          socket.send(data, { binary: true });
        });
        pty.once('exit', (info) => {
          send({ type: 'exec:exit', ...info });
          stop();
        });
        send({ type: 'exec:ready', notice: directory.notice });
      } else if (msg.type === 'exec:resize') pty?.resize(msg.cols, msg.rows);
      else if (msg.type === 'exec:ack') {
        if (!Number.isInteger(msg.bytes) || msg.bytes < 1 || msg.bytes > pending)
          throw new Error('Invalid output acknowledgement');
        pending -= msg.bytes;
        if (!pending) pty?.resume();
      } else if (msg.type === 'exec:exit') stop();
      else throw new Error('Invalid terminal control');
    } catch (error) {
      send({ type: 'exec:exit', code: null, error: (error as Error).message });
      stop();
    }
  });
  return stop;
}

export function startTerminalWorker(config: {
  root: string;
  origin: string;
  token: string;
  workerId: string;
  instanceId: string;
}) {
  const controller = new AbortController();
  const active = new Map<string, () => void>();
  const headers = { 'x-deploy-worker-id': config.workerId, 'x-deploy-worker-token': config.token };
  const loop = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(
          `${config.origin}/api/workspace/workers/${encodeURIComponent(config.workerId)}/terminals?instanceId=${encodeURIComponent(config.instanceId)}`,
          {
            headers,
            redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          },
        );
        if (!response.ok) throw new Error('Terminal poll failed');
        const assignments: TerminalAssignment[] = await response.json();
        for (const assignment of assignments) {
          if (
            assignment.workerId !== config.workerId ||
            assignment.instanceId !== config.instanceId ||
            !assignment.owner ||
            !assignment.id ||
            active.has(assignment.id) ||
            active.size >= 4
          )
            continue;
          const url = new URL('/ws/terminal/worker', config.origin);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(url, {
            headers,
            maxPayload: 65536,
            perMessageDeflate: false,
            handshakeTimeout: 5000,
          });
          const stop = runWorkerTerminal(
            ws,
            assignment,
            process.env.DEPLOY_TERMINAL === '0',
            config.root,
          );
          active.set(assignment.id, stop);
          ws.once('open', () => ws.send(JSON.stringify(assignment)));
          ws.once('close', () => active.delete(assignment.id));
        }
        // A poll can return an assignment whose socket is still connecting.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          timer.unref();
        });
      } catch {
        if (!controller.signal.aborted)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1000);
            timer.unref();
          });
      }
    }
  };
  void loop();
  return () => {
    controller.abort();
    for (const stop of active.values()) stop();
  };
}
