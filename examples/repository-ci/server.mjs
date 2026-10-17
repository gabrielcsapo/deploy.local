import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const version = JSON.parse(readFileSync(new URL('./version.json', import.meta.url), 'utf8'));
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
export function createApplication() {
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('ok');
      return;
    }
    if (request.url === '/version') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(version));
      return;
    }
    if (request.url !== '/') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Repository CI</title><style>:root{color-scheme:light dark;font:16px/1.6 system-ui;background:light-dark(#fbf9fd,#0d0b13);color:light-dark(#241a30,#f5f2fa)}body{margin:0;min-height:100dvh;display:grid;place-items:center}main{width:min(640px,calc(100% - 48px))}h1{font-size:36px;letter-spacing:-1px;margin:8px 0 20px}p{color:light-dark(#5f516c,#c0b8cd)}code{color:light-dark(#70439a,#c9adf1)}a{color:inherit;text-underline-offset:4px}</style><main><p>deploy.local</p><h1>Repository CI</h1><p>${escape(version.message)}</p><p>Application release <code>${escape(version.release)}</code></p><a href="/version">Inspect running version</a></main></html>`,
    );
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createApplication().listen(Number(process.env.PORT || 3000), '0.0.0.0');
