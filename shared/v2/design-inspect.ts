// What `deploy design check` reads from a drawn board, besides the picture: each piece of text with
// its size and its colours as the page computes them, edges that nearly line up, the height of
// list rows, boxes inside cards and the primary buttons. `inspectBoard` runs in the drawn page
// (no argument), so it uses nothing from outside itself; the rest is plain arithmetic on what it
// returns, shared by the check on deploy.local and on the computer.

export type Rgb = [number, number, number];
export type InspectedText = {
  layer: string | null;
  text: string;
  /** Font size in px and weight, as computed. */
  size: number;
  weight: number;
  /** The text's colour over what is behind it, both composited to opaque sRGB; bg null when
   * the background is a picture or gradient and cannot be known. */
  color: Rgb;
  bg: Rgb | null;
  left: number;
  top: number;
  width: number;
  height: number;
};
export type Inspection = {
  /** The page's height as drawn: what the board needs to show everything. */
  height: number;
  texts: InspectedText[];
  /** Text blocks one above the other whose left edges are 1 to 4 px apart. */
  aligned: { a: string; b: string; dx: number }[];
  /** List rows by kind (their design-system class): the heights of each one drawn. */
  rows: Record<string, number[]>;
  /** A bordered or shadowed box drawn inside another. */
  boxes: { layer: string; inside: string }[];
  /** Primary buttons that show. */
  primaries: string[];
};

/** Runs in the page: what the check measures there. */
export function inspectBoard(doc: Document = document): Inspection {
  const view = doc.defaultView!;
  const canvas = doc.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = (value: string): [number, number, number, number] => {
    if (!value || value === 'transparent') return [0, 0, 0, 0];
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = '#000';
    paint.fillStyle = value;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top: number[], under: number[]): [number, number, number] => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
  ];
  const layerOf = (element: Element | null) =>
    element?.closest('[data-layer]')?.getAttribute('data-layer') ?? null;
  const shown = (element: Element) => {
    for (let at: Element | null = element; at; at = at.parentElement) {
      const style = view.getComputedStyle(at);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.1)
        return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const opacity = (element: Element) => {
    let value = 1;
    for (let at: Element | null = element; at; at = at.parentElement)
      value *= Number(view.getComputedStyle(at).opacity);
    return value;
  };
  /** What is drawn behind an element: its own and its ancestors' backgrounds, page white last. */
  const behind = (element: Element): [number, number, number] | null => {
    const layers: number[][] = [];
    for (let at: Element | null = element; at; at = at.parentElement) {
      const style = view.getComputedStyle(at);
      if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      const colour = rgba(style.backgroundColor);
      if (colour[3] > 0) layers.push(colour);
      if (colour[3] >= 1) break;
    }
    let base: [number, number, number] = [255, 255, 255];
    for (const colour of layers.reverse()) base = over(colour, base);
    return base;
  };

  const texts: InspectedText[] = [];
  const blocks: { layer: string; left: number; top: number; bottom: number; element: Element }[] =
    [];
  for (const element of doc.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT'].includes(element.tagName)) continue;
    if (element.closest('svg')) continue;
    const own = [...element.childNodes].filter(
      // 3 is a text node.
      (node) => node.nodeType === 3 && node.textContent!.trim(),
    );
    if (!own.length || !shown(element)) continue;
    const style = view.getComputedStyle(element);
    const range = doc.createRange();
    range.selectNodeContents(own[0]);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const bg = behind(element);
    const colour = rgba(style.color);
    colour[3] *= opacity(element);
    const text = own
      .map((node) => node.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const layer = layerOf(element);
    texts.push({
      layer,
      text: text.slice(0, 40),
      size: Number.parseFloat(style.fontSize),
      weight: Number(style.fontWeight) || 400,
      color: over(colour, bg ?? [255, 255, 255]).map(Math.round) as Rgb,
      bg: bg ? (bg.map(Math.round) as Rgb) : null,
      left: Math.round(rect.left * 10) / 10,
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    // Blocks of text, for edges that nearly line up: text that starts its own line.
    if (layer && !['inline', 'contents'].includes(style.display))
      blocks.push({ layer, left: rect.left, top: rect.top, bottom: rect.bottom, element });
  }
  const aligned: Inspection['aligned'] = [];
  const seen = new Set<string>();
  blocks.sort((a, b) => a.top - b.top);
  for (let at = 0; at < blocks.length; at++)
    for (let next = at + 1; next < blocks.length; next++) {
      const [a, b] = [blocks[at], blocks[next]];
      if (b.top - a.bottom > 40) break;
      if (b.top < a.bottom - 2 || a.layer === b.layer) continue;
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const dx = Math.round(Math.abs(a.left - b.left) * 10) / 10;
      const key = `${a.layer} ${b.layer}`;
      if (dx >= 1 && dx <= 4 && !seen.has(key)) {
        seen.add(key);
        aligned.push({ a: a.layer, b: b.layer, dx });
      }
    }

  const rowKinds = ['dl-item', 'dl-ph-row', 'dl-setting', 'dl-log-row', 'dl-menu-item'];
  const rows: Record<string, number[]> = {};
  for (const kind of rowKinds)
    for (const element of doc.body.getElementsByClassName(kind)) {
      if (!shown(element)) continue;
      (rows[kind] ??= []).push(Math.round(element.getBoundingClientRect().height));
    }

  const pageWidth = doc.documentElement.clientWidth;
  const boxy = (element: Element) => {
    if (element.matches('button, input, select, textarea, a.dl-btn, .dl-btn, .dl-field, .dl-chip'))
      return false;
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 40 || rect.width > pageWidth * 0.9) return false;
    if (Number.parseFloat(style.borderTopLeftRadius) < 4) return false;
    if (rgba(style.backgroundColor)[3] === 0) return false;
    const bordered = ['Top', 'Right', 'Bottom', 'Left'].every(
      (side) =>
        Number.parseFloat((style as any)[`border${side}Width`]) >= 1 &&
        rgba((style as any)[`border${side}Color`])[3] > 0,
    );
    return bordered || (style.boxShadow && style.boxShadow !== 'none');
  };
  const boxes: Inspection['boxes'] = [];
  const cards = [...doc.body.querySelectorAll('[data-layer]')].filter(
    (element) => shown(element) && boxy(element),
  );
  for (const card of cards) {
    const outer = cards.find((other) => other !== card && other.contains(card));
    if (outer)
      boxes.push({
        layer: card.getAttribute('data-layer')!,
        inside: outer.getAttribute('data-layer')!,
      });
  }

  const primaries = [...doc.body.querySelectorAll('.dl-btn.primary, [data-primary]')]
    .filter(shown)
    .map((element) => layerOf(element) ?? element.textContent!.trim().slice(0, 40));

  return {
    height: Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight),
    texts,
    aligned,
    rows,
    boxes,
    primaries,
  };
}

/** WCAG's relative luminance of an sRGB colour. */
export function luminance([r, g, b]: Rgb) {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast between two colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** What text needs to read: 3:1 when large (24 px, or 18.66 px bold), 4.5:1 otherwise. */
export const neededContrast = (size: number, weight: number) =>
  size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;

/** "#1c1b1f" from [28, 27, 31]. */
export const hex = (colour: Rgb) =>
  `#${colour.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

/** [28, 27, 31] from "#1c1b1f", "#fff" or "#ffffffcc" (alpha dropped); null for anything else. */
export function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!match || ![3, 4, 6, 8].includes(match[1].length)) return null;
  const digits =
    match[1].length <= 4
      ? [...match[1].slice(0, 3)].map((digit) => digit + digit)
      : [match[1].slice(0, 2), match[1].slice(2, 4), match[1].slice(4, 6)];
  return digits.map((pair) => Number.parseInt(pair, 16)) as Rgb;
}
