// Render the art and UI runs the same way, with no names on them.
// Usage: DEPLOY_CHROMIUM=/tmp/chromium node evals/design-ab/render_pages.mjs <key.json> <out dir>
import { chromium } from 'playwright';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [keyFile, out] = process.argv.slice(2);
const key = JSON.parse(readFileSync(keyFile, 'utf8'));
// A brief may say how its art is shown in play: { roles: [[role, regex source]], ground: css, dark }.
const briefs = Object.fromEntries(
  JSON.parse(
    readFileSync(process.env.BRIEFS || new URL('./briefs.json', import.meta.url), 'utf8'),
  ).map((b) => [b.id, b]),
);
const order = [
  ['character', /hero|courier|technician|player/i],
  ['enemy', /beetle|golem|slime|enemy/i],
  ['tile', /tile|grating|sandstone|floor|ground/i],
  ['pickup', /parcel|battery|pickup|coin|cell/i],
];
const grounds = {
  'art-1': { sky: '#f6c48f', far: '#4a2b4f' },
  'art-2': { sky: '#0b1224', seam: '#18294d' },
};
function rolesOf(brief) {
  const spec = briefs[brief]?.render?.roles;
  return spec ? spec.map(([role, re]) => [role, new RegExp(re, 'i')]) : order;
}
function sprites(r) {
  const dir =
    r.arm === 'B'
      ? join(r.proj, 'out', 'sprites')
      : join(
          r.proj,
          'output',
          'design',
          'art',
          readdirSync(join(r.proj, 'output', 'design', 'art'))[0],
        );
  const files = readdirSync(dir).filter((f) => f.endsWith('.svg'));
  const picked = [];
  for (const [role, re] of rolesOf(r.brief)) {
    const f = files.find((f) => re.test(f) && !picked.some((p) => p.file === f));
    picked.push({ role, file: f ? join(dir, f) : null });
  }
  for (const p of picked) {
    if (!p.file) continue;
    const svg = readFileSync(p.file, 'utf8');
    const vb = /viewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/.exec(svg);
    p.w = Number(vb?.[1] ?? 16);
    p.h = Number(vb?.[2] ?? 16);
  }
  return picked;
}
function artPage(brief, list) {
  const g = grounds[brief];
  const z = 4,
    big = 8;
  const img = (p, s) =>
    `<img src="file://${p.file}" style="width:${p.w * s}px;height:${p.h * s}px">`;
  const tile = list.find((p) => p.role === 'tile');
  const spec = briefs[brief]?.render;
  const ground = spec
    ? spec.ground.replaceAll('{z}', String(z))
    : brief === 'art-1'
      ? `background:${g.sky}`
      : `background-color:${g.sky};background-image:linear-gradient(${g.seam} 2px,transparent 2px),linear-gradient(90deg,${g.seam} 2px,transparent 2px);background-size:${32 * z}px ${32 * z}px`;
  const mesa = !spec && brief === 'art-1' ? `<div class="mesa"></div>` : '';
  const cell = (p) =>
    `<figure><div class="in">${p.file ? img(p, z) : '<b>missing</b>'}</div><figcaption>${p.role}</figcaption></figure>`;
  const tiles = tile?.file
    ? Array.from({ length: 9 }, () => img(tile, z)).join('')
    : '<b>missing</b>';
  return `<!doctype html><html><head><style>
  body{margin:0;font:14px/1.3 sans-serif;color:#222;background:#fff;padding:16px;width:${spec ? spec.width : brief === 'art-1' ? 900 : 1300}px}
  img{image-rendering:pixelated;display:block}
  h2{font-size:15px;margin:18px 0 8px}
  .stage{position:relative;${ground};padding:24px;display:flex;gap:40px;align-items:flex-end;overflow:hidden}
  .mesa{position:absolute;left:0;right:0;bottom:0;height:60%;background:${g?.far ?? 'none'};clip-path:polygon(0 40%,12% 40%,16% 10%,30% 10%,34% 45%,52% 45%,56% 0,70% 0,74% 35%,100% 35%,100% 100%,0 100%)}
  .stage figure{position:relative;margin:0}
  figcaption{font-size:12px;color:${(spec ? !spec.dark : brief === 'art-1') ? '#222' : '#ccd'};margin-top:4px}
  .grid{display:grid;grid-template-columns:repeat(3,max-content)}
  .checker{background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px;display:flex;gap:24px;padding:16px;align-items:flex-end}
  .checker figcaption{color:#222}
  </style></head><body>
  <h2>In play, at ${z}x</h2><div class="stage">${mesa}${list.map(cell).join('')}</div>
  <h2>Ground tile repeated 3 x 3, at ${z}x</h2><div class="grid">${tiles}</div>
  <h2>Close up, at ${big}x</h2><div class="checker">${list.map((p) => `<figure style="margin:0">${p.file ? img(p, big) : '<b>missing</b>'}<figcaption>${p.role}</figcaption></figure>`).join('')}</div>
  </body></html>`;
}
function uiFile(r) {
  if (r.arm === 'B') return join(r.proj, 'out', 'screen.html');
  const dir = join(r.proj, 'design', 'boards');
  return join(
    dir,
    readdirSync(dir).find((f) => f.endsWith('.html')),
  );
}
const browser = await chromium.launch({ executablePath: process.env.DEPLOY_CHROMIUM });
for (const [rid, r] of Object.entries(key).sort()) {
  if (r.kind === 'model') continue;
  mkdirSync(join(out, r.brief), { recursive: true });
  const file = join(out, r.brief, `${rid}.png`);
  if (r.kind === 'art') {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    const list = sprites(r);
    const html = artPage(r.brief, list);
    const tmp = join(out, '.work', `${rid}.html`);
    mkdirSync(join(out, '.work'), { recursive: true });
    writeFileSync(tmp, html);
    await page.goto(`file://${tmp}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: file, fullPage: true });
    console.log(
      rid,
      list
        .map((p) => `${p.role}:${p.file ? p.file.split('/').pop() + ` ${p.w}x${p.h}` : 'MISSING'}`)
        .join(' '),
    );
    await page.close();
  } else {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    await page.goto(`file://${uiFile(r)}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: file });
    console.log(rid, uiFile(r).split('/').slice(-2).join('/'));
    await page.close();
  }
}
await browser.close();
