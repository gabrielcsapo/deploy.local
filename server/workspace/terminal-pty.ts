import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

// Kept inline so the bundled worker/AppImage needs no sidecar or native Node module.
const helper = String.raw`
import os, sys, pty, signal, select, json, base64, struct, fcntl, termios, subprocess, ctypes, time
pid, master = pty.fork()
if pid == 0:
    os.chdir(os.path.expanduser('~'))
    os.execv(sys.argv[1], [sys.argv[1], '-l'])
def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    try: os.killpg(os.tcgetpgrp(master), signal.SIGWINCH)
    except OSError: pass
def descendants(parent):
    if sys.platform == 'darwin':
        lib = ctypes.CDLL('/usr/lib/libproc.dylib')
        children = (ctypes.c_int * 65536)()
        count = lib.proc_listchildpids(parent, children, ctypes.sizeof(children))
        direct = list(children)[:max(0, count)]
        return direct + [child for p in direct for child in descendants(p)]
    pairs = [list(map(int, line.split())) for line in subprocess.check_output(['ps','-axo','pid=,ppid=']).decode().splitlines()]
    children = {parent}
    for _ in range(len(pairs)):
        found = {p for p, ppid in pairs if ppid in children}
        if found <= children: break
        children |= found
    return list(children - {parent})
def cleanup():
    try:
        for p in reversed(descendants(pid)):
            try: os.kill(p, signal.SIGKILL)
            except OSError: pass
        # Let the shell reap background jobs before terminating the shell itself.
        time.sleep(0.05)
    except Exception: pass
    try:
        foreground = os.tcgetpgrp(master)
        if foreground > 1 and foreground != os.getpgrp(): os.killpg(foreground, signal.SIGKILL)
    except OSError: pass
    try: os.killpg(pid, signal.SIGKILL)
    except OSError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
resize(int(sys.argv[2]), int(sys.argv[3]))
buffer = b''
status = 0
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [])
        if master in ready:
            try: data = os.read(master, 16384)
            except OSError: break
            if not data: break
            sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
        if 0 in ready:
            data = os.read(0, 65536)
            if not data: sys.exit(0)
            buffer += data
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                msg = json.loads(line)
                if msg['type'] == 'close': sys.exit(0)
                if msg['type'] == 'resize': resize(msg['cols'], msg['rows'])
                if msg['type'] == 'input':
                    data = base64.b64decode(msg['data'])
                    while data:
                        n = os.write(master, data); data = data[n:]
    _, status = os.waitpid(pid, 0)
finally:
    cleanup()
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;
export function terminalSize(cols: unknown, rows: unknown) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    Number(cols) < 2 ||
    Number(cols) > 500 ||
    Number(rows) < 1 ||
    Number(rows) > 300
  )
    throw new Error('Invalid terminal dimensions');
  return { cols: Number(cols), rows: Number(rows) };
}
export function createTerminalPty(
  cols = 80,
  rows = 24,
  options: { shell?: string; python?: boolean } = {},
) {
  terminalSize(cols, rows);
  const shell =
    options.shell || [process.env.SHELL, '/bin/bash', '/bin/sh'].find((s) => s && existsSync(s))!;
  const python =
    options.python ??
    spawnSync('python3', ['--version'], { timeout: 3000, stdio: 'ignore' }).status === 0;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  // macOS script rejects Node's socket-backed stdin. A small shell pipeline gives
  // it an anonymous POSIX pipe. No terminal contents are written to disk.
  const directory = !python ? mkdtempSync(join(tmpdir(), 'deploy-terminal-')) : undefined;
  const fallbackCommand = directory
    ? `stty cols ${cols} rows ${rows}; tty > ${quote(join(directory, 'tty'))}; echo $$ > ${quote(join(directory, 'pid'))}; exec ${quote(shell)} -l`
    : '';
  const child = spawn(
    python ? 'python3' : process.platform === 'darwin' ? '/bin/sh' : 'script',
    python
      ? ['-u', '-c', helper, shell, String(cols), String(rows)]
      : process.platform === 'darwin'
        ? [
            '-c',
            `${quote('/bin/sh')} -c ${quote(`echo $$ > ${quote(join(directory!, 'pump'))}; exec cat`)} | { script -q /dev/null /bin/sh -c ${quote(fallbackCommand)}; terminal_status=$?; read terminal_pump < ${quote(join(directory!, 'pump'))}; kill "$terminal_pump" 2>/dev/null; exit "$terminal_status"; }`,
          ]
        : ['-qefc', fallbackCommand, '/dev/null'],
    {
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const input = child.stdin!;
  const output = child.stdout!;
  const session = new EventEmitter() as EventEmitter & {
    write(data: Buffer): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    pause(): void;
    resume(): void;
    pid: number | undefined;
  };
  let ended = false;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const control = (msg: unknown) => input.write(JSON.stringify(msg) + '\n');
  session.pid = child.pid;
  session.write = (data) => {
    if (ended) return;
    if (input.writableLength > 1024 * 1024) return session.kill();
    if (python) control({ type: 'input', data: data.toString('base64') });
    else input.write(data);
  };
  session.resize = (c, r) => {
    terminalSize(c, r);
    if (python) control({ type: 'resize', cols: c, rows: r });
    else {
      try {
        const tty = readFileSync(join(directory!, 'tty'), 'utf8').trim();
        if (/^\/dev\/(ttys[0-9]+|pts\/[0-9]+)$/.test(tty))
          spawnSync(
            'stty',
            [
              process.platform === 'darwin' ? '-f' : '-F',
              tty,
              'cols',
              String(c),
              'rows',
              String(r),
            ],
            { timeout: 1000, stdio: 'ignore' },
          );
      } catch {
        /* The fallback has not published its slave yet. */
      }
    }
  };
  session.pause = () => output.pause();
  session.resume = () => output.resume();
  session.kill = () => {
    if (ended || stopping) return;
    stopping = true;
    if (python) child.kill('SIGTERM');
    else {
      // script's shell has its own session; kill descendants before its parent.
      const processes = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout || '';
      const pairs = processes
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([child.pid!]);
      for (let n = 0; n < pairs.length; n++)
        for (const [pid, parent] of pairs) if (descendants.has(parent)) descendants.add(pid);
      try {
        const shellPid = Number(readFileSync(join(directory!, 'pid'), 'utf8').trim());
        if (Number.isInteger(shellPid) && shellPid > 1) {
          spawnSync('pkill', ['-KILL', '-P', String(shellPid)], { timeout: 1000, stdio: 'ignore' });
          try {
            process.kill(-shellPid, 'SIGKILL');
          } catch {}
        }
      } catch {}
      for (const pid of [...descendants].reverse())
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    }, 1000);
    killTimer.unref();
  };
  output.on('data', (data) => session.emit('data', data));
  child.stderr!.on('data', (data) => session.emit('data', data));
  input.on('error', () => {});
  child.on('error', (error) => session.emit('exit', { code: null, error: error.message }));
  child.on('close', (code, signal) => {
    ended = true;
    clearTimeout(killTimer);
    if (directory) rmSync(directory, { recursive: true, force: true });
    session.emit('exit', { code, signal });
  });
  return session;
}
