/** Loopback-only protocol/latency fixture. No database, TLS, multicast or real app data. */
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { Agent, createServer, get } from 'node:http';
import { performance } from 'node:perf_hooks';
const { default: multicastDns } = (await import(
  process.env.BENCH_MDNS_MODULE || '../packages/mdns/index.ts'
)) as typeof import('../packages/mdns/index.ts');
import { decodeName, encodeQuery } from '../packages/mdns/dns.ts';
import { createHotPathHandler } from '../server/edge/proxy.ts';

assert.equal(process.env.DEPLOY_MDNS_ADDRESS, '127.0.0.1');
const summary = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    medianMs: +values[Math.floor(values.length / 2)].toFixed(4),
    p99Ms: +values[Math.ceil(values.length * 0.99) - 1].toFixed(4),
  };
};
const mdns = multicastDns({ port: 5354, bind: '127.0.0.1', ip: '127.0.0.1', multicast: false });
await once(mdns, 'ready');
mdns.registerResponse('bench.local', '127.0.0.1');
let sequence = 0;
const dns = [];
for (const qu of [false, true]) {
  const client = dgram.createSocket('udp4');
  client.bind(5355, '127.0.0.1');
  await once(client, 'listening');
  for (const type of ['A', 'AAAA', 'ANY']) {
    const times: number[] = [];
    let timeouts = 0;
    let answerType = 0;
    const count = qu ? 100 : 20;
    for (let i = 0; i < count; i++) {
      const packet = encodeQuery({ id: ++sequence, questions: [{ name: 'bench.local', type }] });
      if (qu) packet.writeUInt16BE(0x8001, packet.length - 2);
      const start = performance.now();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.removeListener('message', receive);
          timeouts++;
          resolve();
        }, 100);
        function receive(response: Buffer) {
          if (response.readUInt16BE(0) !== sequence && !(qu && response.readUInt16BE(0) === 0))
            return;
          clearTimeout(timer);
          client.removeListener('message', receive);
          times.push(performance.now() - start);
          let offset = 12;
          for (let q = 0; q < response.readUInt16BE(4); q++)
            offset += decodeName(response, offset)[1] + 4;
          answerType = response.readUInt16BE(offset + decodeName(response, offset)[1]);
          resolve();
        }
        client.on('message', receive);
        client.send(packet, 5354, '127.0.0.1', (err) => {
          if (err) reject(err);
        });
      });
    }
    dns.push({ type, qu, count, timeouts, answerType, ...(times.length ? summary(times) : {}) });
  }
  client.close();
}
await new Promise<void>((resolve) => mdns.destroy(resolve));

let connections = 0;
const upstream = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2 });
  res.end('ok');
});
upstream.on('connection', () => connections++);
const route = { name: 'bench', port: 5357 };
const handler = createHotPathHandler({
  getRoute: () => route,
  logRequest: () => {},
  emitEvent: () => {},
});
const edge = createServer((req, res) => {
  if (!handler(req, res)) {
    res.statusCode = 404;
    res.end();
  }
});
upstream.listen(5357, '127.0.0.1');
edge.listen(5356, '127.0.0.1');
await Promise.all([once(upstream, 'listening'), once(edge, 'listening')]);
const http = [];
for (let trial = 1; trial <= 3; trial++) {
  const results: Record<string, ReturnType<typeof summary>> = {};
  for (const [label, port] of trial % 2
    ? ([
        ['direct', 5357],
        ['edge', 5356],
      ] as const)
    : ([
        ['edge', 5356],
        ['direct', 5357],
      ] as const)) {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const times: number[] = [];
    for (let i = 0; i < 1200; i++) {
      const start = performance.now();
      await new Promise<void>((resolve, reject) => {
        get(
          { host: '127.0.0.1', port, path: '/', headers: { host: 'bench.local' }, agent },
          (res) => {
            assert.equal(res.statusCode, 200);
            res.resume();
            res.on('end', resolve);
            res.on('error', reject);
          },
        ).on('error', reject);
      });
      if (i >= 200) times.push(performance.now() - start);
    }
    agent.destroy();
    results[label] = summary(times);
  }
  http.push({
    trial,
    ...results,
    medianOverheadMs: +(results.edge.medianMs - results.direct.medianMs).toFixed(4),
  });
}
await Promise.all([
  new Promise<void>((resolve) => edge.close(() => resolve())),
  new Promise<void>((resolve) => upstream.close(() => resolve())),
]);
console.log(
  JSON.stringify(
    {
      node: process.version,
      dns,
      http,
      upstreamConnections: connections,
      dnsSourcePort: 5355,
      methodology:
        '1000 sequential measured requests per path/trial after 200 warmups, 3 alternating-order trials, 2-byte response, HTTP/1.1 keep-alive, no TLS/DB/capture/log writes; DNS timeout 100ms',
    },
    null,
    2,
  ),
);
