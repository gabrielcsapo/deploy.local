import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createTerminalPty } from './terminal-pty.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.ok(check(), 'Timed out waiting for PTY');
}
test(
  'PTY is a real tty, resizes, echoes Unicode, and propagates exit status',
  { timeout: 10000 },
  async () => {
    const pty = createTerminalPty(80, 24, { shell: '/bin/bash' });
    let output = '';
    pty.on('data', (data) => {
      output += data.toString();
    });
    try {
      pty.write(Buffer.from("tty; printf '\\120\\124\\131_READY\\n'\n"));
      await until(() => output.includes('PTY_READY') && /\/dev\/(ttys|pts\/)/.test(output));
      pty.resize(101, 37);
      pty.write(Buffer.from("stty size; printf '\\125\\116\\111:🌍\\n'\n"));
      await until(() => output.includes('37 101') && output.includes('UNI:🌍'));
      const exited = once(pty, 'exit');
      pty.write(Buffer.from('exit 23\n'));
      assert.equal((await exited)[0].code, 23);
    } finally {
      pty.kill();
    }
  },
);
test(
  'closing kills the shell and its separate background job group',
  { timeout: 10000 },
  async () => {
    const pty = createTerminalPty(80, 24, { shell: '/bin/bash' });
    let output = '';
    pty.on('data', (data) => {
      output += data.toString();
    });
    try {
      pty.write(Buffer.from("sleep 600 & printf '\\112\\117\\102:%s\\n' $!\n"));
      await until(() => /JOB:(\d+)/.test(output));
      const pid = Number(output.match(/JOB:(\d+)/)![1]);
      process.kill(pid, 0);
      const exited = once(pty, 'exit');
      pty.kill();
      await exited;
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      pty.kill();
    }
  },
);
test('script fallback supplies a real tty and input', { timeout: 10000 }, async () => {
  const pty = createTerminalPty(80, 24, { shell: '/bin/bash', python: false });
  let output = '';
  pty.on('data', (data) => {
    output += data.toString();
  });
  try {
    pty.write(Buffer.from("tty; printf '\\106\\101\\114\\114BACK\\n'\n"));
    await until(() => output.includes('FALLBACK') && /\/dev\/(ttys|pts\/)/.test(output));
    pty.resize(95, 33);
    pty.write(Buffer.from('stty size\n'));
    await until(() => output.includes('33 95'));
    const exited = once(pty, 'exit');
    pty.write(Buffer.from('exit 17\n'));
    assert.equal((await exited)[0].code, 17);
  } finally {
    pty.kill();
  }
});
