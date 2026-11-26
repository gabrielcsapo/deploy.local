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
/** Pages as they print at 96 dpi. */
export const pageSizes: Record<string, { w: number; h: number; label: string }> = {
  a4: { w: 794, h: 1123, label: 'A4' },
  letter: { w: 816, h: 1056, label: 'Letter' },
};
/** The sizes a logo is checked at, largest first. */
export const logoSizes = [512, 128, 64, 32, 16];

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
  | { kind: 'pages'; pageWidth: number; pageHeight: number }
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
  | { kind: 'sheet'; sizes: number[] };

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
  const width = Number(placed.w) || meta.width || null;
  const height = Number(placed.h) || meta.height || null;
  switch (platform) {
    case 'mac':
      return { width: width ?? 1280, height: height ?? 800 };
    case 'slide':
      return { width: width ?? 1920, height: height ?? 1080 };
    case 'print': {
      const geometry = printGeometry(meta);
      return { width: width ?? geometry.width, height: height ?? geometry.height };
    }
    case 'game':
      // device=phone (or nothing said) is a phone's screen; else the width and height it gives.
      return { width: width ?? 390, height: height ?? (width && width > 500 ? 600 : 844) };
    case 'logo':
      return { width: width ?? 1024, height: height ?? 1024 };
    case 'doc':
      // The canvas shows a document at its first reading width, as tall as it reads.
      return { width: width ?? 700, height };
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
export function drawSteps(
  platform: string,
  meta: BoardMeta,
  placed: PlacedSize = {},
): DrawStep[] {
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
      return [screen(frame.width, frame.height, { measure: true, inspect: true })];
    case 'logo':
      return [
        screen(frame.width, frame.height, {
          mode: 'sheet',
          measure: true,
          inspect: true,
          shown: logoSizes.reduce((sum, size) => sum + size + 24, 24),
          layout: { kind: 'sheet', sizes: logoSizes },
        }),
      ];
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
      return `reading at 700 and 390 (as tall as it reads), printed pages at ${page.label} ${page.w}×${page.h}`;
    }
    case 'print': {
      const geometry = printGeometry(meta);
      return `${geometry.trim.w}×${geometry.trim.h} mm trim, ${geometry.bleed} mm bleed, ${geometry.safe} mm safe, at ${PRINT_PX_PER_MM} px/mm`;
    }
    case 'logo':
      return `${frame.width}×${frame.height}, then the mark at ${logoSizes.join(', ')} px`;
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
