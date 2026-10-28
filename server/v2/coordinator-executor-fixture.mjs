// Isolated fake supervisor used only by coordinator-executor.test.ts.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CoordinatorExecutor, serveCoordinatorExecutor } from './coordinator-executor.ts';
const [root, original] = process.argv.slice(2);
let child;
async function stop() {
  if (!child) return;
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await stopped;
  child = null;
}
const executor = new CoordinatorExecutor({
  root,
  entry: original,
  switchBuild: async (entry, version = 'old') => {
    await stop();
    child = spawn(process.execPath, [entry], {
      env: { ...process.env, DEPLOY_DATA_DIR: root, DEPLOY_COORDINATOR_VERSION: version },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const current = child;
    let exited = false,
      ready = false;
    current.once('exit', () => {
      exited = true;
      if (child === current) child = null;
    });
    current.on('message', (message) => {
      if (message?.ready === version) ready = true;
    });
    writeFileSync(join(root, 'running.json'), JSON.stringify({ pid: current.pid, version, entry }));
    for (let i = 0; i < 100 && !ready && !exited; i++) await delay(10);
    if (!ready || exited) throw new Error('Fake coordinator failed readiness');
    await delay(150);
    if (exited) throw new Error('Fake coordinator failed sustained startup');
  },
});
await executor.recover();
await executor.switchBuild(executor.currentEntry, executor.currentVersion);
const server = await serveCoordinatorExecutor(executor);
process.send({ ready: true });
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    server.close();
    await stop();
    process.exit(0);
  });
