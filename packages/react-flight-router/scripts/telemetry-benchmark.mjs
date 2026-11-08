// Run after starting the baseline on 5300, telemetry off on 5301, and telemetry on
// on 5302 (RFR_TELEMETRY_URL=http://127.0.0.1:5303). All should serve the same
// example build and disable debug and onRequestComplete. This script supplies a
// local fake collector on 5303; it does not contact a production host.
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
import { request, Agent, createServer } from 'node:http';
const collector = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(204);
    res.end();
  });
});
await new Promise((resolve) => collector.listen(5303, '127.0.0.1', resolve));
const agent = new Agent({ keepAlive: true });
function sample(port, encoding = 'identity') {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    request(
      { host: '127.0.0.1', port, path: '/', agent, headers: { 'accept-encoding': encoding } },
      (res) => {
        let first,
          bytes = 0;
        res.on('data', (chunk) => {
          first ??= performance.now() - start;
          bytes += chunk.length;
        });
        res.on('end', () =>
          resolve({
            ttfb: first,
            total: performance.now() - start,
            bytes,
            encoding: res.headers['content-encoding'] ?? 'identity',
          }),
        );
      },
    )
      .on('error', reject)
      .end();
  });
}
const median = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];
for (let i = 0; i < 100; i++) for (const port of [5300, 5301, 5302]) await sample(port);
const results = new Map([5300, 5301, 5302].map((port) => [port, []]));
for (let round = 0; round < 9; round++) {
  const ports = round % 2 ? [5302, 5301, 5300] : [5300, 5301, 5302];
  for (const port of ports) {
    const samples = [];
    for (let i = 0; i < 200; i++) samples.push(await sample(port));
    results.get(port).push(median(samples.map((x) => x.total)));
  }
}
console.log('Request wall ms, identity (9 interleaved rounds x 200 requests, after 100 warmup):');
for (const [port, values] of results)
  console.log(port, JSON.stringify({ median: median(values), rounds: values }));
console.log('HTML compression (100 samples):');
for (const [port, encoding] of [
  [5300, 'gzip, br'],
  [5301, 'gzip'],
  [5301, 'br'],
]) {
  const samples = [];
  for (let i = 0; i < 100; i++) samples.push(await sample(port, encoding));
  console.log(
    port,
    encoding,
    JSON.stringify({
      bytes: median(samples.map((x) => x.bytes)),
      ttfb: median(samples.map((x) => x.ttfb)),
      total: median(samples.map((x) => x.total)),
      encoding: samples[0].encoding,
    }),
  );
}
agent.destroy();
collector.close();
