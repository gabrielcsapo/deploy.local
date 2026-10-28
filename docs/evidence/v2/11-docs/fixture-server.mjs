// Actual docs route components with client hydration. No coordinator or app API.
import { createServer } from 'node:http';
import { buildDocs } from '../../../../app/routes/docs/render-fixture.mjs';
const docs = await buildDocs();
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5180');
  if (url.pathname === '/docs-fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(docs.js);
  }
  if (url.pathname === '/docs-fixture.css') {
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(docs.css);
  }
  const page = docs.render(url.pathname.replace(/\/$/, ''));
  if (!page) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/docs-fixture.css"><style>body{margin:0}</style></head><body><header class="app-global-header">Legacy header must be hidden</header><div id="docs-root">${page}</div><footer>Legacy footer must be hidden</footer><script type="module" src="/docs-fixture.js"></script></body></html>`,
  );
});
server.listen(5180, '127.0.0.1', () => console.log('Docs fixture: http://127.0.0.1:5180/docs'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => {
      docs.close();
      process.exit(0);
    });
  });
