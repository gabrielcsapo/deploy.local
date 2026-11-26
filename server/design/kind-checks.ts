// What the check says about the artifacts that are not app screens: a printed piece's safe area,
// a document's page breaks, a logo at 16 px, a board taller than its frame, a document's height.
// Plain arithmetic on what the drawn page gave back (an Inspection, or the picture's pixels), so
// the same code runs on deploy.local and on the computer.
import { inflateSync } from 'node:zlib';
import { contrast, type Box, type Inspection, type Rgb } from '../../shared/v2/design-inspect.ts';
import { CSS_PX_PER_MM } from '../../shared/v2/design-platforms.ts';
import type { Finding } from './board-quality.ts';

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────

/** A PNG's size in pixels, from its header. */
export function pngSize(png: Buffer) {
  return png.length >= 24 && png.readUInt32BE(0) === 0x89504e47
    ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
    : { width: 0, height: 0 };
}

/** The pixels of an 8-bit, non-interlaced PNG (what a browser's screenshot is), as RGBA. */
export function decodePng(png: Buffer) {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const data: Buffer[] = [];
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === 'IDAT') data.push(body);
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type as 0 | 2 | 4 | 6];
  if (!channels || depth !== 8 || interlace !== 0) throw new Error('Unsupported PNG');
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y ? rows[(y - 1) * stride + x] : 0;
      const upLeft = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const [a, b, c] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - upLeft)];
        value += a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      rows[y * stride + x] = value & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const from = pixel * channels;
    const grey = channels <= 2;
    rgba[pixel * 4] = rows[from];
    rgba[pixel * 4 + 1] = grey ? rows[from] : rows[from + 1];
    rgba[pixel * 4 + 2] = grey ? rows[from] : rows[from + 2];
    rgba[pixel * 4 + 3] = channels === 4 ? rows[from + 3] : channels === 2 ? rows[from + 1] : 255;
  }
  return { width, height, rgba };
}

/**
 * How well a mark reads when the picture is shrunk to `size` px: the ground is the colour most of
 * the picture's border has; each of the size x size cells is the average of the pixels it covers;
 * the best contrast any cell has against the ground says whether anything shows.
 */
export function smallContrast(png: Buffer, size = 16) {
  const { width, height, rgba } = decodePng(png);
  const at = (x: number, y: number): Rgb => {
    const i = (y * width + x) * 4;
    const alpha = rgba[i + 3] / 255;
    return [0, 1, 2].map((c) => Math.round(rgba[i + c] * alpha + 255 * (1 - alpha))) as Rgb;
  };
  const counts = new Map<string, { rgb: Rgb; n: number }>();
  const border = Math.max(1, Math.floor(Math.min(width, height) / 64));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x >= border && x < width - border && y >= border && y < height - border) {
        x = Math.max(x, width - border - 1);
        continue;
      }
      const rgb = at(x, y);
      const key = rgb.join();
      const found = counts.get(key);
      if (found) found.n++;
      else counts.set(key, { rgb, n: 1 });
    }
  const ground = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.rgb ?? ([255, 255, 255] as Rgb);
  let best = 1;
  let bestCell: Rgb = ground;
  for (let cy = 0; cy < size; cy++)
    for (let cx = 0; cx < size; cx++) {
      const x0 = Math.floor((cx * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / size));
      const y0 = Math.floor((cy * height) / size);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / size));
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const rgb = at(x, y);
          sum[0] += rgb[0];
          sum[1] += rgb[1];
          sum[2] += rgb[2];
          n++;
        }
      const cell = sum.map((value) => Math.round(value / n)) as Rgb;
      const ratio = contrast(cell, ground);
      if (ratio > best) {
        best = ratio;
        bestCell = cell;
      }
    }
  return { ground, cell: bestCell, contrast: best };
}

/** A logo that does not show at 16 px on a ground it is drawn on: a note, since small use is a choice. */
export function logoSmallNote(input: {
  file: string;
  title: string;
  results: { scheme: 'light' | 'dark'; contrast: number }[];
}): Finding | null {
  const weak = input.results.filter((result) => result.contrast < 3);
  if (!weak.length) return null;
  const worst = weak.reduce((a, b) => (a.contrast <= b.contrast ? a : b));
  return {
    code: 'logo_small_unreadable',
    file: input.file,
    board: input.title,
    scheme: worst.scheme,
    label: `${input.title} does not read at 16 px on its ${weak.map((entry) => entry.scheme).join(' and ')} ground`,
    detail: `the mark's best contrast at 16 px is ${worst.contrast.toFixed(1)}:1, under 3:1`,
    short: 'unreadable at 16 px',
    fix: 'thicken the strokes, drop the fine detail or give the mark a solid shape that holds at 16 px',
  };
}

// ── A printed piece ─────────────────────────────────────────────────────────────────────────────

/**
 * Text and marks inside the safe margin's distance of the trim: a printed edge moves a millimetre
 * or two, so a word that close is cut. A picture that runs into the bleed is a background; it is
 * meant to bleed.
 */
export function safeAreaProblems(input: {
  file: string;
  title: string;
  inspection: Inspection | null;
  geometry: { bleed: number; safe: number; width: number; height: number };
}): Finding[] {
  const { inspection, geometry } = input;
  if (!inspection) return [];
  const inset = (geometry.bleed + geometry.safe) * CSS_PX_PER_MM;
  const bleed = geometry.bleed * CSS_PX_PER_MM;
  const slack = 0.75;
  const outside = (box: { left: number; top: number; width: number; height: number }) =>
    box.left < inset - slack ||
    box.top < inset - slack ||
    box.left + box.width > geometry.width - inset + slack ||
    box.top + box.height > geometry.height - inset + slack;
  const reachesBleed = (box: { left: number; top: number; width: number; height: number }) =>
    box.left < bleed - slack ||
    box.top < bleed - slack ||
    box.left + box.width > geometry.width - bleed + slack ||
    box.top + box.height > geometry.height - bleed + slack;
  const found: { layer: string | null; what: string }[] = [];
  for (const text of inspection.texts)
    if (outside(text)) found.push({ layer: text.layer, what: `"${text.text}"` });
  for (const figure of inspection.figures ?? []) {
    if (figure.width * figure.height > geometry.width * geometry.height * 0.5) continue;
    if (reachesBleed(figure)) continue;
    if (outside(figure)) found.push({ layer: figure.layer, what: figure.layer ?? 'a picture' });
  }
  if (!found.length) return [];
  const first = found[0];
  return [
    {
      code: 'outside_safe_area',
      file: input.file,
      board: input.title,
      ...(first.layer ? { layer: first.layer } : {}),
      label: `${input.title} has content inside the ${geometry.safe} mm safe margin`,
      detail: `${found
        .slice(0, 4)
        .map((entry) => entry.layer ?? entry.what)
        .join(', ')}${found.length > 4 ? ` and ${found.length - 4} more` : ''}`,
      short: `${found.length} outside safe area`,
      fix: `keep text and marks ${geometry.safe} mm inside the trim; only a background may run into the bleed`,
    },
  ];
}

// ── An iPhone screen ────────────────────────────────────────────────────────────────────────────

/** What an iPhone keeps clear: the status bar and Dynamic Island on top, the home indicator below. */
export const phoneSafe = { top: 54, bottom: 34, side: 54 };

/** Whether a board's head opts out of the status bar and safe areas: immersive=true. */
export const isImmersive = (meta: { other?: Record<string, string> }) =>
  /^(true|yes|1)$/i.test(meta.other?.immersive ?? meta.other?.fullscreen ?? '');

/**
 * Whether a drawn board is an iPhone game screen with safe areas: a game board on a phone (390
 * wide, or 844 x 390 turned sideways); a game on a bigger screen has none of these. An app's
 * phone boards are not held to them: they are drawn as the app's content, without the device's
 * chrome (deploy.local's own 170 phone boards draw no status bar), so a rule here would flag
 * every one of them.
 */
export function phoneScreen(platform: string, width: number, height: number | null) {
  if (platform !== 'game') return null;
  if (width <= 500) return { landscape: false };
  if (height !== null && width === 844 && height === 390) return { landscape: true };
  return null;
}

/**
 * Text and marks in the status bar's or the home indicator's room (or, sideways, the notch's), on
 * an iPhone game screen: the system draws there. The status bar itself is allowed. A board that is
 * immersive on purpose (immersive=true in its head) opts out.
 */
export function screenSafeAreaProblems(input: {
  file: string;
  title: string;
  inspection: Inspection | null;
  platform: string;
  width: number;
  height: number;
  immersive?: boolean;
}): Finding[] {
  const { inspection } = input;
  const screen = phoneScreen(input.platform, input.width, input.height);
  if (!inspection || !screen || input.immersive) return [];
  const slack = 0.75;
  const bars = inspection.statusBars ?? [];
  const inBar = (box: Box) =>
    bars.some(
      (bar) =>
        box.left >= bar.left - slack &&
        box.left + box.width <= bar.left + bar.width + slack &&
        box.top >= bar.top - slack &&
        box.top + box.height <= bar.top + bar.height + slack,
    );
  // A screen taller than a device (a long scroll drawn whole) has no bottom to keep clear.
  const deviceTall = input.height <= 900;
  // What is scrolled out of the screen is no part of it: the cut-off checks say that.
  const onScreen = (box: Box) => box.top < input.height && box.top + box.height > 0;
  const outside = (box: Box) =>
    onScreen(box) &&
    !inBar(box) &&
    (screen.landscape
      ? box.left < phoneSafe.side - slack ||
        box.left + box.width > input.width - phoneSafe.side + slack
      : box.top < phoneSafe.top - slack ||
        (deviceTall && box.top + box.height > input.height - phoneSafe.bottom + slack));
  const found: { layer: string | null; what: string }[] = [];
  for (const text of inspection.texts)
    if (outside(text)) found.push({ layer: text.layer, what: `"${text.text}"` });
  for (const figure of inspection.figures ?? []) {
    if (figure.width * figure.height > input.width * input.height * 0.5) continue;
    // A shape across the whole width is a bar or a ground, not a mark under the clock.
    if (figure.width >= input.width * 0.9) continue;
    if (outside(figure)) found.push({ layer: figure.layer, what: figure.layer ?? 'a picture' });
  }
  if (!found.length) return [];
  const first = found[0];
  const where = screen.landscape
    ? `the ${phoneSafe.side} px at the sides`
    : `the ${phoneSafe.top} px under the status bar and the ${phoneSafe.bottom} px above the home indicator`;
  return [
    {
      code: 'outside_safe_area',
      file: input.file,
      board: input.title,
      width: input.width,
      scheme: 'light',
      ...(first.layer ? { layer: first.layer } : {}),
      label: `${input.title} has content in ${where}`,
      detail: `${found
        .slice(0, 4)
        .map((entry) => entry.layer ?? entry.what)
        .join(', ')}${found.length > 4 ? ` and ${found.length - 4} more` : ''}`,
      short: `${found.length} outside safe area`,
      fix: screen.landscape
        ? `keep everything ${phoneSafe.side} px in from the sides; or put immersive=true in the head if the screen is full-bleed on purpose`
        : `start content ${phoneSafe.top} px down (the status bar's room) and end it ${phoneSafe.bottom} px above the bottom; or put immersive=true in the head if the screen is full-bleed on purpose`,
    },
  ];
}

/**
 * A game screen on an iPhone with no status bar drawn: a note. A game board is the whole screen
 * (390 x 844), so the clock and signal are part of it; an app's phone boards draw their own chrome
 * (a title bar, a tab bar) and are held to the safe areas only.
 */
export function statusBarNote(input: {
  file: string;
  title: string;
  inspection: Inspection | null;
  platform: string;
  width: number;
  height: number;
  immersive?: boolean;
}): Finding | null {
  const screen = phoneScreen(input.platform, input.width, input.height);
  if (!input.inspection || !screen || screen.landscape || input.immersive) return null;
  if (input.platform !== 'game') return null;
  if (input.inspection.statusBars?.length) return null;
  return {
    code: 'no_status_bar',
    file: input.file,
    board: input.title,
    width: input.width,
    scheme: 'light',
    label: `${input.title} draws no status bar`,
    detail: `an iPhone screen has the time and signal in its top ${phoneSafe.top} px`,
    short: 'no status bar',
    fix: "draw the status bar in the top 54 px (the base kit's .ds-statusbar, or data-statusbar on your own markup), or put immersive=true in the board head if it is full-screen on purpose",
  };
}

/**
 * The height `deploy design check --fix` writes for a board whose head and canvas.json disagree.
 * A frame (a window, a slide, a screen, a card) is the size its head says; a flowing page is as
 * tall as it reads. Either way it is never less than the content the board needs, including
 * what a window-sized frame clips and what is placed absolutely, or the fix would cut it off.
 */
export function fixedHeight(input: {
  platform: string;
  fixedFrame: boolean;
  metaHeight: number | null;
  /** The page's height as drawn in a short window. */
  natural: number;
  /** What the board needs to show everything (Inspection.needed). */
  needed?: number;
}): number {
  const content = Math.max(input.natural, input.needed ?? 0);
  const base = input.fixedFrame && input.metaHeight ? input.metaHeight : input.natural;
  return Math.ceil(Math.max(base, content));
}

// ── A document ──────────────────────────────────────────────────────────────────────────────────

/** Headings that end a printed page with nothing after them on it: they belong with their text. */
export function pageBreakNotes(input: {
  file: string;
  title: string;
  inspection: Inspection | null;
  pageHeight: number;
  /** The room a heading needs under it for a line of text to follow, in px. */
  room?: number;
}): Finding[] {
  const { inspection, pageHeight } = input;
  const room = input.room ?? 32;
  if (!inspection?.headings?.length) return [];
  const stranded = inspection.headings.filter((heading) => {
    const end = Math.ceil((heading.top + heading.height - 0.5) / pageHeight) * pageHeight;
    const left = end - (heading.top + heading.height);
    // Something follows it in the document, and no line of it fits on this page.
    return left < room && heading.top + heading.height < inspection.height - 8;
  });
  if (!stranded.length) return [];
  return [
    {
      code: 'page_break_inside',
      file: input.file,
      board: input.title,
      ...(stranded[0].layer ? { layer: stranded[0].layer } : {}),
      label: `${input.title} ends a printed page on a heading`,
      detail: stranded
        .slice(0, 3)
        .map(
          (heading) =>
            `"${heading.text}" on page ${Math.floor((heading.top + heading.height - 0.5) / pageHeight) + 1}`,
        )
        .join(', '),
      short: 'heading ends a page',
      fix: 'keep the heading with the text after it: break-after: avoid on headings',
    },
  ];
}

/** The height a document board says, in its head or canvas.json, when it is not the height drawn. */
export function measuredHeightProblem(input: {
  file: string;
  title: string;
  measured: number;
  canvasHeight: number | undefined;
  metaHeight: number | null;
}): Finding | null {
  const declared = [input.metaHeight, input.canvasHeight].filter(
    (height): height is number => Boolean(height) && Math.abs(height! - input.measured) > 1,
  );
  if (!declared.length) return null;
  return {
    code: 'height_differs',
    file: input.file,
    board: input.title,
    label: `${input.title} is ${input.measured} px tall as drawn, not ${[...new Set(declared)].join(' or ')}`,
    detail: `its head says ${input.metaHeight ?? 'nothing'}, canvas.json ${input.canvasHeight ?? 'nothing'}; a document is as tall as it reads`,
    short: 'height differs',
    fix: 'deploy design check --fix measures the board and writes both',
  };
}

// ── A fixed frame ───────────────────────────────────────────────────────────────────────────────

/** A slide, a card, a window or a screen with more in it than its frame holds. */
export function tallerThanFrameProblem(input: {
  file: string;
  title: string;
  content: number;
  frame: number;
}): Finding | null {
  if (input.content <= input.frame + 1) return null;
  return {
    code: 'taller_than_frame',
    file: input.file,
    board: input.title,
    label: `${input.title} runs ${input.content - input.frame} px past its frame`,
    detail: `${input.content} px of content in a frame ${input.frame} px tall`,
    short: 'taller than its frame',
    fix: 'take something out or make it smaller so everything shows inside the frame',
  };
}
