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
  /** Text of a disabled control: WCAG asks no contrast of inactive controls. */
  inactive?: boolean;
};
export type Inspection = {
  /** The page's height as drawn: what the board needs to show everything. */
  height: number;
  texts: InspectedText[];
  /** Text blocks one above the other whose left edges are 1 to 4 px apart. */
  aligned: { a: string; b: string; dx: number }[];
  /** List rows by kind (their design-system class): the heights of each one drawn. */
  rows: Record<string, number[]>;
  /**
   * Each table drawn: its kind (its classes), its left and top, and where each column of its first
   * row starts, so tables stacked one under another can be held to the same columns.
   */
  tables?: {
    layer: string | null;
    kind: string;
    left: number;
    top: number;
    bottom?: number;
    columns: number[];
  }[];
  /** A bordered or shadowed box drawn inside another. */
  boxes: { layer: string; inside: string }[];
  /** Primary buttons that show. */
  primaries: string[];
  /** Every control a finger or pointer hits (a button, link or field), where it is drawn. */
  controls?: {
    layer: string | null;
    text: string;
    left: number;
    top: number;
    width: number;
    height: number;
  }[];
  /**
   * Text partly hidden at the bottom of a fixed-height frame (or of a phone screen), or under a
   * bar pinned to its bottom.
   */
  clipped?: { layer: string | null; text: string; by: 'frame' | 'bar'; frame: string | null }[];
  /**
   * Content cut off at the left or right edge: a layer whose box runs past a clipping ancestor
   * (overflow hidden or clip) or past the page, and no scroller of its own carries it. `by` says
   * which: the page's edge, or a frame in the board.
   */
  clippedSide?: {
    layer: string | null;
    text: string;
    side: 'left' | 'right';
    by: 'page' | 'frame';
    frame: string | null;
    /** How far past the edge it runs, in px. */
    amount: number;
    /** Whether it carries no text: a shape, a picture. */
    plain: boolean;
  }[];
  /** The page's width as drawn, for the edges above. */
  width?: number;
  /** Lines of text drawn over lines of another element's text. */
  overlaps?: { a: string; b: string; layerA: string | null; layerB: string | null }[];
  /** Text running past the border of the control or bordered box that holds it, in px. */
  spills?: {
    layer: string | null;
    text: string;
    box: string | null;
    amount: number;
    /** border: the text ends outside the box; padding: inside it, but over the padding meant to frame it. */
    edge?: 'border' | 'padding';
  }[];
  /**
   * What the board needs to show all its content, even where a frame the size of the window
   * (a Mac window at 100% of a 100 px page) clips it: the measure --fix writes a height from.
   */
  needed?: number;
  /** The status bar the board draws, when it draws one (.ds-statusbar, [data-statusbar]). */
  statusBars?: Box[];
  /** Pictures and drawings that show (img, svg, canvas, video) and where, for a print piece's safe area. */
  figures?: Box[];
  /** Headings and where they end, for a document's page breaks. */
  headings?: (Box & { text: string })[];
  /** The margins the page's @page rule sets, in px: what a printed sheet leaves round the text. */
  pageMargin?: { top: number; right: number; bottom: number; left: number };
};
export type Box = {
  layer: string | null;
  left: number;
  top: number;
  width: number;
  height: number;
  /** For a picture: how far it runs past the first ancestor that hides overflow, and which. */
  cut?: number;
  frame?: string | null;
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
  /**
   * A control that does nothing now: disabled, aria-disabled, inert, or drawn as unavailable
   * (a disabled class, or the not-allowed cursor the design system gives a disabled button).
   */
  const inactive = (element: Element) => {
    const control = element.closest('button, a, input, select, textarea, [role="button"]');
    for (let at: Element | null = control ?? element; at; at = at.parentElement) {
      if (
        at.matches(
          ':disabled, [disabled], [aria-disabled="true"], [inert], .disabled, .is-disabled',
        )
      )
        return true;
      if (at === control && view.getComputedStyle(at).cursor === 'not-allowed') return true;
      if (!control) break;
    }
    return false;
  };
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
  const placed: {
    element: Element;
    rect: DOMRect;
    layer: string | null;
    text: string;
    lines: DOMRect[];
  }[] = [];
  const blocks: {
    layer: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    element: Element;
  }[] = [];
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
    const whole = doc.createRange();
    whole.selectNodeContents(element);
    const lines: DOMRect[] = [];
    for (const node of own) {
      const line = doc.createRange();
      line.selectNodeContents(node);
      for (const box of line.getClientRects()) if (box.width > 0 && box.height > 0) lines.push(box);
    }
    placed.push({
      element,
      rect: whole.getBoundingClientRect(),
      layer,
      text: text.slice(0, 40),
      lines,
    });
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
      ...(inactive(element) ? { inactive: true } : {}),
    });
    // Blocks of text, for edges that nearly line up: text that starts its own line. Text set
    // right or centred starts wherever its words end it, so its left edge says nothing.
    if (
      layer &&
      !['inline', 'contents'].includes(style.display) &&
      !/^(right|end|center)$/.test(style.textAlign)
    )
      blocks.push({
        layer,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        element,
      });
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
      // Right edges that line up: the pair is set flush right (a count, a size), not left.
      if (Math.abs(a.right - b.right) < 1) continue;
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

  const tables = [...doc.body.querySelectorAll('table')]
    .filter((table) => shown(table) && table.rows.length > 0)
    .map((table) => {
      const rect = table.getBoundingClientRect();
      return {
        layer: layerOf(table),
        kind:
          [...table.classList]
            .filter((name) => /^(ds|dl)-/.test(name))
            .sort()
            .join(' ') || 'table',
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        columns: [...table.rows[0].cells].map((cell) =>
          Math.round(cell.getBoundingClientRect().left),
        ),
      };
    });

  const pageWidth = doc.documentElement.clientWidth;
  // Form controls are boxes by nature: a field, a select, a segmented control inside a card or a
  // dialog is how a form looks, not a box in a card.
  const control =
    'button, input, select, textarea, [role="textbox"], [role="searchbox"], [role="combobox"], [role="radiogroup"], [role="tablist"], [role="switch"], [contenteditable=""], [contenteditable="true"], a.dl-btn, .dl-btn, .dl-field, .dl-input, .dl-chip, .dl-seg, .dl-segmented, .dl-composer, .dl-ph-composer';
  const boxy = (element: Element) => {
    if (element.matches(control) || element.closest(control) !== null) return false;
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    // A control's wrapper: a short box that holds a field and little else.
    if (rect.height < 80 && element.querySelector(control)) return false;
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

  // A disabled primary is not a second decision: it cannot be taken yet.
  const primaries = [...doc.body.querySelectorAll('.dl-btn.primary, [data-primary]')]
    .filter((element) => shown(element) && !inactive(element))
    .map((element) => layerOf(element) ?? element.textContent!.trim().slice(0, 40));
  // Controls, outermost only (a link inside a button is one target), for tap= and reach= limits.
  const tappable = 'button, a[href], [role="button"], input, select, textarea, [data-tap]';
  const controls = [...doc.body.querySelectorAll(tappable)]
    .filter((element) => shown(element) && !element.parentElement?.closest(tappable))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        layer: layerOf(element),
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        left: Math.round(rect.left),
        top: Math.round(rect.top + view.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    })
    .filter((control) => control.width > 0 && control.height > 0);

  // Frames: elements that clip what overflows them at a fixed height, and a phone screen itself.
  const frames: { element: Element | null; bottom: number; left: number; right: number }[] = [];
  if (view.innerWidth <= 500)
    frames.push({ element: null, bottom: view.innerHeight, left: 0, right: view.innerWidth });
  for (const element of doc.body.querySelectorAll('*')) {
    const style = view.getComputedStyle(element);
    if (!/(hidden|clip)/.test(style.overflowY) || !shown(element)) continue;
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height < 120 || rect.width < 200) continue;
    frames.push({ element, bottom: rect.bottom, left: rect.left, right: rect.right });
  }
  // A phone screen drawn inside a wider board: its bars hide what runs under them too.
  for (const element of doc.body.querySelectorAll('.dl-phone, [data-platform="phone"]')) {
    if (!shown(element) || frames.some((frame) => frame.element === element)) continue;
    const rect = element.getBoundingClientRect();
    frames.push({ element, bottom: rect.bottom, left: rect.left, right: rect.right });
  }
  const clipped: NonNullable<Inspection['clipped']> = [];
  const noted = new Set<Element>();
  for (const frame of frames) {
    const inside = placed.filter(
      (entry) =>
        !frame.element ||
        (frame.element !== entry.element && frame.element.contains(entry.element)),
    );
    for (const entry of inside)
      if (
        entry.rect.top < frame.bottom - 1 &&
        entry.rect.bottom > frame.bottom + 1 &&
        !noted.has(entry.element)
      ) {
        noted.add(entry.element);
        clipped.push({
          layer: entry.layer,
          text: entry.text,
          by: 'frame',
          frame: frame.element ? layerOf(frame.element) : null,
        });
      }
    // Bars along the frame's bottom: a tab bar, a composer, a toolbar, pinned (fixed, sticky,
    // absolute) or last in the frame's column. What sits under one is found as drawn: the
    // element painted at a point is the bar, not the text.
    const scope = frame.element ?? doc.body;
    const width = frame.right - frame.left;
    for (const bar of scope.querySelectorAll('*')) {
      if (!shown(bar)) continue;
      const style = view.getComputedStyle(bar);
      const rect = bar.getBoundingClientRect();
      if (
        Math.abs(rect.bottom - frame.bottom) > 2 ||
        rect.height < 20 ||
        rect.height > 120 ||
        rect.width < width * 0.8 ||
        (rgba(style.backgroundColor)[3] === 0 && style.backdropFilter === 'none')
      )
        continue;
      for (const entry of inside) {
        if (bar.contains(entry.element) || entry.element.contains(bar) || noted.has(entry.element))
          continue;
        // An action is judged by its whole box (a row's tap area), text by its own.
        const action = entry.element.closest('button, a, [role="button"], .dl-btn');
        const box = action && !bar.contains(action) ? action.getBoundingClientRect() : entry.rect;
        const top = Math.max(box.top, rect.top);
        const bottom = Math.min(box.bottom, rect.bottom);
        const left = Math.max(box.left, rect.left);
        const right = Math.min(box.right, rect.right);
        if (bottom - top <= 4 || right - left <= 4) continue;
        const hit = doc.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        if (!hit || !bar.contains(hit) || entry.element.contains(hit)) continue;
        // An action under the bar can never be taken; text running on under it is the scroll,
        // unless the bar cuts through it.
        const cut = box.top < rect.top - 1;
        if (!action && !cut) continue;
        noted.add(entry.element);
        clipped.push({ layer: entry.layer, text: entry.text, by: 'bar', frame: layerOf(bar) });
      }
    }
  }

  const boxOf = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return {
      layer: layerOf(element),
      left: Math.round(rect.left * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
    };
  };
  const toPx = (value: string) => {
    const match = /^(-?\d*\.?\d+)(px|mm|cm|in|pt)$/.exec(value.trim());
    if (!match) return 0;
    const unit = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72 }[match[2]] ?? 1;
    return Number(match[1]) * unit;
  };
  let pageMargin: Inspection['pageMargin'];
  const findPageRules = (rules: CSSRuleList) => {
    for (const rule of rules) {
      // 6 is an @page rule; media and supports rules hold more.
      if (rule.constructor.name === 'CSSPageRule') {
        const style = (rule as CSSPageRule).style;
        const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) =>
          toPx(style.getPropertyValue(`margin-${side.toLowerCase()}`)),
        );
        if (sides.some(Boolean))
          pageMargin = { top: sides[0], right: sides[1], bottom: sides[2], left: sides[3] };
      } else if ('cssRules' in rule) findPageRules((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of doc.styleSheets)
    try {
      findPageRules(sheet.cssRules);
    } catch {
      // A sheet from elsewhere cannot be read.
    }

  // Content cut off at the sides: an element's box past a clipping ancestor, or past the page.
  // A scroller that is meant to scroll sideways (overflow-x auto or scroll and not itself
  // scrolling down, or marked data-scroll-x) carries its own overflow; decorative shapes with no
  // text (aria-hidden, a backdrop, a bleed) and backgrounds that cover the page are meant to bleed.
  const sideTolerance = 1.5;
  const marked = (element: Element) =>
    element.matches('[data-scroll-x], [data-scrolls="x"], [data-bleed], [data-decor]');
  const scrollsSideways = (element: Element) => {
    const style = view.getComputedStyle(element);
    if (element.matches('[data-scroll-x], [data-scrolls="x"]')) return true;
    if (!/(auto|scroll)/.test(style.overflowX)) return false;
    // A column that scrolls down has overflow-x auto as a side effect of overflow-y: auto.
    return !(
      /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
    );
  };
  const isPlain = (element: Element) =>
    !(element.textContent ?? '').trim() &&
    !element.matches('input, select, textarea, button, img, svg, canvas, video');
  const clippedSide: NonNullable<Inspection['clippedSide']> = [];
  const sideHits = new Map<Element, (typeof clippedSide)[number]>();
  for (const element of doc.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT', 'BR', 'HR'].includes(element.tagName)) continue;
    if (element.parentElement?.closest('svg') || !shown(element)) continue;
    if (marked(element) || element.closest('[aria-hidden="true"], [data-bleed], [data-decor]'))
      continue;
    const style = view.getComputedStyle(element);
    if (style.position === 'fixed' || style.pointerEvents === 'none') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    // A shape with no text that covers most of the page is a background; one placed absolutely
    // or with no box of its own (no border, no fill) is decoration: nothing is lost by cutting it.
    if (isPlain(element)) {
      if (rect.width >= pageWidth * 0.9 || style.position === 'absolute') continue;
      const boxed =
        Number.parseFloat(style.borderTopWidth) > 0 ||
        Number.parseFloat(style.borderLeftWidth) > 0 ||
        rgba(style.backgroundColor)[3] > 0 ||
        style.backgroundImage !== 'none';
      if (!boxed) continue;
    }
    // Walk up to what clips it: the first ancestor that hides overflow (its box decides), a
    // scroller (it scrolls: fine), else the page.
    let verdict: {
      by: 'page' | 'frame';
      frame: Element | null;
      left: number;
      right: number;
    } | null = {
      by: 'page',
      frame: null,
      left: 0,
      right: pageWidth,
    };
    let abs = style.position === 'absolute';
    const home = abs ? (element as HTMLElement).offsetParent : null;
    for (
      let at = element.parentElement;
      at && at !== doc.body && at !== doc.documentElement;
      at = at.parentElement
    ) {
      if (abs) {
        // An absolute element is clipped only from its containing block outwards.
        if (at !== home) continue;
        abs = false;
      }
      const clip = view.getComputedStyle(at);
      if (/(hidden|clip)/.test(clip.overflowX) && !scrollsSideways(at)) {
        const box = at.getBoundingClientRect();
        verdict = {
          by: 'frame',
          frame: at,
          left: box.left + at.clientLeft,
          right: box.left + at.clientLeft + at.clientWidth,
        };
        break;
      }
      if (scrollsSideways(at)) {
        verdict = null;
        break;
      }
    }
    if (!verdict) continue;
    const past = rect.right - verdict.right;
    const before = verdict.left - rect.left;
    if (past <= sideTolerance && before <= sideTolerance) continue;
    // Frame: only what is partly cut counts (a closed drawer is wholly outside, on purpose).
    // Page: a part off the page or all of it.
    const visible = Math.min(rect.right, verdict.right) - Math.max(rect.left, verdict.left);
    if (verdict.by === 'frame' && visible < 1) continue;
    const side = past > before ? 'right' : 'left';
    sideHits.set(element, {
      layer: layerOf(element),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      side,
      by: verdict.by,
      frame: verdict.frame ? layerOf(verdict.frame) : null,
      amount: Math.round(Math.max(past, before) * 10) / 10,
      plain: isPlain(element),
    });
  }
  // The outermost only: a card past the edge carries everything inside it.
  for (const [element, hit] of sideHits) {
    let covered = false;
    for (let at = element.parentElement; at; at = at.parentElement)
      if (sideHits.get(at)?.by === hit.by) {
        covered = true;
        break;
      }
    if (!covered) clippedSide.push(hit);
  }

  // What the board needs: the lowest content (fixed bars aside) and the true extent of any
  // frame as tall as the page, whose own box is the window it is drawn in.
  let needed = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
  const contentBearing = 'img, svg, canvas, video, input, select, textarea, button';
  for (const element of doc.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT'].includes(element.tagName)) continue;
    if (element.parentElement?.closest('svg') || !shown(element)) continue;
    const style = view.getComputedStyle(element);
    if (style.position === 'fixed') continue;
    let scrolled = false;
    for (let at = element.parentElement; at && at !== doc.body; at = at.parentElement)
      if (/(auto|scroll)/.test(view.getComputedStyle(at).overflowY)) {
        scrolled = true;
        break;
      }
    if (scrolled) continue;
    const rect = element.getBoundingClientRect();
    const hasText = [...element.childNodes].some(
      (node) => node.nodeType === 3 && node.textContent!.trim(),
    );
    if (hasText || element.matches(contentBearing))
      needed = Math.max(needed, rect.bottom + view.scrollY);
    if (
      /(hidden|clip)/.test(style.overflowY) &&
      rect.height >= view.innerHeight - 2 &&
      element.scrollHeight > element.clientHeight + 1
    )
      needed = Math.max(
        needed,
        rect.top +
          view.scrollY +
          element.clientTop +
          element.scrollHeight +
          (rect.height - element.clientTop - element.clientHeight),
      );
  }

  const statusBars = [
    ...doc.body.querySelectorAll(
      '.ds-statusbar, [data-statusbar], [data-layer="statusbar"], [data-layer="status-bar"]',
    ),
  ]
    .filter(shown)
    .map(boxOf);
  // How far a picture runs past the first ancestor that hides what overflows it, on any side.
  const cutBy = (element: Element) => {
    const rect = element.getBoundingClientRect();
    for (let at = element.parentElement; at && at !== doc.body; at = at.parentElement) {
      const clip = view.getComputedStyle(at);
      if (!/(hidden|clip)/.test(`${clip.overflowX} ${clip.overflowY}`)) continue;
      const box = at.getBoundingClientRect();
      const past = Math.max(
        box.left - rect.left,
        rect.right - box.right,
        box.top - rect.top,
        rect.bottom - box.bottom,
      );
      return past > 1 ? { cut: Math.round(past), frame: layerOf(at) } : null;
    }
    return null;
  };
  const figures = [...doc.body.querySelectorAll('img, svg, canvas, video')]
    .filter((element) => shown(element) && !element.parentElement?.closest('svg'))
    .map((element) => ({ ...boxOf(element), ...cutBy(element) }));
  const headings = [...doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter(shown)
    .map((element) => ({
      ...boxOf(element),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }));

  // Text over text: lines of two elements, neither inside the other, drawn on top of each other.
  // A layer pinned to the window (fixed), hidden from readers (aria-hidden) or kept for screen
  // readers only is left out.
  const pinnedOrHidden = (element: Element) => {
    // Text for screen readers only: clipped to a pixel or so.
    const whole = element.getBoundingClientRect();
    if (whole.width <= 2 || whole.height <= 2) return true;
    for (let at: Element | null = element; at && at !== doc.body; at = at.parentElement) {
      if (at.getAttribute('aria-hidden') === 'true') return true;
      if (view.getComputedStyle(at).position === 'fixed') return true;
    }
    return false;
  };
  const readable = placed.filter((entry) => !pinnedOrHidden(entry.element));
  const overlaps: NonNullable<Inspection['overlaps']> = [];
  for (let i = 0; i < readable.length && overlaps.length < 20; i++)
    for (let j = i + 1; j < readable.length; j++) {
      const a = readable[i];
      const b = readable[j];
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const hit = a.lines.some((one) =>
        b.lines.some((two) => {
          // A line's box runs well above and below its letters (most of all in big type set
          // tight), so only the middle of each line counts.
          const core = (line: DOMRect) => ({
            top: line.top + line.height * 0.22,
            bottom: line.bottom - line.height * 0.22,
          });
          const wide = Math.min(one.right, two.right) - Math.max(one.left, two.left);
          const tall =
            Math.min(core(one).bottom, core(two).bottom) - Math.max(core(one).top, core(two).top);
          return wide > 2 && tall > 1;
        }),
      );
      if (hit) {
        overlaps.push({ a: a.text, b: b.text, layerA: a.layer, layerB: b.layer });
        break;
      }
    }
  // Text past the side of the border that holds it: a label wider than its button.
  // A box that clips what overflows is left to the edge checks.
  const spills: NonNullable<Inspection['spills']> = [];
  for (const entry of readable) {
    let holder: Element | null = null;
    for (let at = entry.element as Element | null; at && at !== doc.body; at = at.parentElement) {
      const style = view.getComputedStyle(at);
      const control = at.matches('button, a, [role="button"], .dl-btn');
      const bordered = ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) =>
          Number.parseFloat((style as any)[`border${side}Width`]) > 0 &&
          (style as any)[`border${side}Style`] !== 'none' &&
          rgba((style as any)[`border${side}Color`])[3] > 0,
      );
      if (control || bordered) {
        if (style.overflowX === 'visible' && style.overflowY === 'visible') holder = at;
        break;
      }
    }
    if (!holder || !entry.lines.length) continue;
    const box = holder.getBoundingClientRect();
    const style = view.getComputedStyle(holder);
    const inner = {
      left: box.left + Number.parseFloat(style.borderLeftWidth),
      right: box.right - Number.parseFloat(style.borderRightWidth),
    };
    const padLeft = Number.parseFloat(style.paddingLeft) || 0;
    const padRight = Number.parseFloat(style.paddingRight) || 0;
    // Sideways only: a glyph's box is taller than a tight line, so up and down would cry wolf.
    const past = Math.max(
      ...entry.lines.map((line) => Math.max(inner.left - line.left, line.right - inner.right)),
    );
    // A label that fills its own padding: the button is narrower than its words, so they sit
    // against the border. Only where the padding is real (at least 6 px) and half of it is gone.
    const crowd = Math.max(
      ...entry.lines.map((line) =>
        Math.max(
          padLeft >= 6 ? inner.left + padLeft - line.left - padLeft / 2 : 0,
          padRight >= 6 ? line.right - (inner.right - padRight) - padRight / 2 : 0,
        ),
      ),
    );
    if (past > 1)
      spills.push({
        layer: entry.layer,
        text: entry.text,
        box: layerOf(holder),
        amount: Math.round(past),
        edge: 'border',
      });
    else if (crowd > 1)
      spills.push({
        layer: entry.layer,
        text: entry.text,
        box: layerOf(holder),
        amount: Math.round(
          Math.min(
            inner.right - Math.max(...entry.lines.map((l) => l.right)),
            Math.min(...entry.lines.map((l) => l.left)) - inner.left,
          ),
        ),
        edge: 'padding',
      });
  }

  return {
    height: Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight),
    ...(overlaps.length ? { overlaps } : {}),
    ...(spills.length ? { spills: spills.slice(0, 20) } : {}),
    width: pageWidth,
    needed: Math.round(needed),
    statusBars,
    clippedSide,
    figures,
    headings,
    ...(pageMargin ? { pageMargin } : {}),
    clipped,
    texts,
    aligned,
    rows,
    tables,
    boxes,
    primaries,
    controls,
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
