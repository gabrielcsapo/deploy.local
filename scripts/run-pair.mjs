import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** Run a named process pair, stopping the whole group when either process exits. */
export async function runProcesses(programs) {
  const children = [];
  let stopping = false,
    exitCode = 0,
    force;
  const signalAll = (signal) => {
    for (const child of children) {
      if (!child.pid) continue;
      if (process.platform === 'win32') {
        // pnpm launches descendants: killing just its wrapper leaves the server running.
        if (child.exitCode === null && child.signalCode === null) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
            'error',
            () => child.kill(signal),
          );
        }
      } else {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
  };
  const stop = (code, signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    signalAll(signal);
    force = setTimeout(() => signalAll('SIGKILL'), 2000);
    force.unref();
  };
  const interrupt = () => stop(130, 'SIGINT');
  const terminate = () => stop(143);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await Promise.all(
      programs.map(
        ({ name, command, args }) =>
          new Promise((resolve) => {
            const child = spawn(command, args, {
              stdio: ['inherit', 'pipe', 'pipe'],
              detached: process.platform !== 'win32',
            });
            children.push(child);
            for (const [stream, destination] of [
              [child.stdout, process.stdout],
              [child.stderr, process.stderr],
            ]) {
              createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) =>
                destination.write(`[${name}] ${line}\n`),
              );
            }
            child.on('error', (error) => {
              process.stderr.write(`[${name}] ${error.message}\n`);
              stop(1);
            });
            child.on('exit', (code, signal) => stop(code ?? (signal === 'SIGINT' ? 130 : 1)));
            child.on('close', resolve);
          }),
      ),
    );
    return exitCode;
  } finally {
    clearTimeout(force);
    // Catch descendants that closed their output streams before the group leader exited.
    signalAll('SIGKILL');
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== 'dev' && mode !== 'preview')
    throw new Error('Usage: node scripts/run-pair.mjs dev|preview');
  // Use pnpm's JS entry point to avoid a shell wrapper (including pnpm.cmd on Windows).
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Run this script through pnpm run dev or pnpm run preview.');
  process.exitCode = await runProcesses([
    { name: 'server', command: process.execPath, args: [pnpm, 'run', 'server'] },
    {
      name: mode === 'dev' ? 'client' : 'preview',
      command: process.execPath,
      args: [pnpm, ...(mode === 'dev' ? ['run', 'client'] : ['exec', 'vite', 'preview'])],
    },
  ]);
}
