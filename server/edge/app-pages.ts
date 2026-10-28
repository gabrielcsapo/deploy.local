import type { ServerResponse } from 'node:http';
export interface AddressApp {
  name: string;
  title?: string;
}
export interface AppAvailability extends AddressApp {
  state: 'rolling-back' | 'stopped' | 'unavailable';
  computer?: string;
  startedAt?: string;
  expectedAt?: string;
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function appNameFromHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'deploy.local' || host === 'discover.local') return null;
  const suffix = host.endsWith('.deploy.local') ? '.deploy.local' : '.local';
  if (!host.endsWith(suffix)) return null;
  const name = host.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) && name.length <= 253 ? name : null;
}
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return previous[b.length];
}
export function closestApp(name: string, apps: AddressApp[]): AddressApp | undefined {
  return apps
    .filter((app) => appNameFromHost(`${app.name}.deploy.local`) === app.name)
    .sort(
      (a, b) =>
        editDistance(name, a.name) - editDistance(name, b.name) || a.name.localeCompare(b.name),
    )[0];
}
// Inline values mirror app/design-tokens.json; app initials use the board’s app color.
const css = `*{box-sizing:border-box}body{margin:0;background:#fafafb;color:#1c1b1f;font:13px/20px 'Hanken Grotesk',system-ui,sans-serif}main{max-width:508px;margin:96px auto;padding:0 24px;display:flex;flex-direction:column;gap:20px}header{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600}.mark,.app-icon{display:grid;place-items:center;flex:none;color:white;background:#6a3fc4;width:32px;height:32px;border-radius:9px;font-weight:600}.app-icon{background:#7a5aa8}.large{width:44px;height:44px;border-radius:11px;font-size:18px}h1{font-size:22px;line-height:28px;font-weight:600;margin:0 0 6px;overflow-wrap:anywhere}p{margin:0;color:#55525b}code{font-family:ui-monospace,monospace;font-size:.9em}a{color:inherit;text-decoration:none}a:focus-visible{outline:2px solid #6a3fc4;outline-offset:3px}.suggestion{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid #e8e7eb;border-radius:12px;background:#fff}.suggestion span:nth-child(2){flex:1;min-width:0}.suggestion small{display:block;color:#67636f;font:12px/18px ui-monospace,monospace;overflow-wrap:anywhere}.button{display:flex;align-items:center;justify-content:center;min-height:32px;border:1px solid #d6d4db;border-radius:8px;background:#fff}.status,footer{font-size:12px;color:#67636f}.status{display:flex;align-items:center;gap:8px}footer{border-top:1px solid #e8e7eb;padding-top:16px}footer a{color:#6a3fc4}.status svg{color:#2f5bb7;animation:turn 1s linear infinite}@keyframes turn{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.status svg{animation:none}}@media(prefers-color-scheme:dark){body{background:#18171b;color:#f3f2f5}p,.status,footer,.suggestion small{color:#c5c1cc}.suggestion,.button{background:#211f25;border-color:#2e2c33}footer{border-color:#2e2c33}footer a{color:#c9adf1}}`;
function document(title: string, body: string, refresh = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ''}<title>${escape(title)} · deploy.local</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
}
export function appNotFoundHtml(hostname: string, apps: AddressApp[]) {
  const app = closestApp(appNameFromHost(hostname) || '', apps);
  return document(
    'App not found',
    `<header><span class="mark">d</span>deploy.local</header><section><h1>No app at <code>${escape(hostname)}</code></h1><p>${app ? 'Did you mean this one?' : 'Check the address, or see all apps at home.'}</p></section>${app ? `<a class="suggestion" href="https://${escape(app.name)}.deploy.local/"><span class="app-icon">${escape((app.title || app.name).charAt(0).toUpperCase())}</span><span>${escape(app.title || app.name)}<small>${escape(app.name)}.deploy.local</small></span><span aria-hidden="true">›</span></a>` : ''}<a class="button" href="https://deploy.local/">All apps at home</a>`,
  );
}
export function appUnavailableHtml(app: AppAvailability) {
  const rolling = app.state === 'rolling-back';
  const title = `${app.title || app.name} ${rolling ? 'is being restored' : app.state === 'stopped' ? 'is stopped' : 'is unavailable'}`;
  const expected =
    app.expectedAt && Number.isFinite(Date.parse(app.expectedAt))
      ? `Expected back ${new Date(app.expectedAt).toLocaleString('en-US')}.`
      : rolling
        ? 'It usually takes about a minute; the return time is not yet confirmed.'
        : 'There is no return time yet.';
  const started =
    app.startedAt && Number.isFinite(Date.parse(app.startedAt))
      ? ` · started ${new Date(app.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      : '';
  return document(
    title,
    `<span class="app-icon large">${escape(app.name.charAt(0).toUpperCase())}</span><section><h1>${escape(title)}</h1><p>${rolling ? `${escape(app.name)} is going back to its previous version. ` : app.state === 'stopped' ? 'Open Live to check this app. ' : 'This app is not responding yet. '}${escape(expected)} This page reloads by itself.</p></section><div class="status" role="status">${app.state !== 'stopped' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/></svg>' : ''}${rolling ? 'Rolling back' : app.state === 'stopped' ? 'Stopped' : 'Waiting for the app'}${app.computer ? ` on ${escape(app.computer)}` : ''}${escape(started)}</div><footer><a href="https://deploy.local/">Apps at home</a> · <a href="https://deploy.local/dashboard/live">Live</a></footer>`,
    true,
  );
}
export function sendAppPage(res: ServerResponse, status: 404 | 503, html: string, head = false) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(status === 503 ? { 'Retry-After': '5', Refresh: '5' } : {}),
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(head ? undefined : html);
}
