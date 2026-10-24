import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Only the worker's configured root and an opaque task id determine the directory. */
export function taskShellDirectory(root: string, taskId?: string) {
  if (!taskId) return { cwd: homedir(), notice: '' };
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error('Invalid task id');
  const cwd = resolve(root, 'tasks', taskId);
  try {
    if (statSync(cwd).isDirectory()) return { cwd, notice: '' };
  } catch {}
  return { cwd: homedir(), notice: 'Task folder does not exist yet; opened in home directory.' };
}

/** A separate process group, closed stdin and pipes: never an agent process or PTY. */
export function createShellCommand(command: string, cwd: string, timeoutMs = 600000) {
  const session = new EventEmitter();
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let finished = false;
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  };
  const timer = setTimeout(kill, timeoutMs);
  timer.unref();
  const finish = (code: number | null, error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    kill();
    session.emit('exit', { code, error });
  };
  child.stdout.on('data', (data) => session.emit('data', data));
  child.stderr.on('data', (data) => session.emit('data', data));
  child.once('error', (error) => finish(null, error.message));
  child.once('exit', (code) => {
    kill();
    if (code === null) finish(null, 'Command stopped or timed out');
  });
  child.once('close', (code) => finish(code));
  return Object.assign(session, {
    pid: child.pid,
    kill,
    pause: () => {
      child.stdout.pause();
      child.stderr.pause();
    },
    resume: () => {
      child.stdout.resume();
      child.stderr.resume();
    },
    write: (_data: Buffer) => {},
    resize: (_cols: number, _rows: number) => {},
  });
}
