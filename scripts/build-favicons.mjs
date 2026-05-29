#!/usr/bin/env node
// Renders public/favicon.svg into the full set of PNG favicons + a multi-res
// ICO. Uses headless Chrome for SVG rasterization (every macOS install has it,
// unlike rsvg-convert/ImageMagick) and Pillow to assemble the .ico. Run by hand
// when the brand mark changes:
//   node scripts/build-favicons.mjs

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SVG_PATH = join(PUBLIC_DIR, 'favicon.svg');
const TMP_DIR = '/tmp/deploy-local-favicon-build';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const svgContent = readFileSync(SVG_PATH, 'utf-8');

mkdirSync(TMP_DIR, { recursive: true });

function renderSize(size, outPath) {
  // Wrap the SVG in an HTML page that fills the viewport. Chrome's default
  // rendering of a bare .svg honours its intrinsic dimensions and centers
  // it in the viewport — that leaves padding at non-64px window sizes.
  // The wrapper forces the SVG to fill the viewport at exact pixel size.
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; width: ${size}px; height: ${size}px; overflow: hidden; }
  svg { width: ${size}px; height: ${size}px; display: block; }
</style>
</head>
<body>${svgContent}</body>
</html>`;
  const htmlPath = join(TMP_DIR, `wrap-${size}.html`);
  writeFileSync(htmlPath, html);

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
}

// Output set. The 16/32/48 PNGs are temporary — they only exist long enough
// to be folded into favicon.ico, then deleted.
const FINAL_SIZES = [
  { name: 'favicon-96x96.png', size: 96 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'web-app-manifest-192x192.png', size: 192 },
  { name: 'web-app-manifest-512x512.png', size: 512 },
];

for (const { name, size } of FINAL_SIZES) {
  const outPath = join(PUBLIC_DIR, name);
  console.log(`→ ${name} (${size}×${size})`);
  renderSize(size, outPath);
}

// Render a single high-quality source for the multi-resolution ICO. Pillow
// downsamples this to 16/32/48 internally — append_images isn't honoured for
// ICO output, so re-rendering each layer in Chrome would be wasted work.
console.log('→ favicon.ico (source 64×64 → 16/32/48 layers)');
const ICO_SRC = join(TMP_DIR, 'favicon-ico-source.png');
renderSize(64, ICO_SRC);

const ICO_PATH = join(PUBLIC_DIR, 'favicon.ico');
const pyScript = `
from PIL import Image
img = Image.open(${JSON.stringify(ICO_SRC)})
img.save(${JSON.stringify(ICO_PATH)}, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
print('wrote', ${JSON.stringify(ICO_PATH)})
`;
execFileSync('python3', ['-c', pyScript], { stdio: 'inherit' });

rmSync(TMP_DIR, { recursive: true, force: true });
console.log('Done.');
