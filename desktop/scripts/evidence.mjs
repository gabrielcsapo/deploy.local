import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { render } from '../src/views.mjs';
import { fileURLToPath } from 'node:url';
const base = new URL('../', import.meta.url);
const output = new URL('../../docs/evidence/v2/13-desktop/previews/', import.meta.url);
await mkdir(output, { recursive: true });
let css = await readFile(new URL('assets/shell.css', base), 'utf8');
for (const weight of [400, 600])
  css = css.replace(
    `url(hanken-${weight}.woff2)`,
    `url(data:font/woff2;base64,${(await readFile(new URL(`assets/hanken-${weight}.woff2`, base))).toString('base64')})`,
  );
const common = {
  origin: 'https://deploy.local',
  coordinatorName: 'SER',
  name: 'MacBook Pro',
  hardware: 'Apple M4 Pro · 48 GB · macOS 27',
  platform: 'darwin',
  screenSupported: true,
  roles: { takeTasks: true },
  online: true,
  summary: { running: 7, failing: 1 },
  worker: { state: 'Ready for tasks' },
  lastSeen: new Date('2026-10-27T14:41:00-04:00').getTime(),
};
const inbox = [
  {
    id: 'rollback',
    title: 'Roll back home-gym?',
    text: 'home-gym sync fails 38% of jobs since 1:58 PM. Both apps go back to 81be0d2 and migration 0042 is undone.',
    from: 'Warden',
    kind: 'rollback',
    actions: [
      { id: 'rollback', label: 'Roll back home-gym', primary: true },
      { id: 'dismiss', label: 'Not now' },
    ],
  },
  { id: 'merge', title: 'Merge PR #18', from: 'Scout' },
  { id: 'retention', title: 'Keep 3 or 5 releases?', from: 'Scout' },
];
const screens = {
  Setup: { page: 'setup' },
  SetupLinux: {
    page: 'setup',
    platform: 'linux',
    name: 'bazzite',
    hardware: 'AMD Ryzen 7 7840HS · 32 GB · Bazzite 42',
    screenSupported: false,
  },
  Permissions: { page: 'permissions' },
  Offline: { page: 'offline', online: false, inbox, worker: { state: 'Disconnected' } },
  Tray: { page: 'tray', inbox },
  ScreenAsk: {
    page: 'decision',
    item: {
      id: 'control:fixture',
      kind: 'control',
      title: 'Use your screen for this task?',
      text: 'Scout wants to open the Live screen in Simulator and take a screenshot. Simulator only, for this task, up to 15 minutes. You can stop anytime from the bar at the top of your screen.',
      from: 'Scout',
      actions: [
        { id: 'allow', label: 'Allow', primary: true },
        { id: 'deny', label: "Don't allow" },
      ],
    },
  },
  ScreenWatch: { page: 'watch', control: { label: 'Scout is using Simulator', elapsed: '1:12' } },
};
for (const [board, values] of Object.entries(screens)) {
  const width =
    board === 'Tray' ? 340 : board === 'ScreenWatch' ? 540 : board === 'Offline' ? 880 : 720;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${board} · desktop renderer evidence</title><style>${css}\n:root{color-scheme:light}body{background:#d2d6df;min-height:900px}.stage{padding:64px 16px;min-height:900px}.frame{width:${width}px;max-width:100%;margin:auto;background:var(--paper);border-radius:12px;box-shadow:0 24px 64px -16px #14121a59;overflow:hidden}.titlebar{height:40px;padding:14px 18px;display:flex;gap:8px}.titlebar i{height:12px;width:12px;border-radius:50%;background:#ff5f57}.titlebar i:nth-child(2){background:#febc2e}.titlebar i:nth-child(3){background:#28c840}.evidence-label{position:fixed;bottom:10px;left:16px;color:#444;font:12px Hanken}@media(prefers-color-scheme:dark){:root{--paper:#f9f9fb;--surface:#fff;--ink:#222126;--muted:#656171;--line:#e4e2e9;--selection:#eeedf1;--action:#222126}button.primary{color:white}}</style></head><body><div class="stage"><div class="frame">${['Tray', 'ScreenWatch'].includes(board) ? '' : '<div class="titlebar"><i></i><i></i><i></i></div>'}${render({ ...common, ...values })}</div></div><small class="evidence-label">Renderer fixture · ${board} · native Electron launch unavailable</small></body></html>`;
  await writeFile(new URL(`${board}.html`, output), html);
}
console.log(fileURLToPath(output));
