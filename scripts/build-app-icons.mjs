#!/usr/bin/env node
// Renders the native AppIcon set from the brand tile the web uses,
// public/app-icon.svg (the house-and-arrow mark on action violet). iOS gets one
// full-bleed, opaque 1024 px image; the system applies its own corner mask.
// macOS gets every size on Apple's icon grid: an 824 px rounded tile centred on
// a 1024 px canvas with a soft drop shadow. 16 and 32 pt use the favicon cut.
// Uses headless Chrome for SVG rasterization and Pillow to flatten the iOS
// image, like scripts/build-favicons.mjs. Run by hand when a mark changes:
//   node scripts/build-app-icons.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const ICONSET = join(ROOT, 'native/Apple/Apps/Shared/Assets.xcassets/AppIcon.appiconset');
const TMP_DIR = '/tmp/deploy-local-app-icon-build';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const tileArt = readFileSync(join(PUBLIC_DIR, 'app-icon.svg'), 'utf-8');
// favicon.svg is the small-size cut: its own rounded tile, a larger house and a
// heavier arrow. Finder lists and menus use it at 16 and 32 pt.
const smallArt = readFileSync(join(PUBLIC_DIR, 'favicon.svg'), 'utf-8');

mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(ICONSET, { recursive: true });

function render(size, outPath, body, css) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; width: ${size}px; height: ${size}px; overflow: hidden; }
  ${css}
</style></head><body>${body}</body></html>`;
  const htmlPath = join(TMP_DIR, `icon-${size}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(htmlPath, html);
  rmSync(outPath, { force: true });
  try {
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-sandbox',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${outPath}`,
        `file://${htmlPath}`,
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    // Headless Chrome can exit non-zero on shutdown after writing the image.
    if (!existsSync(outPath) || statSync(outPath).size === 0) throw error;
  }
}

// iOS: full-bleed tile. App Store and the home screen reject transparency.
const iosRaw = join(TMP_DIR, 'ios-1024.png');
render(1024, iosRaw, tileArt, 'svg { width: 1024px; height: 1024px; display: block; }');
const iosOut = join(ICONSET, 'ios-1024.png');
execFileSync('python3', [
  '-c',
  `from PIL import Image
img = Image.open(${JSON.stringify(iosRaw)}).convert('RGBA')
flat = Image.new('RGB', img.size, (124, 82, 214))
flat.paste(img, mask=img.split()[3])
flat.save(${JSON.stringify(iosOut)})`,
]);
console.log('→ ios-1024.png');

// macOS: Apple's grid scales with the canvas — tile 824/1024, inset 100/1024,
// corner radius 185.4/1024, shadow offset 10/1024 and blur 20/1024.
function macTile(size, svg) {
  const k = size / 1024;
  const tile = 824 * k;
  const css = `
  .tile { position: absolute; left: ${100 * k}px; top: ${100 * k}px; width: ${tile}px; height: ${tile}px;
    border-radius: ${185.4 * k}px; overflow: hidden; background: #7c52d6;
    box-shadow: 0 ${10 * k}px ${20 * k}px rgba(0, 0, 0, 0.28); }
  .tile svg { width: ${tile}px; height: ${tile}px; display: block; }`;
  return { css, body: `<div class="tile">${svg}</div>` };
}

const MAC = [
  { pt: 16, scale: 1 },
  { pt: 16, scale: 2 },
  { pt: 32, scale: 1 },
  { pt: 32, scale: 2 },
  { pt: 128, scale: 1 },
  { pt: 128, scale: 2 },
  { pt: 256, scale: 1 },
  { pt: 256, scale: 2 },
  { pt: 512, scale: 1 },
  { pt: 512, scale: 2 },
];

const images = [
  { filename: 'ios-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
];
for (const { pt, scale } of MAC) {
  const px = pt * scale;
  const filename = `mac-${pt}@${scale}x.png`;
  if (pt <= 32) {
    render(
      px,
      join(ICONSET, filename),
      smallArt,
      `svg { width: ${px}px; height: ${px}px; display: block; }`,
    );
  } else {
    const { css, body } = macTile(px, tileArt);
    render(px, join(ICONSET, filename), body, css);
  }
  images.push({ filename, idiom: 'mac', scale: `${scale}x`, size: `${pt}x${pt}` });
  console.log(`→ ${filename}`);
}

writeFileSync(
  join(ICONSET, 'Contents.json'),
  `${JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2)}\n`,
);
writeFileSync(
  join(ICONSET, '..', 'Contents.json'),
  `${JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2)}\n`,
);

rmSync(TMP_DIR, { recursive: true, force: true });
console.log('Done.');
