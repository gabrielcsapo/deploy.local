// A board's head says what it is: <meta name="design-board" content="…">. Old boards give only
// their size (width=1440,height=900); newer ones may add platform=, schemes=, replaces=, source=,
// copied_from= and title=, separated by commas or semicolons. A part with no "=" belongs to the value before
// it, so a title can read "Inbox, phone".

export type BoardPlatform = 'web' | 'phone' | 'tablet' | 'mac' | 'tv' | 'slide' | string;

export type BoardMeta = {
  width: number | null;
  height: number | null;
  platform: BoardPlatform | null;
  schemes: ('light' | 'dark')[] | null;
  /** The first board this one replaced; `replacesAll` has every one (space-separated). */
  replaces: string | null;
  replacesAll: string[];
  source: string | null;
  /** The board this one was copied from, when it is not drawn from it as a source. */
  copiedFrom: string | null;
  title: string | null;
  /** Keys this reader does not know, kept as written. */
  other: Record<string, string>;
};

const metaPattern = /<meta\b(?=[^>]*\sname="design-board")[^>]*\scontent="([^"]*)"[^>]*>/i;

/** The board's own file name for a value like "PipelineRun" or "PipelineRun.html". */
const boardFile = (value: string | undefined) => {
  const name = value?.trim();
  if (!name) return null;
  return /\.html$/.test(name) ? name : `${name}.html`;
};

/** The pairs in a design-board meta's content. */
export function metaPairs(content: string) {
  const parts = content.split(/[;,]/);
  const pairs: [string, string][] = [];
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at < 0) {
      // A comma inside a value: it belongs to the pair before it.
      if (pairs.length && part.trim()) pairs[pairs.length - 1][1] += `,${part}`;
      continue;
    }
    pairs.push([part.slice(0, at).trim().toLowerCase(), part.slice(at + 1)]);
  }
  return pairs.map(([key, value]) => [key, value.trim()] as [string, string]);
}

/** What a board's head says about it; every field is null when the board does not say. */
export function parseBoardMeta(html: string | null | undefined): BoardMeta {
  const meta: BoardMeta = {
    width: null,
    height: null,
    platform: null,
    schemes: null,
    replaces: null,
    replacesAll: [],
    source: null,
    copiedFrom: null,
    title: null,
    other: {},
  };
  const content = html ? metaPattern.exec(html)?.[1] : undefined;
  if (content === undefined) return meta;
  for (const [key, value] of metaPairs(content.replace(/&amp;/g, '&'))) {
    const number = Number(value);
    if (key === 'width' || key === 'height') {
      if (Number.isFinite(number) && number > 0) meta[key] = number;
    } else if (key === 'platform') meta.platform = value.toLowerCase() || null;
    else if (key === 'schemes') {
      const schemes = value
        .toLowerCase()
        .split(/[\s,+]+/)
        .filter((scheme): scheme is 'light' | 'dark' => scheme === 'light' || scheme === 'dark');
      meta.schemes = schemes.length ? [...new Set(schemes)] : null;
    } else if (key === 'replaces') {
      meta.replacesAll = value
        .split(/\s+/)
        .map(boardFile)
        .filter((file): file is string => Boolean(file));
      meta.replaces = meta.replacesAll[0] ?? null;
    } else if (key === 'source') meta.source = boardFile(value);
    else if (key === 'copied_from' || key === 'copied-from') meta.copiedFrom = boardFile(value);
    else if (key === 'title') meta.title = value || null;
    else meta.other[key] = value;
  }
  return meta;
}

/** Sizes by platform, when a board names one and no width. */
export const platformWidths: Record<string, number> = {
  web: 1440,
  phone: 390,
  tablet: 1024,
  mac: 1280,
  tv: 1920,
  slide: 1920,
};

/** The platform a board is drawn for: what it says, else what its width suggests. */
export function boardPlatform(meta: BoardMeta, canvasWidth?: number): string {
  if (meta.platform) return meta.platform;
  const width = meta.width ?? canvasWidth ?? 1440;
  return width <= 500 ? 'phone' : 'web';
}

/** The board's html with its meta's height set, adding a meta when it had none. */
export function setBoardMetaHeight(html: string, height: number, width = 1440) {
  const match = metaPattern.exec(html);
  if (!match) {
    const tag = `<meta name="design-board" content="width=${width},height=${height}">`;
    return /<meta charset[^>]*>/i.test(html)
      ? html.replace(/(<meta charset[^>]*>)/i, `$1\n${tag}`)
      : html.replace(/<head>/i, `<head>\n${tag}`);
  }
  const content = match[1];
  const separator = content.includes(';') ? ';' : ',';
  const replaced = /(^|[;,]\s*)height=\s*\d+/i.test(content)
    ? content.replace(/(^|[;,]\s*)height=\s*\d+/i, `$1height=${height}`)
    : `${content}${separator}${separator === ';' ? ' ' : ''}height=${height}`;
  return html.replace(match[0], match[0].replace(`content="${content}"`, `content="${replaced}"`));
}
