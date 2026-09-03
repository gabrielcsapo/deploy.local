import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const repoDir = resolve(import.meta.dirname, '..');
const dataDir = process.env.DEPLOY_DATA_DIR || resolve(repoDir, '.deploy-data');
const markerFile = resolve(dataDir, 'dev-ui.json');
const pendingMarkerFile = `${markerFile}.${process.pid}.tmp`;
const port = Number(process.env.VITE_PORT || '5173');

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  console.error(`[dev-ui] invalid VITE_PORT: ${process.env.VITE_PORT}`);
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
writeFileSync(
  pendingMarkerFile,
  `${JSON.stringify({ origin: `http://127.0.0.1:${port}`, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  { mode: 0o600 },
);
renameSync(pendingMarkerFile, markerFile);

const child = spawn(
  'pnpm',
  ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: repoDir,
    env: { ...process.env, VITE_PORT: String(port) },
    stdio: 'inherit',
  },
);

let stopping = false;
function cleanup() {
  try {
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    if (marker.pid === process.pid) rmSync(markerFile, { force: true });
  } catch {
    // Another dev UI may have replaced our marker.
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.once('error', (error) => {
  cleanup();
  console.error(`[dev-ui] could not start Vite: ${error.message}`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

console.log(`[dev-ui] https://deploy.local will use Vite on 127.0.0.1:${port}`);
