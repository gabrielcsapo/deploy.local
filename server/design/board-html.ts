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

/** The name a layer gets from its markup: its label, its text, its first class, or its tag. */
function layerName(tag: string, name: string, text: string) {
  const label = attribute(tag, 'aria-label');
  if (label && slug(label)) return slug(label);
  if (text && slug(text)) return slug(text);
  const firstClass = attribute(tag, 'class')?.split(/\s+/).find(Boolean);
  if (firstClass) return slug(firstClass.replace(/^dl-/, '')) || name;
  return name;
}

/**
 * Give every element in the body a unique `data-layer` ID. IDs already present are kept, so running
 * this again after an edit only names the new elements. SVG internals are part of their icon.
 */
export function assignLayerIds(html: string): string {
  const bodyStart = html.search(/<body[\s>]/);
  if (bodyStart < 0) return html;
  const used = new Set<string>();
  for (const match of html.matchAll(/\sdata-layer="([^"]*)"/g)) used.add(match[1]);
  const unique = (base: string) => {
    let id = base || 'layer';
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

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
      out += tag;
      continue;
    }
    const selfClosing = tag.endsWith('/>');
    const isLayer = svgDepth === 0 && !NOT_LAYERS.has(name) && !tag.includes(' data-layer="');
    if (isLayer) {
      const next = html.indexOf('<', i);
      const text = html.slice(i, next < 0 ? undefined : next).trim();
      const id = unique(layerName(tag, name, text));
      tag = tag.replace(/^(<[a-zA-Z][\w:-]*)/, `$1 data-layer="${id}"`);
    }
    out += tag;
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
