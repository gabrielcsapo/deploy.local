import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const runner = new URL('./run-pair.mjs', import.meta.url).href;
function start(t, programs) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runProcesses } from ${JSON.stringify(runner)};
    process.exitCode = await runProcesses(${JSON.stringify(programs)});
  `,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill('SIGKILL'));
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, 'close');
  return { child, closed, output: () => ({ stdout, stderr }) };
}
const node = (name, code) => ({ name, command: process.execPath, args: ['-e', code] });
async function waitFor(child, text) {
  let output = '';
  for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
    output += chunk;
    if (output.includes(text)) return output;
  }
  throw new Error(`Process closed before ${text}: ${output}`);
}

test(
  'prefixes complete stdout/stderr lines and stops the peer on the first exit',
  { timeout: 10000 },
  async (t) => {
    const run = start(t, [
      node(
        'server',
        `process.stdout.write('hel'); process.stdout.write('lo\\nsecond\\n'); process.stderr.write('error'); process.stdin.once('data', () => process.exit(7));`,
      ),
      node(
        'client',
        `process.on('SIGTERM', () => { console.log('stopped'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`,
      ),
    ]);
    await waitFor(run.child, '[client] ready');
    run.child.stdin.write('exit');
    assert.deepEqual(await run.closed, [7, null]);
    assert.match(run.output().stdout, /\[server\] hello\n\[server\] second\n/);
    if (process.platform !== 'win32') assert.match(run.output().stdout, /\[client\] stopped\n/);
    assert.equal(run.output().stderr, '[server] error\n');
  },
);

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(
    `${signal} stops both processes`,
    { timeout: 10000, skip: process.platform === 'win32' },
    async (t) => {
      const run = start(
        t,
        ['server', 'client'].map((name) =>
          node(
            name,
            `
      process.on('${signal}', () => { console.log('stopped'); process.exit(0); });
      console.log('ready'); setInterval(() => {}, 1000);
    `,
          ),
        ),
      );
      let ready = '';
      for await (const chunk of run.child.stdout.iterator({ destroyOnReturn: false })) {
        ready += chunk;
        if (ready.includes('[server] ready') && ready.includes('[client] ready')) break;
      }
      run.child.kill(signal);
      assert.deepEqual(await run.closed, [code, null]);
      assert.match(run.output().stdout, /\[server\] stopped/);
      assert.match(run.output().stdout, /\[client\] stopped/);
    },
  );
}

test('a successful exit stops its peer and succeeds', { timeout: 10000 }, async (t) => {
  const run = start(t, [
    node('server', `process.stdin.once('data', () => process.exit(0));`),
    node('client', `console.log('ready'); setInterval(() => {}, 1000);`),
  ]);
  await waitFor(run.child, 'ready');
  run.child.stdin.write('exit');
  assert.deepEqual(await run.closed, [0, null]);
});

test(
  'a spawn failure reports the process name and terminates the peer',
  { timeout: 10000 },
  async (t) => {
    const run = start(t, [
      node('server', 'setInterval(() => {}, 1000);'),
      { name: 'client', command: '/nonexistent/deploy-pair-command', args: [] },
    ]);
    assert.deepEqual(await run.closed, [1, null]);
    assert.match(run.output().stderr, /\[client\].*ENOENT/);
  },
);

test(
  'termination reaches descendants and escalates for an uncooperative peer',
  { timeout: 10000, skip: process.platform === 'win32' },
  async (t) => {
    const run = start(t, [
      node('server', `process.stdin.once('data', () => process.exit(0));`),
      node(
        'client',
        `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('descendant:' + process.pid); setInterval(() => {}, 1000);"], {stdio: ['ignore','inherit','inherit']});
      process.on('SIGTERM', () => {});
      console.log('parent:' + process.pid);
      setInterval(() => {}, 1000);
    `,
      ),
    ]);
    await waitFor(run.child, 'descendant:');
    const pids = [...run.output().stdout.matchAll(/(?:parent|descendant):(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    t.after(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    });
    assert.equal(pids.length, 2);
    run.child.stdin.write('exit');
    assert.deepEqual(await run.closed, [0, null]);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);
