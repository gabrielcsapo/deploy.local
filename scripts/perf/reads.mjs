// Time the reads people wait on most, against the server in ~/.deployrc.
// Usage: node scripts/perf/reads.mjs [samples]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const rc = JSON.parse(readFileSync(`${homedir()}/.deployrc`, 'utf8'));
const headers = { 'x-deploy-username': rc.username, 'x-deploy-token': rc.token };
const base = rc.url.replace(/\/$/, '');
const samples = Number(process.argv[2] ?? 5);
const paths = [
  '/api/v2/self-update',
  '/api/v2/inbox',
  '/api/v2/live',
  '/api/v2/projects',
  '/api/v2/computers',
  '/api/v2/agents',
  '/api/v2/design/reviews',
  '/api/v2/events?after=0&waitMs=0',
  '/api/v2/events?after=latest',
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
