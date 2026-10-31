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
  | { op: 'remove'; layer: string };

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

/** Render every instance on a board again from the library, keeping each one's layer and place. */
export function syncInstances(html: string, library: Library) {
  let out = html;
  const starts = [...out.matchAll(/\sdata-component="([a-z0-9-]+)"/g)].map((match) => match.index!);
  for (const at of starts.reverse()) {
    const open = out.lastIndexOf('<', at);
    const close = out.indexOf('>', at);
    const tag = out.slice(open, close + 1);
    const id = /\sdata-component="([^"]*)"/.exec(tag)![1];
    const layer = /\sdata-layer="([^"]*)"/.exec(tag)?.[1];
    if (!layer || !library.components.some((item) => item.id === id)) continue;
    const snippet = layerSnippet(out, layer);
    if (!snippet) continue;
    let props: Record<string, string> = {};
    try {
      props = JSON.parse(unescapeAttr(/\sdata-props="([^"]*)"/.exec(tag)?.[1] ?? '{}'));
    } catch {
      // An instance with unreadable values takes the component's defaults.
    }
    const style = /\sstyle="([^"]*)"/.exec(tag)?.[1];
    const next = renderComponent(library, id, props, {
      layer,
      style: style ? unescapeAttr(style) : undefined,
    });
    out = out.slice(0, open) + next + out.slice(open + snippet.length);
  }
  return out === html ? html : assignLayerIds(out);
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
