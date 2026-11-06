// Measure what a page loads before anything else, against the server in ~/.deployrc.
// Usage: node scripts/perf/first-load.mjs [path ...]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';

const rc = JSON.parse(readFileSync(`${homedir()}/.deployrc`, 'utf8'));
const headers = { 'x-deploy-username': rc.username, 'x-deploy-token': rc.token };
const base = rc.url.replace(/\/$/, '');
const pages = process.argv.slice(2);
if (!pages.length) pages.push('/dashboard', '/dashboard/tasks', '/dashboard/design');

for (const page of pages) {
  const html = await (await fetch(base + page, { headers })).text();
  const urls = new Set(
    [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]),
  );
  const totals = { js: { files: 0, raw: 0, gzip: 0 }, css: { files: 0, raw: 0, gzip: 0 } };
  const largest = [];
  for (const url of urls) {
    const body = Buffer.from(await (await fetch(new URL(url, base))).arrayBuffer());
    const total = url.endsWith('.css') ? totals.css : totals.js;
    total.files += 1;
    total.raw += body.length;
    total.gzip += gzipSync(body).length;
    largest.push([body.length, url.split('/').pop()]);
  }
  const line = ({ files, raw, gzip }) => `${files} files, ${raw >> 10} KB (${gzip >> 10} KB gzip)`;
  console.log(
    `${page}: HTML ${html.length >> 10} KB; CSS ${line(totals.css)}; JS ${line(totals.js)}`,
  );
  for (const [size, name] of largest.sort((a, b) => b[0] - a[0]).slice(0, 5))
    console.log(`  ${String(size >> 10).padStart(6)} KB  ${name}`);
}
