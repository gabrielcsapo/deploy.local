// A sprite as it is met and judged: close up on a checkerboard, at play size on each ground the
// sheet plays it on (a tile repeated 3×3 there), and at 1×. `deploy design look <Sprite>` draws it,
// so nobody needs a preview script of their own.

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sprite's svg on a board: the innermost svg.art-sprite whose data-layer is the name. */
export function findSprite(html, name) {
  const all = [...html.matchAll(/<svg\b[^>]*>(?:(?!<svg\b)[\s\S])*?<\/svg>/g)].map((m) => m[0]);
  const sprites = all.filter((svg) =>
    /class="[^"]*\bart-sprite\b/.test(svg.slice(0, svg.indexOf('>'))),
  );
  const layer = (svg) => attr(svg.slice(0, svg.indexOf('>') + 1), 'data-layer') ?? '';
  return (
    sprites.find((svg) => layer(svg) === name) ??
    sprites.find((svg) => layer(svg).toLowerCase() === name.toLowerCase()) ??
    null
  );
}

/** Every sprite name on a board, for "did you mean". */
export function spriteNames(html) {
  return [...html.matchAll(/<svg\b[^>]*class="[^"]*\bart-sprite\b[^>]*>/g)]
    .map((m) => attr(m[0], 'data-layer'))
    .filter(Boolean);
}

/** The grounds a sheet plays on: its .art-ground elements, else its --stage-* colours. */
function groundsOf(html, css) {
  const found = [];
  for (const m of html.matchAll(/<(\w+)\b[^>]*\bclass="([^"]*\bart-ground\b[^"]*)"[^>]*>/g)) {
    const style = attr(m[0], 'style') ?? '';
    const label = attr(m[0], 'data-layer') ?? m[2].replace(/\bart-ground\b/, '').trim();
    if (!found.some((g) => g.className === m[2] && g.style === style))
      found.push({ className: m[2], style, label: label || 'its ground' });
  }
  if (found.length) return { grounds: found.slice(0, 3), guessed: false };
  const stages = [...new Set([...css.matchAll(/(--stage-[\w-]+)\s*:/g)].map((m) => m[1]))];
  if (stages.length)
    return {
      grounds: stages.slice(0, 3).map((name) => ({
        className: '',
        style: `background: var(${name})`,
        label: name.replace('--stage-', ''),
      })),
      guessed: false,
    };
  return {
    grounds: [{ className: '', style: 'background: #ffffff', label: 'white (no ground named)' }],
    guessed: true,
  };
}

/**
 * The page that shows one sprite as it is judged. `board` is the art board's html, `css` the
 * project's look.css (for --stage-* grounds). Returns null when the board has no such sprite.
 */
export function spriteLookPage({ board, css = '', name }) {
  const svg = findSprite(board, name);
  if (!svg) return null;
  const open = svg.slice(0, svg.indexOf('>') + 1);
  const box = /viewBox="\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(open);
  const w = box ? Number(box[1]) : Number(attr(open, 'width')) || 16;
  const h = box ? Number(box[2]) : Number(attr(open, 'height')) || 16;
  const meta = /<meta[^>]+name="design-board"[^>]+content="([^"]*)"/.exec(board)?.[1] ?? '';
  const key = (k) => new RegExp(`(?:^|,)\\s*${k}=([\\d.]+)`).exec(meta)?.[1];
  const tile = Number(key('tile')) || 16;
  const play = Number(key('play')) || tile * 3;
  const scale = play / tile;
  const tiled = /class="[^"]*\btile\b/.test(open) || /tile/i.test(attr(open, 'data-layer') ?? '');
  const close = Math.max(1, Math.min(8, Math.floor(960 / Math.max(w, h))));
  const head = [
    ...board.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>|<style\b[^>]*>[\s\S]*?<\/style>/g),
  ]
    .map((m) => m[0])
    .join('\n');
  // The sprite at a size: its own attributes kept, its box set, its pixels square.
  const at = (px) =>
    svg.replace(
      /^<svg\b[^>]*>/,
      open
        .replace(/\s(width|height|style)="[^"]*"/g, '')
        .replace(
          /^<svg\b/,
          `<svg width="${w * px}" height="${h * px}" style="display:block;width:${w * px}px;height:${h * px}px;flex:none" shape-rendering="crispEdges"`,
        ),
    );
  const { grounds, guessed } = groundsOf(board, css);
  const label = (text) =>
    `<div style="margin:20px 0 8px;font:600 13px/1.3 system-ui,sans-serif;color:#333">${escape(text)}</div>`;
  const checker =
    'background-color:#fff;background-image:conic-gradient(#e6e6e6 25%,#fff 0 50%,#e6e6e6 0 75%,#fff 0);background-size:16px 16px';
  const grid = (px, n) =>
    `<div style="display:grid;grid-template-columns:repeat(${n},${w * px}px);width:${w * px * n}px">${Array.from({ length: n * n }, () => at(px)).join('')}</div>`;
  const inPlay = grounds
    .map(
      (ground) =>
        label(
          `In play: ${play} px a tile (${scale}×${key('play') ? '' : ', a guess: no play= in the head'}) on ${ground.label}`,
        ) +
        `<div class="${escape(ground.className)}" style="${escape(ground.style)};position:relative;display:flex;align-items:center;gap:${Math.round(w * scale)}px;padding:${Math.round(h * scale * 0.5)}px ${Math.round(w * scale * 0.5)}px;width:auto;height:auto;min-height:0;overflow:visible">${tiled ? grid(scale, 3) : `${at(scale)}${at(1)}`}</div>`,
    )
    .join('');
  const width =
    Math.max(480, w * close, (tiled ? 3 * w * scale : 2 * w * scale) + w * scale + 64) + 48;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="design-board" content="width=${Math.ceil(width)}" />
    ${head}
  </head>
  <body style="margin:0;padding:8px 24px 24px;background:#fff;display:block;min-height:0;height:auto;width:auto">
    ${label(`${name}: ${w}×${h}, close up at ${close}×`)}
    <div style="${checker};display:inline-block;padding:${close}px">${at(close)}</div>
    ${inPlay}
    ${guessed ? label('No .art-ground on the sheet and no --stage-* colour in look.css: give it the ground the brief plays it on.') : ''}
    ${tiled ? label(`Repeated 3×3 at ${close >= 4 ? 4 : close}×, close`) + grid(close >= 4 ? 4 : close, 3) : ''}
  </body>
</html>`;
  return { html, width: Math.ceil(width), tiled, guessed, play, scale };
}
