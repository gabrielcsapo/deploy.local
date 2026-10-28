import type { ServerResponse } from 'node:http';
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function restartingHtml(
  name = process.env.DEPLOY_NODE_NAME || 'this computer',
  version = process.env.DEPLOY_VERSION,
) {
  const computer = escape(name),
    target = version ? ` on ${escape(version)}` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>deploy.local · Restarting</title><style>
  *{box-sizing:border-box}body{margin:0;background:#fafafb;color:#222126;font:13px/1.55 'Hanken Grotesk',system-ui,sans-serif}main{max-width:508px;margin:96px auto;padding:0 24px;display:flex;flex-direction:column;gap:20px}header{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600}.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:#7040c8;color:white}h1{font-size:22px;line-height:1.25;margin:0 0 6px;font-weight:600}p{margin:0;color:#5f5c67}.waiting,footer{font-size:12px;color:#716d7b}.waiting{display:flex;align-items:center;gap:8px}footer{border-top:1px solid #e5e3ea;padding-top:16px}svg{color:#3764c7;animation:turn 1s linear infinite}@keyframes turn{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){svg{animation:none}}@media(prefers-color-scheme:dark){body{background:#19181c;color:#eeeaf3}p,.waiting,footer{color:#bbb5c5}footer{border-color:#39353f}}</style>
  <main><header><span class="mark">d</span>deploy.local</header><section><h1>Updating ${computer}</h1><p>deploy.local is restarting${target}. Your apps keep running. This page comes back by itself, usually within a minute.</p></section><div class="waiting" role="status"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>Waiting for ${computer}</div><footer>Not back after 5 minutes? Check that ${computer} is on, then run <code>deploy status</code> on it.</footer></main></html>`;
}
export function controlRestartingPage(res: ServerResponse) {
  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': '5',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(restartingHtml());
}
