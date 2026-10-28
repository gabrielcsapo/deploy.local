import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';

test(
  'supervisor starts each service once and restarts only the failed child',
  { timeout: 15000 },
  async () => {
    // Short paths also fit the macOS Unix socket path limit.
    const root = await mkdtemp('/tmp/deploy-supervisor-');
    await copyFile(new URL('./supervisor.ts', import.meta.url), join(root, 'supervisor.ts'));
    await mkdir(join(root, 'v2'));
    await copyFile(
      new URL('./v2/coordinator-executor.ts', import.meta.url),
      join(root, 'v2/coordinator-executor.ts'),
    );
    for (const entry of [
      'server',
      'edge',
      'workspace-repository-worker',
      'workspace-pipeline-worker',
    ]) {
      await writeFile(join(root, `${entry}.js`), 'setInterval(() => {}, 1000);');
    }
    const child = spawn(process.execPath, [join(root, 'supervisor.ts')], {
      env: { ...process.env, DEPLOY_DATA_DIR: root },
      stdio: 'ignore',
    });
    const exited = once(child, 'exit');
    let socket: ReturnType<typeof connect> | undefined;
    const states: any[] = [];
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Supervisor state timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      await waitFor(() => {
        if (socket) return true;
        const attempt = connect(join(root, 'supervisor.sock'));
        attempt.once('error', () => attempt.destroy());
        attempt.once('connect', () => {
          if (socket) return attempt.destroy();
          socket = attempt;
          let buffer = '';
          attempt.on('data', (chunk) => {
            buffer += chunk.toString();
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              states.push(JSON.parse(buffer.slice(0, end)));
              buffer = buffer.slice(end + 1);
            }
          });
        });
        return false;
      });
      await waitFor(() => states.some((state) => state.children?.every((entry: any) => entry.pid)));
      const initial = states.at(-1).children;
      assert.deepEqual(initial.map((entry: any) => entry.name).sort(), [
        'control',
        'edge',
        'pipelines',
        'repositories',
      ]);
      const repository = initial.find((entry: any) => entry.name === 'repositories');
      process.kill(repository.pid, 'SIGKILL');
      await waitFor(() =>
        states.some((state) =>
          state.children?.some(
            (entry: any) =>
              entry.name === 'repositories' && entry.pid && entry.pid !== repository.pid,
          ),
        ),
      );
      const restarted = states.at(-1).children;
      for (const entry of initial.filter((candidate: any) => candidate.name !== 'repositories')) {
        assert.equal(
          restarted.find((candidate: any) => candidate.name === entry.name).pid,
          entry.pid,
        );
      }
    } finally {
      socket?.destroy();
      child.kill('SIGTERM');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);
