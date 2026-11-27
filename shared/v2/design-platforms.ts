// What kind of artifact a board is, and what `deploy design check` draws for it. A board's head
// names its platform (<meta name="design-board" content="platform=slide,width=1920,height=1080">);
// this file is the one place that says, for each platform, its size, the schemes it draws by
// default, how it is pictured (one drawing in a step, with its width, height, scale and media), and
// which of the check's app-only notes apply. The check, `guide`, `status` and `export` all read it.
import { reviewWidths } from './design-review.ts';
import { boardPlatform, type BoardMeta } from './design-board-meta.ts';

export type Scheme = 'light' | 'dark';

/** CSS pixels in a millimetre (96 per inch). */
export const CSS_PX_PER_MM = 96 / 25.4;
/** How sharply a print piece is drawn in the check's pictures. */
export const PRINT_PX_PER_MM = 8;
/** The slug round a print piece's bleed that holds its crop marks, in millimetres. */
export const PRINT_SLUG_MM = 5;
/** Pages as they print at 96 dpi. */
export const pageSizes: Record<string, { w: number; h: number; label: string }> = {
  a4: { w: 794, h: 1123, label: 'A4' },
  letter: { w: 816, h: 1056, label: 'Letter' },
};
/** The sizes a logo is checked at, largest first. */
export const logoSizes = [512, 128, 64, 32, 24, 16];

export type PlatformInfo = {
  id: string;
  /** The schemes a board of this platform draws unless the project or its head says otherwise. */
  schemes: Scheme[];
  /** The schemes it can be drawn in at all (a printed card has no dark). */
  supports: Scheme[];
  /** The check's app-only notes (aligned edges, list rows, boxes in cards, local copies, one primary). */
  appChecks: boolean;
  /** Where its type scale lives in tokens.css: --text-<scale>-*. Null for web's plain --text-*. */
  scale: string | null;
  /** The scale to use when the design system has none of its own. */
  scaleFallback: string | null;
  /** Whether it is judged by a type scale at all. */
  typed: boolean;
  /** Fixed frame: content taller than its size is cut, not scrolled. */
  fixedFrame: boolean;
};

const both: Scheme[] = ['light', 'dark'];
const info = (
  id: string,
  extra: Partial<Omit<PlatformInfo, 'id'>> = {},
): [string, PlatformInfo] => [
  id,
  {
    id,
    schemes: both,
    supports: both,
    appChecks: true,
    scale: null,
    scaleFallback: null,
    typed: true,
    fixedFrame: false,
    ...extra,
  },
];

const table = new Map<string, PlatformInfo>([
  info('web'),
  info('tablet'),
  info('tv'),
  info('phone', { scale: 'phone' }),
  info('mac', { scale: 'mac', fixedFrame: true }),
  info('slide', {
    schemes: ['light'],
    appChecks: false,
    scale: 'slide',
    fixedFrame: true,
  }),
  info('doc', { scale: 'doc' }),
  info('print', {
    schemes: ['light'],
    supports: ['light'],
    appChecks: false,
    scale: 'print',
    fixedFrame: true,
  }),
  info('game', {
    appChecks: false,
    scale: 'game',
    scaleFallback: 'phone',
    fixedFrame: true,
  }),
  info('logo', { appChecks: false, typed: false, fixedFrame: true }),
  info('art', {
    schemes: ['light'],
    supports: ['light'],
    appChecks: false,
    typed: false,
    fixedFrame: true,
  }),
  info('model', {
    schemes: ['light'],
    supports: ['light'],
    appChecks: false,
    typed: false,
    fixedFrame: true,
  }),
]);

/** What the check knows about a platform; one the check has not heard of is drawn like the web. */
export const platformInfo = (platform: string | null | undefined): PlatformInfo =>
  table.get(platform ?? 'web') ?? table.get('web')!;

/** Every platform that has its own drawing. */
export const knownPlatforms = [...table.keys()];

/**
 * The schemes a board is drawn in: what the project's canvas.json says ("schemes"), else the
 * platform's defaults, kept to what the platform supports; a board's own head wins for the board.
 */
export function platformSchemes(platform: string | null | undefined, project?: Scheme[] | null) {
  const platformInformation = platformInfo(platform);
  const wanted = project?.length ? project : platformInformation.schemes;
  const kept = wanted.filter((scheme) => platformInformation.supports.includes(scheme));
  return kept.length ? kept : platformInformation.schemes;
}

/** Millimetres from "3mm", "3 mm" or "3". */
export function parseMm(value: string | null | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*$/i.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/** { w, h } in millimetres from "85x55mm" (x or ×). */
export function parseSizeMm(value: string | null | undefined): { w: number; h: number } | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*$/i.exec(value ?? '');
  return match ? { w: Number(match[1]), h: Number(match[2]) } : null;
}

/**
 * A sprite sheet's grid: the tile its art is drawn on, in art pixels (tile=16), and how many CSS
 * px a tile is drawn at in play (play=48); 16 and three times the tile when it says nothing.
 */
export function artGeometry(meta: Pick<BoardMeta, 'other'>) {
  const tile = Math.max(1, Math.round(Number(meta.other?.tile) || 16));
  const play = Number(meta.other?.play) > 0 ? Number(meta.other.play) : tile * 3;
  return { tile, play, zoom: play / tile };
}

/** The page size a document board says (a4 unless it says letter). */
export const docPage = (meta: Pick<BoardMeta, 'page'>) =>
  pageSizes[meta.page ?? 'a4'] ?? pageSizes.a4;

/** A print piece's trim, bleed and safe margin in millimetres; 85x55, 3 and 4 when it says nothing. */
export function printGeometry(meta: Pick<BoardMeta, 'size' | 'bleed' | 'safe'>) {
  const trim = parseSizeMm(meta.size) ?? { w: 85, h: 55 };
  const bleed = parseMm(meta.bleed) ?? 3;
  const safe = parseMm(meta.safe) ?? 4;
  const px = (mm: number) => Math.round(mm * CSS_PX_PER_MM);
  return {
    trim,
    bleed,
    safe,
    /** The drawn page: trim plus bleed on every side, in CSS px. */
    width: px(trim.w + 2 * bleed),
    height: px(trim.h + 2 * bleed),
    /** The drawn page's size in millimetres. */
    widthMm: trim.w + 2 * bleed,
    heightMm: trim.h + 2 * bleed,
  };
}

/** How a pair's picture is laid out beyond Before beside After. */
export type PairLayout =
  /** A tall render cut into the pages it prints on. */
  | {
      kind: 'pages';
      pageWidth: number;
      pageHeight: number;
      /** What each sheet leaves round the text (the board's @page margin), in px. */
      margin?: { top: number; right: number; bottom: number; left: number };
    }
  /** A print piece with its trim, bleed and safe margins drawn outside it. */
  | {
      kind: 'print';
      pxPerMm: number;
      /** Millimetres. */
      trim: { w: number; h: number };
      bleed: number;
      safe: number;
    }
  /** A mark at the sizes it is used at. */
  | { kind: 'sheet'; sizes: number[] }
  /** A sprite sheet, then each sprite at play size on each ground it is played on. */
  | { kind: 'art'; tile: number; play: number };

/** One drawing of a board: a size, and what is measured and pictured there. */
export type DrawStep = {
  /** The number in the picture's name, <Board>-<key>-<scheme>.png. */
  key: number;
  mode: 'screen' | 'pages' | 'print' | 'sheet';
  /** The page's width in CSS px. */
  width: number;
  /** The page's height; null when the board is as tall as its content. */
  height: number | null;
  /** The schemes drawn here; null for the board's own. */
  schemes: Scheme[] | null;
  /** Device pixels per CSS pixel. */
  scale: number;
  media?: 'print';
  /** Whether what leaves the page sideways is measured (in light). */
  measure: boolean;
  /** Whether contrast and taste are read here. */
  inspect: boolean;
  /** The picture's drawn width, for captions. */
  shown: number;
  layout?: PairLayout;
};

export type PlacedSize = { w?: number; h?: number };

/** The board's frame: the size its platform draws it in unless its canvas place or head says. */
export function boardFrame(
  platform: string,
  meta: Pick<BoardMeta, 'width' | 'height' | 'size' | 'bleed' | 'safe' | 'device' | 'page'>,
  placed: PlacedSize = {},
): { width: number; height: number | null } {
  const fromPlace = { width: Number(placed.w) || null, height: Number(placed.h) || null };
  // Web and phone boards take the canvas's size first, as they always have; a slide, a window, a
  // screen or a mark is the size its head says, whatever the canvas holds.
  const first = ['web', 'phone', 'tablet', 'tv'].includes(platform) || !platform;
  const width = first ? fromPlace.width || meta.width : meta.width;
  const height = first ? fromPlace.height || meta.height : meta.height;
  switch (platform) {
    case 'mac':
      return { width: width ?? 1280, height: height ?? 800 };
    case 'slide':
      return { width: width ?? 1920, height: height ?? 1080 };
    case 'print': {
      // The trim, bleed and safe margin in the head are the size; nothing else can disagree.
      const geometry = printGeometry(meta);
      return { width: geometry.width, height: geometry.height };
    }
    case 'game':
      // device=phone (or nothing said) is a phone's screen; else the width and height it gives.
      return { width: width ?? 390, height: height ?? (width && width > 500 ? 600 : 844) };
    case 'logo':
      return { width: width ?? 1024, height: height ?? 1024 };
    case 'art':
      return { width: width ?? 1280, height: height ?? 960 };
    case 'model':
      return { width: width ?? 1280, height: height ?? 720 };
    case 'doc':
      // The canvas shows a document at its first reading width, as tall as it reads.
      return { width: 700, height: fromPlace.height || meta.height || null };
    case 'phone':
      return { width: width ?? 390, height: height ?? 844 };
    default:
      return { width: width ?? 1440, height: height ?? 900 };
  }
}

/** The platform a board says it is, else what its width suggests. */
export const platformOfBoard = (meta: BoardMeta, placed: PlacedSize = {}) =>
  boardPlatform(meta, Number(placed.w) || undefined);

/** How a board is drawn: each size, in the order of its pictures. */
export function drawSteps(platform: string, meta: BoardMeta, placed: PlacedSize = {}): DrawStep[] {
  const frame = boardFrame(platform, meta, placed);
  const screen = (width: number, height: number | null, extra: Partial<DrawStep> = {}) =>
    ({
      key: width,
      mode: 'screen',
      width,
      height,
      schemes: null,
      scale: 1,
      measure: false,
      inspect: false,
      shown: width,
      ...extra,
    }) satisfies DrawStep;
  switch (platform) {
    case 'mac':
    case 'slide':
    case 'game':
    case 'model':
      return [screen(frame.width, frame.height, { measure: true, inspect: true })];
    case 'logo':
      return [
        screen(frame.width, frame.height, {
          mode: 'sheet',
          measure: true,
          inspect: true,
          layout: { kind: 'sheet', sizes: logoSizes },
        }),
      ];
    case 'art': {
      const { tile, play } = artGeometry(meta);
      return [
        screen(frame.width, frame.height, {
          measure: true,
          inspect: true,
          layout: { kind: 'art', tile, play },
        }),
      ];
    }
    case 'print': {
      const geometry = printGeometry(meta);
      const scale = PRINT_PX_PER_MM / CSS_PX_PER_MM;
      return [
        screen(frame.width, frame.height, {
          key: Math.round(geometry.widthMm * PRINT_PX_PER_MM),
          mode: 'print',
          scale,
          measure: true,
          inspect: true,
          shown: Math.round(geometry.widthMm * PRINT_PX_PER_MM),
          layout: {
            kind: 'print',
            pxPerMm: PRINT_PX_PER_MM,
            trim: geometry.trim,
            bleed: geometry.bleed,
            safe: geometry.safe,
          },
        }),
      ];
    }
    case 'doc': {
      const page = docPage(meta);
      return [
        screen(700, null, { inspect: true }),
        screen(390, null, { measure: true }),
        screen(page.w, null, {
          mode: 'pages',
          media: 'print',
          schemes: ['light'],
          inspect: true,
          layout: { kind: 'pages', pageWidth: page.w, pageHeight: page.h },
        }),
      ];
    }
    default: {
      const widths = reviewWidths(frame.width);
      return widths.map((width, at) =>
        screen(width, frame.height, { measure: width === 700, inspect: at === 0 }),
      );
    }
  }
}

/** What `guide` and `status` say a board is drawn at: "1440 and 700", "1920×1080", "85×55 mm …". */
export function drawnAt(platform: string, meta: BoardMeta, placed: PlacedSize = {}) {
  const steps = drawSteps(platform, meta, placed);
  const frame = boardFrame(platform, meta, placed);
  switch (platform) {
    case 'doc': {
      const page = docPage(meta);
      return `700 and 390 (as tall as it reads), then the printed pages at ${page.label} ${page.w}×${page.h}`;
    }
    case 'print': {
      const geometry = printGeometry(meta);
      return `${geometry.trim.w}×${geometry.trim.h} mm trim, ${geometry.bleed} mm bleed, ${geometry.safe} mm safe, at ${PRINT_PX_PER_MM} px/mm`;
    }
    case 'logo':
      return `${frame.width}×${frame.height}, then the mark at ${logoSizes.join(', ')} px`;
    case 'art': {
      const { tile, play } = artGeometry(meta);
      return `${frame.width}×${frame.height}, then each sprite at play size (a ${tile} px tile at ${play} px) on each ground`;
    }
    case 'model':
      return `${frame.width}×${frame.height}, the model drawn in Blender from the front, side, three-quarter and top, in its box`;
    case 'mac':
    case 'slide':
    case 'game':
      return `${frame.width}×${frame.height}`;
    default:
      return [...new Set(steps.map((step) => step.width))].join(' and ');
  }
}

/** The planned sizes' widths, for a board's status. */
export const stepWidths = (steps: DrawStep[]) => [...new Set(steps.map((step) => step.width))];

/** What a project makes, as `deploy design init --kind` names it, and the platforms its boards are. */
export const designKinds: Record<string, { platforms: string[]; schemes: Scheme[] }> = {
  app: { platforms: ['web', 'phone'], schemes: ['light', 'dark'] },
  doc: { platforms: ['doc'], schemes: ['light', 'dark'] },
  slides: { platforms: ['slide'], schemes: ['light'] },
  print: { platforms: ['print'], schemes: ['light'] },
  mac: { platforms: ['mac'], schemes: ['light', 'dark'] },
  game: { platforms: ['game'], schemes: ['light', 'dark'] },
  logo: { platforms: ['logo'], schemes: ['light', 'dark'] },
  art: { platforms: ['art'], schemes: ['light'] },
  model: { platforms: ['model'], schemes: ['light'] },
};

/** The platform a new board of a project's kind is, when its name says no other. */
export const kindPlatform = (kind: string | null | undefined) =>
  designKinds[kind ?? 'app']?.platforms[0] ?? 'web';

/**
 * The paper a board is exported on: its own size (a slide, a window, a screen), trim plus bleed
 * for a print piece, the page size for a document, which then runs over as many pages as it needs.
 */
export function exportPage(
  platform: string,
  meta: BoardMeta,
  placed: PlacedSize = {},
  options: { marks?: boolean } = {},
) {
  const frame = boardFrame(platform, meta, placed);
  if (platform === 'doc') {
    const page = docPage(meta);
    return {
      width: page.w,
      height: 100,
      paperWidth: page.w,
      paperHeight: page.h,
      fixed: false,
      /** The board's own @page size and margins decide the sheets, as a printer would have them. */
      css: true,
    };
  }
  if (platform === 'print') {
    const geometry = printGeometry(meta);
    if (options.marks) {
      // Trim plus bleed plus a slug of 5 mm each side, with crop marks in the slug.
      const px = (mm: number) => mm * CSS_PX_PER_MM;
      const slug = PRINT_SLUG_MM;
      const width = Math.round(px(geometry.widthMm + 2 * slug));
      const height = Math.round(px(geometry.heightMm + 2 * slug));
      return {
        width,
        height,
        paperWidth: width,
        paperHeight: height,
        fixed: true,
        cropMarks: {
          slug: px(slug),
          bleed: px(geometry.bleed),
          trimW: px(geometry.trim.w),
          trimH: px(geometry.trim.h),
        },
      };
    }
    return {
      width: frame.width,
      height: frame.height ?? geometry.height,
      paperWidth: geometry.widthMm * CSS_PX_PER_MM,
      paperHeight: geometry.heightMm * CSS_PX_PER_MM,
      fixed: true,
    };
  }
  const height = frame.height ?? 900;
  return { width: frame.width, height, paperWidth: frame.width, paperHeight: height, fixed: true };
}
