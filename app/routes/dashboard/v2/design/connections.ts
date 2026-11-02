import { sections, type Canvas, type DesignLink, type Section } from './model';

type Selection = { board: string; layer: string | null } | null;

/** One directed arrow per pair on this page, even when several layers make the link. */
export function connectionPairs(
  links: DesignLink[],
  boards: string[],
  sidebar: boolean,
  selection: Selection,
) {
  const visible = new Set(boards);
  const pairs = new Map<string, { from: string; to: string; highlighted: boolean }>();
  for (const link of links) {
    if (link.from === link.to || !visible.has(link.from) || !visible.has(link.to)) continue;
    if (link.sidebar && !sidebar) continue;
    const key = JSON.stringify([link.from, link.to]);
    const highlighted = Boolean(
      selection &&
      (selection.layer
        ? selection.board === link.from && selection.layer === link.layer
        : selection.board === link.from || selection.board === link.to),
    );
    const pair = pairs.get(key);
    if (pair) pair.highlighted ||= highlighted;
    else pairs.set(key, { from: link.from, to: link.to, highlighted });
  }
  // Selected connections draw last, above the quiet arrows.
  return [...pairs.values()].sort((a, b) => Number(a.highlighted) - Number(b.highlighted));
}

/** Both directions, with the current page first and other pages named once. */
export function boardConnections(
  canvas: Canvas,
  section: Section | null,
  board: string,
  links: DesignLink[],
  sidebar: boolean,
) {
  const visible = links.filter((link) => link.from !== link.to && (!link.sidebar || sidebar));
  const outgoing = visible.filter((link) => link.from === board);
  const incoming = new Map<string, Set<string>>();
  for (const link of visible) {
    if (link.to !== board) continue;
    const layers = incoming.get(link.from) ?? new Set<string>();
    layers.add(link.layer);
    incoming.set(link.from, layers);
  }
  const pages = sections(canvas);
  const pageOf = (file: string) => pages.find((page) => page.boards.includes(file));
  const group = <T>(items: T[], file: (item: T) => string) => {
    const groups = new Map<string, { page: Section | null; items: T[] }>();
    for (const item of items) {
      const page = pageOf(file(item)) ?? null;
      const key = page?.id ?? '';
      if (!groups.has(key)) groups.set(key, { page, items: [] });
      groups.get(key)!.items.push(item);
    }
    return [...groups.values()].sort(
      (a, b) => Number(b.page?.id === section?.id) - Number(a.page?.id === section?.id),
    );
  };
  return {
    outgoing: group(outgoing, (link) => link.to),
    incoming: group(
      [...incoming].map(([from, layers]) => ({ from, layers: layers.size })),
      (entry) => entry.from,
    ),
    leadsTo: new Set(outgoing.map((link) => link.to)).size,
    comesFrom: incoming.size,
    sidebar:
      links.filter((link) => link.sidebar && link.from === board).length ||
      links.filter((link) => link.sidebar && link.to === board).length,
  };
}

/** Attach to the facing edges, keeping arrowheads and bends readable at every zoom. */
export function connectionCurve(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
  zoom: number,
) {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const horizontal = Math.abs(dx) / ((from.w + to.w) / 2) >= Math.abs(dy) / ((from.h + to.h) / 2);
  const sign = (horizontal ? dx : dy) >= 0 ? 1 : -1;
  const x = from.x + from.w / 2 + (horizontal ? sign * (from.w / 2 + 3 / zoom) : 0);
  const y = from.y + from.h / 2 + (horizontal ? 0 : sign * (from.h / 2 + 3 / zoom));
  const endX = to.x + to.w / 2 - (horizontal ? sign * (to.w / 2 + 4 / zoom) : 0);
  const endY = to.y + to.h / 2 - (horizontal ? 0 : sign * (to.h / 2 + 4 / zoom));
  const bend = Math.max(24 / zoom, Math.abs(horizontal ? endX - x : endY - y) / 2);
  const bx = horizontal ? sign * bend : 0;
  const by = horizontal ? 0 : sign * bend;
  return {
    x,
    y,
    path: `M${x} ${y} C${x + bx} ${y + by}, ${endX - bx} ${endY - by}, ${endX} ${endY}`,
  };
}
