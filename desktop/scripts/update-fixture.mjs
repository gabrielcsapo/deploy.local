#!/usr/bin/env node
// Disposable update endpoint; all other requests go to an explicitly supplied local coordinator.
import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const [configPath, upstreamValue] = process.argv.slice(2);
if (!configPath || !upstreamValue)
  throw new Error(
    'Usage: node desktop/scripts/update-fixture.mjs <config.json> http://127.0.0.1:5190',
  );
const upstream = new URL(upstreamValue);
if (
  upstream.protocol !== 'http:' ||
  upstream.hostname !== '127.0.0.1' ||
  !['5190', '5191', '5192', '5193'].includes(upstream.port) ||
  upstream.pathname !== '/'
)
  throw new Error('Use a disposable coordinator on 127.0.0.1:5190–5193.');
const server = http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1:5194').pathname;
    if (path === '/desktop/version' || path === '/desktop') {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const manifest = JSON.parse(readFileSync(config.manifest, 'utf8'));
      if (config.mode === 'corrupt')
        for (const target of Object.values(manifest.targets)) target.sha256 = '0'.repeat(64);
      if (path === '/desktop/version') {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(manifest));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': statSync(config.archive).size,
      });
      const stream = createReadStream(config.archive, { highWaterMark: 128 * 1024 });
      response.on('close', () => stream.destroy());
      let chunks = 0;
      for await (const chunk of stream) {
        if (response.destroyed) break;
        response.write(chunk);
        if (config.mode === 'network' && ++chunks === 8) {
          response.destroy();
          break;
        }
        await setTimeout(config.mode === 'slow' ? 100 : 1);
      }
      response.end();
    } else {
      const proxy = http.request(
        new URL(request.url, upstream),
        {
          method: request.method,
          headers: { ...request.headers, host: upstream.host },
        },
        (result) => {
          response.writeHead(result.statusCode, result.headers);
          result.pipe(response);
        },
      );
      proxy.on('error', () => {
        response.writeHead(502);
        response.end('Fixture coordinator unavailable.');
      });
      request.pipe(proxy);
    }
  } catch (error) {
    if (!response.headersSent) response.writeHead(500);
    response.end(error.message);
  }
});
server.listen(5194, '127.0.0.1', () =>
  console.log('Disposable update fixture: http://127.0.0.1:5194'),
);
