import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'deploy-desktop-suite-'));
try {
  await mkdir(join(directory, 'locks'));
  await mkdir(join(directory, 'bin'));
  await writeFile(join(directory, 'bin/docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const child = spawn('pnpm', ['test'], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
      DOCKER_HOST: `unix://${directory}/no-docker.sock`,
      DEPLOY_DATA_DIR: join(directory, 'data'),
      DEPLOY_DESKTOP_TEST_GUARD_DIR: join(directory, 'locks'),
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('test-guard.mjs', import.meta.url))}`,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
