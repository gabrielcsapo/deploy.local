/**
 * Boards in design/ are plain HTML pages styled by the design system. Every element a person or an
 * agent can point at carries a stable `data-layer` ID, shared by Layers, selections, comments,
 * history and agent edits. This module converts canvas exports into that format and assigns IDs.
 */

export interface BoardSize {
  width: number;
  height: number;
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
// Elements that are never layers: structure outside the page body, and line breaks.
const NOT_LAYERS = new Set(['html', 'head', 'body', 'br', 'wbr', 'template']);

/** Turn a board exported from the claude.ai design canvas (`*.dc.html`) into a standalone page. */
export function convertCanvasBoard(source: string): { html: string; size: BoardSize | null } {
  let html = source;
  const props = /data-props='([^']*)'/.exec(html)?.[1];
  let size: BoardSize | null = null;
  if (props) {
    const preview = (JSON.parse(props) as { $preview?: Partial<BoardSize> }).$preview;
    if (preview?.width && preview?.height) size = { width: preview.width, height: preview.height };
  }
  html = html.replace(/<script type="text\/x-dc"[\s\S]*?<\/script>\s*/g, '');
  html = html.replace(/<script src="\.\/support\.js"><\/script>\s*/g, '');
  const helmet = /<helmet>([\s\S]*?)<\/helmet>\s*/.exec(html);
  if (helmet) {
    html = html.replace(helmet[0], '');
    html = html.replace('</head>', `${helmet[1].trim()}\n</head>`);
  }
  html = html.replace(/<x-dc>\s*/g, '').replace(/\s*<\/x-dc>/g, '');
  html = html.replace(/href="ds\//g, 'href="../ds/');
  html = html.replace(/href="([A-Za-z0-9_-]+)\.dc\.html/g, 'href="$1.html');
  if (size && !html.includes('name="design-board"'))
    html = html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8">\n<meta name="design-board" content="width=${size.width},height=${size.height}">`,
    );
  return { html, size };
}

function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .slice(0, 24)
    .replace(/-+$/, '');
}

function attribute(tag: string, name: string) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Words that are stand-ins, never a name: "to be confirmed", "placeholder", 00, one/two/three. */
const placeholderWords = new Set([
  'placeholder',
  'tbc',
  'tbd',
  'confirmed',
  'lorem',
  'ipsum',
  'sample',
  'dummy',
  'untitled',
  '0',
  '00',
  '000',
  'one',
  'two',
  'three',
]);
const isPlaceholder = (name: string) => {
  const words = name.split('-').filter(Boolean);
  return !words.length || words.some((word) => placeholderWords.has(word));
};
/** The text as a name, or '' when it is only a stand-in. */
function textSlug(text: string) {
  const name = slug(text);
  return name && !isPlaceholder(name) && !/to-be/.test(name) ? name : '';
}

/** What a tag is, when its tag says so: a landmark, a heading, a figure. */
const tagRoles: Record<string, string> = {
  nav: 'nav',
  header: 'header',
  footer: 'footer',
  main: 'main',
  aside: 'aside',
  section: 'section',
  article: 'article',
  figure: 'figure',
  blockquote: 'quote',
  form: 'form',
  table: 'table',
  ul: 'list',
  ol: 'list',
  li: 'item',
  tr: 'row',
  img: 'image',
  button: 'button',
  a: 'link',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};
/** Tags whose own words name them best (a button is its label, a heading its title). */
const wordsFirst = new Set(['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'summary']);

/**
 * What an element is, from its markup: a data-role, its aria-label, its component class (without
 * the ds- or dl- prefix), its landmark or semantic tag. Null when none says. `indexed` is whether
 * the name came from a class or data-role, which siblings of the same kind share.
 */
function roleOf(tag: string, name: string): { role: string; indexed: boolean } | null {
  const dataRole = slug(attribute(tag, 'data-role') ?? '');
  if (dataRole && !isPlaceholder(dataRole)) return { role: dataRole, indexed: true };
  const label = textSlug(attribute(tag, 'aria-label') ?? '');
  if (label) return { role: label, indexed: false };
  const firstClass = (attribute(tag, 'class') ?? '').split(/\s+/).find(Boolean) ?? '';
  const named = slug(firstClass.replace(/^(?:ds|dl)-/, ''));
  if (named && !isPlaceholder(named) && !/^(?:[a-z]|t|c|v|x)$/.test(named))
    return { role: named, indexed: true };
  return tagRoles[name] ? { role: tagRoles[name], indexed: name === 'li' || name === 'tr' } : null;
}

/** The name a layer gets from its markup alone: its role, its text, its first class, or its tag. */
function layerName(tag: string, name: string, text: string) {
  const own = textSlug(text);
  const role = roleOf(tag, name);
  if (wordsFirst.has(name) && own) return own;
  if (role) return role.role;
  if (own) return own;
  const firstClass = attribute(tag, 'class')?.split(/\s+/).find(Boolean);
  if (firstClass) return slug(firstClass.replace(/^dl-/, '')) || name;
  return name;
}

/** A list row: its children are named after it. */
const rowClass = /\b(dl-item|dl-ph-row|dl-setting|dl-log-row|dl-menu-item|dl-file|row|file)\b/;
/** Names that say nothing on their own: a letter, a tag, a generic word. */
const generic = new RegExp(
  '^(?:(?:[a-z]|t|c|v|x|on|off|end|start|layer|el|box|wrap|inner|outer|container|span|div|svg|path|g|p|a|i|b|em|strong|small|img|ul|ol|li|chev|glyph|grow)(?:-\\d+)?' +
    // A role is only generic bare: figure-1 and item-2 say which one.
    '|item|row|text|label|content|group|block|section|header|footer|main|nav|aside|button|figure|lead|meta)$',
);
/** What a value is: 212 KB is a size, 2m 58s a time, 5 a count. */
function valueKind(text: string) {
  const plain = text.replace(/&[a-z]+;/g, ' ').trim();
  if (
    !/^[\d.,:·\s+-]+\s*[a-z%]{0,6}(\s+[\d.,]+\s*[a-z]{0,3})*\.?$/i.test(plain) ||
    !/\d/.test(plain)
  )
    return null;
  if (/\d\s*(b|kb|mb|gb|tb|bytes?)$/i.test(plain)) return 'size';
  if (/\d\s*(ms|s|m|h|d|min|sec)\b/i.test(plain) || /\d:\d\d/.test(plain)) return 'time';
  if (/%$/.test(plain)) return 'percent';
  if (/^\d+$/.test(plain)) return 'count';
  return 'value';
}
/** The first words of an element's markup that are not a value: what a row is about. */
function mainText(outer: string) {
  for (const chunk of outer
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/gi, '<x>')
    .split(/<[^>]+>/)) {
    const text = chunk.replace(/\s+/g, ' ').trim();
    if (text && slug(text) && !valueKind(text)) return text;
  }
  return '';
}
const joinName = (...parts: string[]) =>
  parts.filter(Boolean).join('-').replace(/-+/g, '-').slice(0, 48).replace(/-+$/, '');

/**
 * Give every element in the body a unique `data-layer` ID. IDs already present are kept, so running
 * this again after an edit only names the new elements. SVG internals are part of their icon.
 *
 * A name says what the element is: a row is named for what it is about (a file row "report.xml"
 * is file-report-xml), what sits in it is named after it (file-report-xml-size,
 * file-report-xml-download), and a value or a name that says nothing alone (212 KB, an icon, a
 * letter) takes its nearest named ancestor's name with its role. Never a bare number.
 */
export function assignLayerIds(html: string): string {
  // A fragment without a body is all body.
  const bodyStart = Math.max(0, html.search(/<body[\s>]/));
  const used = new Set<string>();
  for (const match of html.matchAll(/\sdata-layer="([^"]*)"/g)) used.add(match[1]);
  const unique = (base: string) => {
    let id = base || 'layer';
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  // Each element's whole markup by where it starts, for a row's words.
  const scanned = scanElements(html);
  const outers = new Map(scanned.map((element) => [element.open, element.outer]));
  // Siblings that share a role (three figures in one box) are numbered, so each name is its own.
  const siblingNumber = new Map<number, number>();
  const groups = new Map<string, number[]>();
  scanned.forEach((element, at) => {
    const start = /^<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(element.outer);
    const found = start ? roleOf(start[0], start[1].toLowerCase()) : null;
    if (!found?.indexed) return;
    const key = `${element.parent}:${found.role}`;
    groups.set(key, [...(groups.get(key) ?? []), at]);
  });
  for (const members of groups.values())
    if (members.length > 1)
      members.forEach((at, position) => siblingNumber.set(scanned[at].open, position + 1));
  // The open elements: their names, IDs and whether they are rows.
  const open: { name: string; id: string | null; row: string | null; main: string }[] = [];

  let out = html.slice(0, bodyStart);
  let i = bodyStart;
  let svgDepth = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      const stop = end < 0 ? html.length : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    const end = html.indexOf('>', lt);
    if (end < 0) {
      out += html.slice(lt);
      break;
    }
    let tag = html.slice(lt, end + 1);
    i = end + 1;
    const closing = tag.startsWith('</');
    const name = /^<\/?([a-zA-Z][\w:-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (!name) {
      out += tag;
      continue;
    }
    if (closing) {
      if (name === 'svg' && svgDepth > 0) svgDepth--;
      const at = open.findLastIndex((entry) => entry.name === name);
      if (at >= 0) open.splice(at);
      out += tag;
      continue;
    }
    const selfClosing = tag.endsWith('/>');
    const existing = /\sdata-layer="([^"]*)"/.exec(tag)?.[1] ?? null;
    const isLayer = svgDepth === 0 && !NOT_LAYERS.has(name) && !existing;
    const row = [...open].reverse().find((entry) => entry.row);
    const context = [...open].reverse().find((entry) => entry.id && !generic.test(entry.id));
    const isRow = rowClass.test(attribute(tag, 'class') ?? '') || name === 'li' || name === 'tr';
    const outer = outers.get(lt) ?? tag;
    const about = isRow ? mainText(outer) : '';
    let id = existing;
    if (isLayer) {
      const next = html.indexOf('<', i);
      const text = html.slice(i, next < 0 ? undefined : next).trim();
      const label = attribute(tag, 'aria-label') ?? '';
      const kind = valueKind(label || text);
      let base: string;
      const listRow = name === 'li' || name === 'tr';
      if (isRow && about && !listRow && !isPlaceholder(slug(about))) {
        // A row: what it is about, and a file row says so.
        base = joinName(/\.[a-z0-9]{1,5}$/i.test(about) ? 'file' : '', slug(about));
      } else if (row?.id && !listRow) {
        // Inside a row: the row's name and the element's role in it.
        // Its own words, without the row's (a "Download report.xml" label is the download).
        const rowAbout = slug(row.main);
        const own = slug(text || label)
          .replace(new RegExp(`(^|-)${rowAbout}(-|$)`), '$1')
          .replace(/^-+|-+$/g, '');
        const firstClass = (attribute(tag, 'class') ?? '').split(/\s+/)[0] ?? '';
        const classRole = slug(firstClass.replace(/^dl-/, ''));
        const role =
          kind ??
          (slug(text || label) === rowAbout
            ? 'name'
            : own || (name === 'svg' ? 'icon' : classRole === 't' ? 'text' : classRole || name));
        base = joinName(row.id, role);
      } else {
        const plain = layerName(tag, name, text);
        const found = roleOf(tag, name);
        // A role from the markup (a class, a data-role) is the parent's name, then the role, then
        // which of its kind it is: budget-figure-2, and what is in it budget-figure-2-value.
        const fromRole =
          !kind && name !== 'svg' && Boolean(found?.indexed) && plain === found!.role;
        const number = siblingNumber.get(lt);
        const role = kind
          ? kind
          : name === 'svg'
            ? 'icon'
            : fromRole
              ? joinName(plain, number ? String(number) : '')
              : /^\d/.test(plain)
                ? 'value'
                : generic.test(plain)
                  ? plain
                  : null;
        // A value, an icon, a role or a name that says nothing alone takes its named ancestor's name.
        base = role ? (context?.id ? joinName(context.id, role) : role) : plain;
      }
      id = unique(base);
      tag = tag.replace(/^(<[a-zA-Z][\w:-]*)/, `$1 data-layer="${id}"`);
    }
    out += tag;
    if (!VOID.has(name) && !selfClosing && !RAW_TEXT.has(name))
      open.push({ name, id, row: isRow ? id : null, main: about });
    if (name === 'svg' && !selfClosing) svgDepth++;
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      const stop = close < 0 ? html.length : close;
      out += html.slice(i, stop);
      i = stop;
    }
    if (VOID.has(name) || selfClosing) continue;
  }
  return out;
}

/** The markup of one layer, start tag to matching end tag, or null when the board has no such layer. */
export function layerSnippet(html: string, layer: string): string | null {
  const start = html.indexOf(` data-layer="${layer}"`);
  if (start < 0) return null;
  const open = html.lastIndexOf('<', start);
  const name = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(open))?.[1]?.toLowerCase();
  if (!name) return null;
  const firstEnd = html.indexOf('>', start);
  if (VOID.has(name) || html[firstEnd - 1] === '/') return html.slice(open, firstEnd + 1);
  const tags = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, 'gi');
  tags.lastIndex = firstEnd + 1;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[1]) depth--;
    else if (!match[0].endsWith('/>')) depth++;
    if (depth === 0) return html.slice(open, match.index + match[0].length);
  }
  return null;
}

export type BoardElement = {
  /** The element's layer ID, or null when it has none. */
  layer: string | null;
  /** Its markup, start tag to matching end tag. */
  outer: string;
  /** The index of the element that contains it, or -1 at the top. */
  parent: number;
};

/**
 * Every element of a board, in document order, in one pass: its layer ID, its markup and the
 * element that contains it. Comments and the text of scripts and styles are skipped.
 */
export function boardElements(html: string): BoardElement[] {
  return scanElements(html).map(({ layer, outer, parent }) => ({ layer, outer, parent }));
}

/** boardElements, with where each start tag begins in the markup. */
function scanElements(html: string): (BoardElement & { open: number })[] {
  const found: (BoardElement & { open: number })[] = [];
  const stack: { index: number; name: string }[] = [];
  const finish = (entry: { index: number }, end: number) => {
    const element = found[entry.index];
    element.outer = html.slice(element.open, end);
  };
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    const end = match.index + match[0].length;
    if (match[1]) {
      const at = stack.findLastIndex((entry) => entry.name === name);
      if (at < 0) continue;
      // Elements left open inside this one end with it.
      for (const entry of stack.splice(at)) finish(entry, end);
      continue;
    }
    const layer = /\sdata-layer="([^"]*)"/.exec(match[0])?.[1] ?? null;
    const index = found.length;
    found.push({ layer, outer: match[0], parent: stack.at(-1)?.index ?? -1, open: match.index });
    if (VOID.has(name) || match[3].endsWith('/')) continue;
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, end);
      const stop = close < 0 ? html.length : html.indexOf('>', close) + 1 || html.length;
      found[index].outer = html.slice(match.index, stop);
      pattern.lastIndex = stop;
      continue;
    }
    stack.push({ index, name });
  }
  for (const entry of stack) finish(entry, html.length);
  return found;
}

const tagOf = (outer: string) => /^<([a-zA-Z][\w:-]*)/.exec(outer)?.[1]?.toLowerCase() ?? '';
const classOf = (outer: string) =>
  (/^<[^>]*\sclass="([^"]*)"/.exec(outer)?.[1] ?? '').trim().split(/\s+/).sort().join(' ');
const wordsOf = (outer: string) =>
  outer
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
/** Markup without layer IDs or formatting: the same element gives the same text. */
const signatureOf = (outer: string) =>
  outer
    .replace(/\sdata-layer="[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Each layer ID `main` has and `branch` does not, with the branch element that still draws it:
 * the same markup, or the same tag with the same words, or the same tag and class in the same
 * place. Matching goes from the surest to the loosest, and a branch element answers for one ID at
 * most. `at` is that element's index in boardElements(branch), or null when nothing draws it.
 */
export function matchLayers(
  main: string,
  branch: string,
): { layer: string; at: number | null; to: string | null }[] {
  const mainElements = boardElements(main);
  const branchElements = boardElements(branch);
  const branchIds = new Set(branchElements.map((element) => element.layer).filter(Boolean));
  const mainIds = new Set(mainElements.map((element) => element.layer).filter(Boolean));
  const gone = mainElements
    .map((element, index) => ({ ...element, index }))
    .filter((element) => element.layer && !branchIds.has(element.layer));
  if (!gone.length) return [];
  // Branch elements that could be one of them: no ID, or an ID main does not have.
  const free = branchElements
    .map((element, index) => ({ ...element, index }))
    .filter((element) => !element.layer || !mainIds.has(element.layer));
  const taken = new Set<number>();
  const found = new Map<string, (typeof free)[number]>();
  // Where an element sits: its nearest ancestor with an ID both boards share, and its place
  // among that ancestor's descendants of the same tag.
  const place = (elements: BoardElement[], index: number) => {
    let parent = elements[index].parent;
    while (parent >= 0 && !(elements[parent].layer && branchIds.has(elements[parent].layer!)))
      parent = elements[parent].parent;
    const anchor = parent >= 0 ? elements[parent].layer : '';
    const tag = tagOf(elements[index].outer);
    let nth = 0;
    for (let at = parent + 1; at < index; at++) {
      let up = elements[at].parent;
      while (up > parent) up = elements[up].parent;
      if (up === parent && tagOf(elements[at].outer) === tag) nth++;
    }
    return `${anchor} ${tag} ${nth}`;
  };
  const passes: ((a: (typeof gone)[number], b: (typeof free)[number]) => boolean)[] = [
    (a, b) => signatureOf(a.outer) === signatureOf(b.outer),
    (a, b) => {
      const text = wordsOf(a.outer);
      return Boolean(text) && tagOf(a.outer) === tagOf(b.outer) && text === wordsOf(b.outer);
    },
    (a, b) =>
      tagOf(a.outer) === tagOf(b.outer) &&
      classOf(a.outer) === classOf(b.outer) &&
      place(mainElements, a.index) === place(branchElements, b.index),
  ];
  for (const same of passes)
    for (const element of gone) {
      if (found.has(element.layer!)) continue;
      const match = free.find(
        (candidate) => !taken.has(candidate.index) && same(element, candidate),
      );
      if (!match) continue;
      taken.add(match.index);
      found.set(element.layer!, match);
    }
  return gone.map((element) => {
    const match = found.get(element.layer!);
    return { layer: element.layer!, at: match?.index ?? null, to: match?.layer ?? null };
  });
}

/**
 * `after` with each of `before`'s layer IDs back on the element that still draws it, so comments
 * and pins keep pointing at it. IDs `after` gave those elements are dropped.
 */
export function carryLayerIds(before: string, after: string): string {
  // An ID put back can anchor where the next one sits, so carry until nothing moves.
  let out = after;
  for (let round = 0; round < 8; round++) {
    const next = carryOnce(before, out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function carryOnce(before: string, after: string): string {
  const matches = matchLayers(before, after).filter((match) => match.at !== null);
  if (!matches.length) return after;
  const elements = scanElements(after);
  let out = after;
  for (const match of matches.sort((a, b) => elements[b.at!].open - elements[a.at!].open)) {
    const { open } = elements[match.at!];
    const end = out.indexOf('>', open);
    const tag = out.slice(open, end + 1);
    const next = / data-layer="[^"]*"/.test(tag)
      ? tag.replace(/ data-layer="[^"]*"/, ` data-layer="${match.layer}"`)
      : tag.replace(/^(<[a-zA-Z][\w:-]*)/, `$1 data-layer="${match.layer}"`);
    out = out.slice(0, open) + next + out.slice(end + 1);
  }
  return out;
}

/** Every `data-layer` ID in a board, in document order. */
export function layerIds(html: string): string[] {
  return [...html.matchAll(/\sdata-layer="([^"]*)"/g)].map((match) => match[1]);
}

type LayerState = { tag: string; attrs: Map<string, string>; text: string };

/** Each layer's tag, attributes and own leading text, by ID. */
function layerStates(html: string) {
  const states = new Map<string, LayerState>();
  for (const match of html.matchAll(
    /<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>([^<]*)/g,
  )) {
    const attrs = new Map<string, string>();
    for (const attr of match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g))
      attrs.set(attr[1], attr[2] ?? '');
    const id = attrs.get('data-layer');
    if (!id) continue;
    attrs.delete('data-layer');
    states.set(id, {
      tag: match[1].toLowerCase(),
      attrs,
      text: match[3].replace(/\s+/g, ' ').trim(),
    });
  }
  return states;
}

function styles(style = '') {
  const out = new Map<string, string>();
  for (const part of style.split(';')) {
    const at = part.indexOf(':');
    if (at > 0) out.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return out;
}

const quote = (text: string) => `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;

export type LayerChange = {
  layer: string;
  change: 'added' | 'removed' | 'changed';
  details: string[];
};

/**
 * What changed between two versions of a board, layer by layer: text, inline styles, classes
 * and other attributes, plus layers added or removed. Reviewers read this instead of a file diff.
 */
export function layerChanges(before: string, after: string, limit = 40): LayerChange[] {
  const was = layerStates(before);
  const now = layerStates(after);
  const changes: LayerChange[] = [];
  for (const [layer, state] of now) {
    const old = was.get(layer);
    if (!old) {
      changes.push({
        layer,
        change: 'added',
        details: state.text ? [`Text ${quote(state.text)}`] : [],
      });
      continue;
    }
    const details: string[] = [];
    if (old.text !== state.text) details.push(`Text ${quote(old.text)} → ${quote(state.text)}`);
    const oldStyle = styles(old.attrs.get('style'));
    const newStyle = styles(state.attrs.get('style'));
    for (const [name, value] of newStyle)
      if (oldStyle.get(name) !== value)
        details.push(
          oldStyle.has(name) ? `${name} ${oldStyle.get(name)} → ${value}` : `${name} ${value}`,
        );
    for (const name of oldStyle.keys()) if (!newStyle.has(name)) details.push(`${name} removed`);
    const oldClasses = new Set((old.attrs.get('class') ?? '').split(/\s+/).filter(Boolean));
    const newClasses = new Set((state.attrs.get('class') ?? '').split(/\s+/).filter(Boolean));
    const added = [...newClasses].filter((name) => !oldClasses.has(name));
    const removed = [...oldClasses].filter((name) => !newClasses.has(name));
    if (added.length || removed.length)
      details.push(
        ['Class', ...added.map((name) => `+${name}`), ...removed.map((name) => `−${name}`)].join(
          ' ',
        ),
      );
    for (const [name, value] of state.attrs)
      if (!['style', 'class'].includes(name) && old.attrs.get(name) !== value)
        details.push(
          `${name} ${old.attrs.has(name) ? `${quote(old.attrs.get(name)!)} → ` : ''}${quote(value)}`,
        );
    if (old.tag !== state.tag) details.push(`${old.tag} → ${state.tag}`);
    if (details.length) changes.push({ layer, change: 'changed', details });
  }
  for (const layer of was.keys())
    if (!now.has(layer)) changes.push({ layer, change: 'removed', details: [] });
  return changes.slice(0, limit);
}

export type BoardEdit =
  | { op: 'text'; layer: string; text: string }
  | { op: 'style'; layer: string; prop: string; value: string | null }
  | { op: 'class'; layer: string; add?: string[]; remove?: string[] }
  /** Back to main: the whole layer, or only the named style properties (and its text, with `text`). */
  | { op: 'revert'; layer: string; props?: string[]; text?: boolean }
  /**
   * Draw a new layer, or place a design-system component as an instance. Without `parent` it sits
   * on the board at its X and Y; with one it joins that stack at `index`.
   */
  | {
      op: 'insert';
      parent?: string;
      index?: number;
      shape?: DrawnShape;
      component?: { id: string; props?: Record<string, string>; x?: number; y?: number };
    }
  | { op: 'remove'; layer: string }
  /** Where a click on the layer goes: another board, or nowhere (null). */
  | { op: 'link'; layer: string; to: string | null };

/** What the drawing tools make, in board pixels. The server writes the markup. */
export type DrawnShape =
  | { kind: 'rectangle' | 'ellipse' | 'frame'; x: number; y: number; w: number; h: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'text'; x: number; y: number; text: string }
  | { kind: 'vector'; points: [number, number][]; closed?: boolean };

const coordinate = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 20000) throw new Error('A shape is out of bounds');
  return Math.round(n * 10) / 10;
};
const absolute = (x: number, y: number) => `position:absolute;left:${x}px;top:${y}px`;

/** The markup for a drawn shape: positioned where it was drawn, styled with design-system tokens. */
export function shapeMarkup(shape: DrawnShape): string {
  if (shape.kind === 'rectangle' || shape.kind === 'ellipse' || shape.kind === 'frame') {
    const [x, y] = [coordinate(shape.x), coordinate(shape.y)];
    const [w, h] = [Math.max(1, coordinate(shape.w)), Math.max(1, coordinate(shape.h))];
    const box = `${absolute(x, y)};width:${w}px;height:${h}px;box-sizing:border-box`;
    if (shape.kind === 'frame')
      return `<div data-name="Frame" style="${box};background:var(--surface)"></div>`;
    const radius = shape.kind === 'ellipse' ? '50%' : 'var(--radius-card)';
    const name = shape.kind === 'ellipse' ? 'Ellipse' : 'Rectangle';
    return `<div data-name="${name}" style="${box};background:var(--surface);border:1px solid var(--line);border-radius:${radius}"></div>`;
  }
  if (shape.kind === 'text') {
    const text = String(shape.text ?? '').slice(0, 2000) || 'Text';
    return `<p data-name="Text" style="${absolute(coordinate(shape.x), coordinate(shape.y))};margin:0;font-family:var(--font-sans);font-size:15px;line-height:24px;font-weight:400;color:var(--ink);white-space:pre">${escapeText(text)}</p>`;
  }
  const points =
    shape.kind === 'line'
      ? [
          [shape.x1, shape.y1],
          [shape.x2, shape.y2],
        ]
      : (shape as { points: [number, number][] }).points;
  if (!Array.isArray(points) || points.length < 2 || points.length > 500)
    throw new Error('A vector needs 2 to 500 points');
  const xy = points.map(([px, py]) => [coordinate(px), coordinate(py)]);
  const left = Math.min(...xy.map(([px]) => px));
  const top = Math.min(...xy.map(([, py]) => py));
  const w = Math.max(1, Math.max(...xy.map(([px]) => px)) - left);
  const h = Math.max(1, Math.max(...xy.map(([, py]) => py)) - top);
  const d =
    xy
      .map(
        ([px, py], i) =>
          `${i ? 'L' : 'M'}${Math.round((px - left) * 10) / 10} ${Math.round((py - top) * 10) / 10}`,
      )
      .join(' ') + (shape.kind === 'vector' && shape.closed ? ' Z' : '');
  const name = shape.kind === 'line' ? 'Line' : 'Vector';
  return `<svg data-name="${name}" style="${absolute(left, top)};overflow:visible" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none"><path d="${d}" style="stroke:var(--ink);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round"/></svg>`;
}

/** The design system's components (design/ds/<system>/components/library.json). */
export type Library = {
  name?: string;
  components: {
    id: string;
    name: string;
    group?: string;
    props: { id: string; label?: string; default: string; options?: Record<string, string> }[];
    html: string;
  }[];
};

const unescapeAttr = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * An instance of a component: its markup with the property values filled in, marked with the
 * component and its values so a change to the component on main can render it again.
 */
export function renderComponent(
  library: Library,
  id: string,
  props: Record<string, string> = {},
  keep: { layer?: string; style?: string } = {},
) {
  const component = library.components.find((item) => item.id === id);
  if (!component) throw new Error(`The design system has no component ${id}`);
  const values: Record<string, string> = {};
  const filled: Record<string, string> = {};
  for (const prop of component.props) {
    let value = String(props[prop.id] ?? prop.default).slice(0, 500);
    if (prop.options && !(value in prop.options)) value = prop.default;
    values[prop.id] = value;
    filled[prop.id] = prop.options ? (prop.options[value] ?? '') : value;
  }
  const html = component.html
    .trim()
    .replace(/\{\{([a-z0-9-]+)\}\}/g, (_, key: string) => escapeAttr(filled[key] ?? ''));
  const end = html.indexOf('>');
  if (!html.startsWith('<') || end < 0) throw new Error(`Component ${id} has no root element`);
  let root = html
    .slice(0, end + 1)
    .replace(/\sclass="\s*([^"]*?)\s*"/, (_, names: string) => (names ? ` class="${names}"` : ''));
  root = withAttribute(root, 'data-props', component.props.length ? JSON.stringify(values) : null);
  root = withAttribute(root, 'data-component', id);
  // Layers names an instance after its component.
  root = withAttribute(root, 'data-name', component.name);
  if (keep.style) root = withAttribute(root, 'style', keep.style);
  // The layer ID comes first, as on every other element of a board.
  if (keep.layer) root = root.replace(/^(<[a-zA-Z][\w:-]*)/, `$1 data-layer="${keep.layer}"`);
  return root + html.slice(end + 1);
}

/**
 * Render every instance on a board again from the library, keeping each one's layer, its place and
 * the layer IDs of the elements it still draws.
 */
/** An attribute's raw value, in double or single quotes. */
function quotedAttribute(tag: string, name: string) {
  const match = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? (match[1] ?? match[2]) : null;
}

/** Where a start tag ends: its first `>` outside a quoted attribute value. */
function tagEnd(html: string, open: number) {
  let inside = '';
  for (let at = open + 1; at < html.length; at++) {
    const char = html[at];
    if (inside) {
      if (char === inside) inside = '';
    } else if (char === '"' || char === "'") {
      // Only a quote that opens a value (after =) starts one; an apostrophe in text does not.
      if (/=\s*$/.test(html.slice(Math.max(open, at - 3), at))) inside = char;
    } else if (char === '>') return at;
  }
  return html.length - 1;
}

/**
 * A JSON object an attribute holds, read the way people write it: in double quotes with &quot;,
 * in single quotes, or broken by a quote inside a value (an apostrophe in a question): then the
 * object runs from its { to the } its quote closes. Null when it cannot be read.
 */
function jsonAttribute(tag: string, name: string): Record<string, unknown> | null {
  const start = new RegExp(`\\s${name}=(["'])`).exec(tag);
  if (!start) return null;
  const mark = start[1];
  const from = start.index + start[0].length;
  const candidates = [quotedAttribute(tag, name)];
  const end = tag.indexOf(`}${mark}`, from);
  if (end >= 0) candidates.push(tag.slice(from, end + 1));
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(unescapeAttr(raw));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // The next reading.
    }
  }
  return null;
}

/**
 * The questions an instance root asks about its inner layers:
 * data-questions='{"draft-size":"Is the size the frame or the window?"}', by layer ID.
 */
export function instanceQuestions(tag: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(jsonAttribute(tag, 'data-questions') ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && Boolean(entry[1].trim()),
    ),
  );
}

export function syncInstances(html: string, library: Library) {
  let out = html;
  const starts = [...out.matchAll(/\sdata-component="([a-z0-9-]+)"/g)].map((match) => match.index!);
  for (const at of starts.reverse()) {
    const open = out.lastIndexOf('<', at);
    // The whole start tag, though a value in it holds a > (data-props written by hand may).
    const tag = out.slice(open, tagEnd(out, open) + 1);
    const id = /\sdata-component="([^"]*)"/.exec(tag)![1];
    const layer = /\sdata-layer="([^"]*)"/.exec(tag)?.[1];
    if (!layer || !library.components.some((item) => item.id === id)) continue;
    const snippet = layerSnippet(out, layer);
    if (!snippet) continue;
    // An instance with unreadable values takes the component's defaults.
    const props = (jsonAttribute(tag, 'data-props') ?? {}) as Record<string, string>;
    const style = /\sstyle="([^"]*)"/.exec(tag)?.[1];
    // Questions about the instance's inner layers live on its root, so they survive drawing; a
    // data-question someone put on an inner layer moves there rather than being lost.
    const asked = instanceQuestions(tag);
    for (const element of boardElements(snippet).slice(1)) {
      const inner = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
      const question = quotedAttribute(inner, 'data-question');
      if (element.layer && question && !asked[element.layer])
        asked[element.layer] = unescapeAttr(question).trim();
    }
    // Questions that could not be read at all stay as they were written, never dropped.
    const unread =
      !Object.keys(asked).length && /\sdata-questions=/.test(tag)
        ? /\sdata-questions=("[^"]*"|'[^']*')/.exec(tag)?.[1]
        : null;
    const questions = Object.keys(asked).length ? JSON.stringify(asked) : null;
    // The instance keeps the layer IDs it had where it still draws the same elements, since
    // comments and pins on deploy.local point at them.
    let next = carryLayerIds(
      snippet,
      renderComponent(library, id, props, {
        layer,
        style: style ? unescapeAttr(style) : undefined,
      }),
    );
    if (questions) {
      const end = next.indexOf('>');
      next =
        withAttribute(next.slice(0, end + 1), 'data-questions', questions) + next.slice(end + 1);
    } else if (unread) {
      const end = next.indexOf('>');
      next = `${next.slice(0, end)} data-questions=${unread}${next.slice(end)}`;
    }
    out = out.slice(0, open) + next + out.slice(open + snippet.length);
  }
  return out === html ? html : assignLayerIds(out);
}

/**
 * Whether a board's whole change from `before` is its instances drawn again from `library`. The
 * layer IDs inside an instance do not count: syncing keeps the ones a board had, while a board
 * whose instance was drawn afresh names them anew, and landing syncs main's board either way.
 */
export function syncsTo(before: string, after: string, library: Library) {
  const synced = syncInstances(before, library).trimEnd();
  const drawn = after.trimEnd();
  return synced === drawn || withoutInstanceLayers(synced) === withoutInstanceLayers(drawn);
}

/** A board with the layer IDs inside its instances taken out; each instance keeps its own. */
function withoutInstanceLayers(html: string) {
  let out = html;
  const starts = [...out.matchAll(/\sdata-component="[a-z0-9-]+"/g)].map((match) => match.index!);
  for (const at of starts.reverse()) {
    const open = out.lastIndexOf('<', at);
    const close = out.indexOf('>', at);
    const layer = /\sdata-layer="([^"]*)"/.exec(out.slice(open, close + 1))?.[1];
    const snippet = layer ? layerSnippet(out, layer) : null;
    if (!snippet || !out.startsWith(snippet, open)) continue;
    const head = out.slice(open, close + 1);
    const inner = snippet.slice(head.length).replace(/\sdata-layer="[^"]*"/g, '');
    out = out.slice(0, open) + head + inner + out.slice(open + snippet.length);
  }
  return out;
}

/** Children of a layer's inner markup, as [start, end) offsets: elements only, text skipped. */
function childSpans(inner: string) {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = 0;
  for (const match of inner.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>|<!--[\s\S]*?-->/g)) {
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    const selfClosing = match[3] === '/' || VOID.has(name);
    if (match[1]) {
      depth--;
      if (depth === 0) spans.push([start, match.index! + match[0].length]);
    } else {
      if (depth === 0) start = match.index!;
      if (selfClosing) {
        if (depth === 0) spans.push([start, match.index! + match[0].length]);
      } else depth++;
    }
  }
  return spans;
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;');

/** A link from a layer of a board to another board, and whether it sits in the app's sidebar. */
export type BoardLink = { layer: string; to: string; text: string; sidebar: boolean };

/**
 * The links a board makes: every layer whose href names another board. Links inside the app's
 * sidebar are marked, since nearly every board repeats them.
 */
export function boardLinks(html: string): BoardLink[] {
  const sidebars: [number, number][] = [];
  for (const nav of html.matchAll(/<(?:nav|aside)\b[^>]*>/g)) {
    const classes = /\sclass="([^"]*)"/.exec(nav[0])?.[1].split(/\s+/) ?? [];
    if (!classes.some((name) => ['dl-side', 'rail', 'dz-rail'].includes(name))) continue;
    const layer = /\sdata-layer="([^"]+)"/.exec(nav[0])?.[1];
    const outer = layer ? layerSnippet(html, layer) : null;
    if (outer) sidebars.push([nav.index!, nav.index! + outer.length]);
  }
  const links: BoardLink[] = [];
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*\shref="([A-Za-z0-9_-]{1,80}\.html)"[^>]*>/g)) {
    const layer = /\sdata-layer="([^"]+)"/.exec(tag[0])?.[1];
    if (!layer) continue;
    const text = (layerSnippet(html, layer) ?? '')
      .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const at = tag.index!;
    links.push({ layer, to: tag[1], text, sidebar: sidebars.some(([a, b]) => at >= a && at < b) });
  }
  return links;
}

/** Where a layer's start tag sits, its attributes, and (for a leaf) its inner text span. */
function locate(html: string, layer: string) {
  const at = html.indexOf(` data-layer="${layer}"`);
  if (at < 0) return null;
  const open = html.lastIndexOf('<', at);
  const close = html.indexOf('>', at);
  const outer = layerSnippet(html, layer);
  const tag = html.slice(open, close + 1);
  const innerStart = close + 1;
  // Void elements (img, input) and self-closed tags have no inner span.
  const closing = outer && !tag.endsWith('/>') ? outer.lastIndexOf('</') : -1;
  const innerEnd = closing > 0 ? open + closing : innerStart;
  return { open, close, tag, inner: html.slice(innerStart, innerEnd), innerStart, innerEnd };
}

function withAttribute(tag: string, name: string, value: string | null) {
  const pattern = new RegExp(`\\s${name}="[^"]*"`);
  const without = tag.replace(pattern, '');
  if (value === null || value === '') return without;
  const end = without.endsWith('/>') ? without.length - 2 : without.length - 1;
  return `${without.slice(0, end).replace(/\s+$/, '')} ${name}="${escapeAttr(value)}"${without.slice(end)}`;
}

function styleOf(tag: string) {
  const value = /\sstyle="([^"]*)"/.exec(tag)?.[1] ?? '';
  const out: [string, string][] = [];
  for (const part of value.split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0)
      out.push([part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()]);
  }
  return out;
}

/**
 * Apply edits to a board, layer by layer, the way the properties panel changes it. Layer IDs never
 * change. `base` is the board on main, which `revert` restores a layer from.
 */
export function applyEdits(html: string, edits: BoardEdit[], base?: string, library?: Library) {
  let out = html;
  for (const edit of edits) {
    if (edit.op === 'insert') {
      let markup: string;
      if (edit.component) {
        if (!library) throw new Error('This design has no component library');
        const { x, y } = edit.component;
        markup = renderComponent(library, String(edit.component.id), edit.component.props ?? {}, {
          style:
            edit.parent || x === undefined ? undefined : absolute(coordinate(x), coordinate(y)),
        });
      } else if (edit.shape) markup = shapeMarkup(edit.shape);
      else throw new Error('Say what to insert');
      if (!edit.parent) {
        const close = out.lastIndexOf('</body>');
        const end = close >= 0 ? close : out.length;
        out = `${out.slice(0, end)}${markup}\n${out.slice(end)}`;
      } else {
        if (!/^[a-z0-9-]{1,64}$/.test(edit.parent)) throw new Error(`Invalid layer ${edit.parent}`);
        const parent = locate(out, edit.parent);
        if (!parent) throw new Error(`The board has no layer ${edit.parent}`);
        const name = /^<([a-zA-Z][\w:-]*)/.exec(parent.tag)?.[1].toLowerCase() ?? '';
        if (VOID.has(name) || parent.tag.endsWith('/>') || name === 'svg')
          throw new Error('Only a container can hold new layers');
        const spans = childSpans(parent.inner);
        const index = Math.max(0, Math.min(spans.length, Number(edit.index ?? spans.length)));
        const at =
          parent.innerStart + (index < spans.length ? spans[index][0] : parent.inner.length);
        out = out.slice(0, at) + markup + out.slice(at);
      }
      continue;
    }
    if (!/^[a-z0-9-]{1,64}$/.test(edit.layer)) throw new Error(`Invalid layer ${edit.layer}`);
    const found = locate(out, edit.layer);
    if (!found) throw new Error(`The board has no layer ${edit.layer}`);
    let { tag } = found;
    let inner = found.inner;
    if (edit.op === 'text') {
      if (/<[a-zA-Z]/.test(inner)) throw new Error('Only a text layer can be retyped');
      if (typeof edit.text !== 'string' || edit.text.length > 2000)
        throw new Error('Text is too long');
      inner = escapeText(edit.text);
    } else if (edit.op === 'style') {
      if (!/^[a-z-]{1,40}$/.test(edit.prop)) throw new Error(`Invalid style property ${edit.prop}`);
      if (edit.value !== null && (edit.value.length > 200 || /[;{}<>"]/.test(edit.value)))
        throw new Error(`Invalid value for ${edit.prop}`);
      const kept = styleOf(tag).filter(([name]) => name !== edit.prop);
      if (edit.value !== null && edit.value.trim()) kept.push([edit.prop, edit.value.trim()]);
      tag = withAttribute(tag, 'style', kept.map(([name, value]) => `${name}:${value}`).join(';'));
    } else if (edit.op === 'class') {
      const valid = (names: string[] = []) => {
        for (const name of names)
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid class ${name}`);
        return names;
      };
      const remove = new Set(valid(edit.remove));
      const classes = (/\sclass="([^"]*)"/.exec(tag)?.[1] ?? '')
        .split(/\s+/)
        .filter((name) => name && !remove.has(name));
      for (const name of valid(edit.add)) if (!classes.includes(name)) classes.push(name);
      tag = withAttribute(tag, 'class', classes.join(' '));
    } else if (edit.op === 'revert') {
      const original = base ? locate(base, edit.layer) : null;
      if (!original) throw new Error(`${edit.layer} is not on main`);
      const leaves = !/<[a-zA-Z]/.test(original.inner) && !/<[a-zA-Z]/.test(inner);
      if (edit.props || edit.text) {
        const props = new Set(edit.props ?? []);
        for (const name of props)
          if (!/^[a-z-]{1,40}$/.test(name)) throw new Error(`Invalid style property ${name}`);
        const was = new Map(styleOf(original.tag));
        const kept = styleOf(tag).filter(([name]) => !props.has(name));
        for (const name of props) if (was.has(name)) kept.push([name, was.get(name)!]);
        tag = withAttribute(
          tag,
          'style',
          kept.map(([name, value]) => `${name}:${value}`).join(';'),
        );
        if (edit.text && leaves) inner = original.inner;
      } else {
        tag = original.tag;
        if (leaves) inner = original.inner;
      }
    } else if (edit.op === 'link') {
      if (edit.to !== null && !/^[A-Za-z0-9_-]{1,80}\.html$/.test(String(edit.to)))
        throw new Error('A link goes to a board, like Inbox.html');
      tag = withAttribute(tag, 'href', edit.to);
    } else if (edit.op === 'remove') {
      out =
        out.slice(0, found.open) + out.slice(found.open + layerSnippet(out, edit.layer)!.length);
      continue;
    } else throw new Error('Unknown edit');
    out =
      out.slice(0, found.open) +
      tag +
      out.slice(found.close + 1, found.innerStart) +
      inner +
      out.slice(found.innerEnd);
  }
  // New layers get IDs the way imported boards do.
  return edits.some((edit) => edit.op === 'insert') ? assignLayerIds(out) : out;
}
