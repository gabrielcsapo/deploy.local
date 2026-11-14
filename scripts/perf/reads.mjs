// Time the reads people wait on most, against the server in ~/.deployrc.
// Usage: node scripts/perf/reads.mjs [samples]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const rc = JSON.parse(readFileSync(`${homedir()}/.deployrc`, 'utf8'));
const headers = { 'x-deploy-username': rc.username, 'x-deploy-token': rc.token };
const base = rc.url.replace(/\/$/, '');
const samples = Number(process.argv[2] ?? 5);
const paths = [
  '/api/self-update',
  '/api/inbox',
  '/api/live',
  '/api/projects',
  '/api/computers',
  '/api/agents',
  '/api/design/reviews',
  '/api/activity-events?after=0&waitMs=0',
  '/api/activity-events?after=latest',
  '/api/deployments',
  '/api/nodes',
];

for (const path of paths) {
  const times = [];
  let status;
  let size = 0;
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    const response = await fetch(base + path, { headers });
    size = (await response.arrayBuffer()).byteLength;
    status = response.status;
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = Math.round(times[Math.floor(times.length / 2)]);
  const worst = Math.round(times.at(-1));
  console.log(
    `${path.padEnd(34)} ${status} ${String(size >> 10).padStart(5)} KB  median ${String(median).padStart(5)} ms  worst ${String(worst).padStart(5)} ms`,
  );
}
