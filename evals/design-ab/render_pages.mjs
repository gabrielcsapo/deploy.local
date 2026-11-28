// Render the art and UI runs the same way, with no names on them.
// Usage: DEPLOY_CHROMIUM=/tmp/chromium node evals/design-ab/render_pages.mjs <key.json> <out dir>
import { chromium } from 'playwright';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const [keyFile, out] = process.argv.slice(2);
const key = JSON.parse(readFileSync(keyFile, 'utf8'));
// A brief may say how its art is shown in play: { roles: [[role, regex source]], ground: css, dark }.
// A phone brief may name the colour scheme its screen is shown in: { scheme: 'dark' }.
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
  // The first board in the canvas's order, else the first file.
  let first = null;
  try {
    first = JSON.parse(readFileSync(join(r.proj, 'design', 'canvas.json'), 'utf8')).order?.[0];
  } catch {}
  return join(
    dir,
    first && existsSync(join(dir, first))
      ? first
      : readdirSync(dir).find((f) => f.endsWith('.html')),
  );
}
// The PDF a document, deck or card run delivered: B's out/, A's export (the harness runs it).
function pdfOf(r) {
  if (r.arm === 'B') {
    const names = { doc: 'doc.pdf', slides: 'slides.pdf', print: 'card.pdf' };
    return join(r.proj, 'out', names[r.kind]);
  }
  const dir = join(r.proj, 'output', 'design', 'export');
  return join(
    dir,
    readdirSync(dir).find((f) => f.endsWith('.pdf')),
  );
}
function markOf(r) {
  if (r.arm === 'B') return join(r.proj, 'out', 'mark.svg');
  const dir = join(r.proj, 'output', 'design');
  return join(
    dir,
    readdirSync(dir).find((f) => f.endsWith('-mark.svg')),
  );
}
// Every page of a PDF as PNGs at a resolution, laid out in a page of its own.
function pdfPage(r, work) {
  // Slides by width, since a deck may be made at 1920 points or 1920 pixels; pages and cards by dpi.
  const size =
    r.kind === 'slides'
      ? ['-scale-to-x', '640', '-scale-to-y', '-1']
      : ['-r', String({ doc: 60, print: 300 }[r.kind])];
  const prefix = join(work, 'page');
  execFileSync('pdftoppm', [...size, '-png', pdfOf(r), prefix]);
  const pages = readdirSync(work)
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort();
  const columns = { doc: 4, slides: 3, print: 2 }[r.kind];
  return `<!doctype html><html><head><style>body{margin:0;padding:16px;background:#8a8f96;font:13px sans-serif}
  .grid{display:grid;grid-template-columns:repeat(${columns},max-content);gap:16px}
  img{display:block;box-shadow:0 1px 4px rgba(0,0,0,.4);background:#fff}
  p{color:#fff;margin:0 0 8px}</style></head><body><p>${pages.length} page${pages.length === 1 ? '' : 's'}</p>
  <div class="grid">${pages.map((f) => `<img src="file://${join(work, f)}">`).join('')}</div></body></html>`;
}
function logoPage(r) {
  const svg = readFileSync(markOf(r), 'utf8').replace(/<\?xml[^>]*>/, '');
  const at = (size, ground, extra = '') =>
    `<div class="cell" style="background:${ground};${extra}"><div style="width:${size}px;height:${size}px">${svg}</div></div>`;
  return `<!doctype html><html><head><style>body{margin:0;padding:16px;background:#fff;font:13px sans-serif;width:1100px}
  .row{display:flex;gap:16px;align-items:center;margin-bottom:16px}
  .cell{padding:24px;display:flex;align-items:center;justify-content:center}
  .cell svg{width:100%;height:100%;display:block}
  .icon{width:180px;height:180px;border-radius:40px;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.3)}
  p{margin:4px 0 12px;color:#333}</style></head><body>
  <p>Large, on a light and a dark ground</p><div class="row">${at(320, '#f4f2ee')}${at(320, '#1d1d20')}</div>
  <p>App icon, and at 64, 32 and 16 px on light and dark</p><div class="row">${at(120, '#ffffff', 'width:180px;height:180px;padding:30px;box-sizing:border-box;border-radius:40px;box-shadow:0 1px 3px rgba(0,0,0,.3)')}
  ${at(64, '#f4f2ee', 'padding:12px')}${at(32, '#f4f2ee', 'padding:12px')}${at(16, '#f4f2ee', 'padding:12px')}
  ${at(64, '#1d1d20', 'padding:12px')}${at(32, '#1d1d20', 'padding:12px')}${at(16, '#1d1d20', 'padding:12px')}</div>
  </body></html>`;
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
  } else if (['doc', 'slides', 'print', 'logo'].includes(r.kind)) {
    const work = join(out, '.work', rid);
    mkdirSync(work, { recursive: true });
    const html = r.kind === 'logo' ? logoPage(r) : pdfPage(r, work);
    writeFileSync(join(work, 'page.html'), html);
    const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
    await page.goto(`file://${join(work, 'page.html')}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: file, fullPage: true });
    console.log(rid, r.kind === 'logo' ? markOf(r) : pdfOf(r));
    await page.close();
  } else {
    const mac = r.kind === 'mac';
    const page = await browser.newPage({
      viewport: mac ? { width: 1280, height: 800 } : { width: 390, height: 844 },
      deviceScaleFactor: mac ? 1 : 2,
      colorScheme: briefs[r.brief]?.render?.scheme ?? 'light',
    });
    await page.goto(`file://${uiFile(r)}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: file });
    console.log(rid, uiFile(r).split('/').slice(-2).join('/'));
    await page.close();
  }
}
await browser.close();
