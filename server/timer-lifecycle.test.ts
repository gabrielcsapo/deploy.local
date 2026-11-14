import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const timers = [
  {
    module: './workspace/terminal-service.ts',
    start: 'startTerminalRelay',
    stop: 'terminalRelay.dispose',
    interval: 1000,
  },
  {
    module: './agent-exec.ts',
    start: 'startAgentExecExpiry',
    stop: 'stopAgentExecExpiry',
    interval: 60_000,
  },
  {
    module: './v2/project-removal.ts',
    start: 'startRemovedProjectCleanup',
    stop: 'stopRemovedProjectCleanup',
    interval: 3600_000,
  },
  { module: './v2/push.ts', start: 'startPush', stop: 'stopPush', interval: 1000 },
];

// getActiveResourcesInfo() and natural child exit both miss unref'd timers. async_hooks sees
// Timeout creation/destruction regardless of ref status. Exercise both kinds before importing
// so this probe cannot silently pass by using a detector that ignores unref'd intervals.
const probe = `
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { setImmediate as settle } from 'node:timers/promises';
const active = new Map();
const hook = createHook({
  init(id, type, trigger, resource) {
    if (type === 'Timeout') active.set(id, resource);
  },
  destroy(id) { active.delete(id); },
}).enable();
const ref = setInterval(() => {}, 60000);
const unref = setInterval(() => {}, 60000).unref();
assert.equal(active.size, 2);
assert.equal([...active.values()].filter(timer => timer.hasRef()).length, 1);
clearInterval(ref);
clearInterval(unref);
await settle();
assert.equal(active.size, 0);
const registrations = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (tick, delay, ...args) => {
  registrations.push(delay);
  return realSetInterval(tick, delay, ...args);
};
const module = await import(process.env.TIMER_MODULE);
await settle();
assert.equal(active.size, 0, 'import must leave no timer, including unref timers');
assert.deepEqual(registrations, [], 'import must not start even a subsequently cleared interval');
if (process.env.TIMER_START) {
  const start = module[process.env.TIMER_START];
  const stop = () => {
    if (process.env.TIMER_STOP === 'terminalRelay.dispose') module.terminalRelay.dispose();
    else module[process.env.TIMER_STOP]();
  };
  const interval = Number(process.env.TIMER_INTERVAL);
  start();
  start();
  assert.deepEqual(registrations, [interval], 'two starts must create one interval');
  assert.equal(active.size, 1);
  assert.equal([...active.values()][0].hasRef(), false, 'interval stays unreferenced');
  stop();
  stop();
  await settle();
  assert.equal(active.size, 0, 'shutdown clears the interval');
  start();
  start();
  assert.deepEqual(registrations, [interval, interval], 'restart also stays idempotent');
  stop();
  await settle();
  assert.equal(active.size, 0);
}
hook.disable();
`;

function childProbe(module: string, start = '', stop = '', interval = 0) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-timers-'));
  try {
    // A real temporary P-256 key ensures push import/start is tested with delivery enabled.
    // The isolated empty database has no devices; no APNs request can be made.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = join(root, 'apns.p8');
    writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        DEPLOY_DATA_DIR: root,
        DEPLOY_MDNS_ADDRESS: '127.0.0.1',
        DOCKER_HOST: 'unix:///nonexistent/docker.sock',
        DEPLOY_APNS_KEY_PATH: key,
        DEPLOY_APNS_KEY_ID: 'timer-test',
        DEPLOY_APNS_TEAM_ID: 'timer-test',
        DEPLOY_APNS_TOPIC: 'timer.test',
        TIMER_MODULE: new URL(module, import.meta.url).href,
        TIMER_START: start,
        TIMER_STOP: stop,
        TIMER_INTERVAL: String(interval),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const timer of timers) {
  test(`${timer.module}: inert import, idempotent start, unref and shutdown in a child`, () => {
    childProbe(timer.module, timer.start, timer.stop, timer.interval);
  });
}

test('importing the relay class and the composition root starts no timer', () => {
  childProbe('./workspace/terminal-relay.ts');
  childProbe('./boot.ts');
});

test('boot starts all four timers before other startup work, in dependency evaluation order', () => {
  const boot = readFileSync(new URL('./boot.ts', import.meta.url), 'utf8');
  const body = boot.slice(boot.indexOf('export function bootServer('));
  let previous = -1;
  for (const timer of timers) {
    assert.match(
      boot,
      new RegExp(`import \\{[^}]*\\b${timer.start}\\b[^}]*\\} from '${timer.module}'`),
    );
    assert.equal(boot.match(new RegExp(`\\b${timer.start}\\(\\)`, 'g'))?.length, 1);
    const at = body.indexOf(`${timer.start}();`);
    assert.ok(at > previous, `${timer.start} must follow its predecessors in bootServer`);
    assert.ok(at < body.indexOf('installCrashGuard();'));
    previous = at;
    // Both existing role shutdown paths must clear the timer.
    assert.equal(
      boot.match(new RegExp(`\\b${timer.stop.replace('.', '\\.')}\\(\\)`, 'g'))?.length,
      2,
    );
  }
});

test('preview explicitly owns its process-local relay before serving shell commands', () => {
  const preview = readFileSync(new URL('./workspace/preview.ts', import.meta.url), 'utf8');
  assert.match(
    preview,
    /import \{ startTerminalRelay, terminalRelay \} from '.\/terminal-service.ts'/,
  );
  assert.equal(preview.match(/\bstartTerminalRelay\(\)/g)?.length, 1);
  assert.ok(preview.indexOf('startTerminalRelay();') < preview.indexOf('createServer(async'));
  assert.match(preview, /process\.on\(signal,[^]*terminalRelay\.dispose\(\)/);
});
