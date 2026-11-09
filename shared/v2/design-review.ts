import type {
  DesignRect,
  DesignReviewRow,
  DesignReviewPin,
  DesignReviewDrawing,
  DesignReviewChange,
  DesignReviewPreview,
  DesignReviewScreen,
} from './contracts.ts';

export const reviewWidths = (width: number) => (width <= 500 ? [width] : [1440, 700]);
export const screenName = (file: string) =>
  file
    .replace(/\.html$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/Phone$/, 'on iPhone');

/** Shared by the grid and native clients: fit a complete region with context, never cover it. */
export function reviewCrop(
  width: number,
  height: number,
  areas: DesignRect[],
  textBoxes: DesignRect[] = [],
): DesignRect {
  const largest = [...areas].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!largest) return { x: 0, y: 0, w: Math.min(width, 720), h: Math.min(height, 520) };
  const x = Math.min(width - 1, Math.max(0, largest.x - 48));
  const y = Math.min(height - 1, Math.max(0, largest.y - 48));
  const crop = {
    x,
    y,
    w: Math.min(width - x, largest.w + 96),
    h: Math.min(height - y, largest.h + 96),
  };
  // Expand to complete text and controls touching the crop, without pulling in page wrappers.
  for (let pass = 0; pass < textBoxes.length; pass++) {
    let expanded = false;
    for (const box of textBoxes) {
      if (
        box.x >= crop.x + crop.w ||
        box.y >= crop.y + crop.h ||
        box.x + box.w <= crop.x ||
        box.y + box.h <= crop.y
      )
        continue;
      const left = Math.max(0, Math.min(crop.x, box.x));
      const top = Math.max(0, Math.min(crop.y, box.y));
      const right = Math.min(width, Math.max(crop.x + crop.w, box.x + box.w));
      const bottom = Math.min(height, Math.max(crop.y + crop.h, box.y + box.h));
      if (
        left !== crop.x ||
        top !== crop.y ||
        right !== crop.x + crop.w ||
        bottom !== crop.y + crop.h
      ) {
        Object.assign(crop, { x: left, y: top, w: right - left, h: bottom - top });
        expanded = true;
      }
    }
    if (!expanded) break;
  }
  return crop;
}

export function reviewAreas(
  changes: DesignReviewChange[],
  before: Record<string, DesignRect>,
  after: Record<string, DesignRect>,
  width: number,
  height: number,
): DesignReviewPreview['areas'] {
  const coversScreen = (rect: DesignRect | null) =>
    rect &&
    Math.max(0, Math.min(width, rect.x + rect.w) - Math.max(0, rect.x)) *
      Math.max(0, Math.min(height, rect.y + rect.h) - Math.max(0, rect.y)) >=
      width * height * 0.8;
  const areas = changes
    .map<DesignReviewPreview['areas'][number]>((change) => ({
      ...change,
      before: before[change.layer] ?? null,
      after: after[change.layer] ?? null,
    }))
    .filter(
      (area) =>
        (area.before || area.after) && !coversScreen(area.before) && !coversScreen(area.after),
    );
  const touches = (a: DesignRect | null, b: DesignRect | null) =>
    a &&
    b &&
    a.x <= b.x + b.w + 8 &&
    b.x <= a.x + a.w + 8 &&
    a.y <= b.y + b.h + 8 &&
    b.y <= a.y + a.h + 8;
  const union = (a: DesignRect | null, b: DesignRect | null): DesignRect | null => {
    if (!a || !b) return a ?? b;
    const x = Math.min(a.x, b.x),
      y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  // Restart after each union: a later bridge can connect earlier, separate regions.
  // Keep the first area's identity/words and union each revision independently.
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const a = areas[i],
        b = areas[j];
      if (
        !touches(a.before ?? a.after, b.before ?? b.after) &&
        !touches(a.after ?? a.before, b.after ?? b.before)
      )
        continue;
      a.before = union(a.before, b.before);
      a.after = union(a.after, b.after);
      areas.splice(j, 1);
      i = -1;
      break;
    }
  }
  return areas;
}

export function nextUnseen(boards: Pick<DesignReviewScreen, 'file' | 'seen'>[], current?: string) {
  const start = boards.findIndex((board) => board.file === current);
  for (let offset = 1; offset <= boards.length; offset++) {
    const board = boards[(start + offset) % boards.length];
    if (!board.seen) return board.file;
  }
  return null;
}

// Bound both payload size and rendering work. Coordinates belong to the original board.
export function validReviewDrawing(value: unknown): value is DesignReviewDrawing {
  if (!value || typeof value !== 'object') return false;
  const drawing = value as DesignReviewDrawing;
  const point = (p: { x: number; y: number }) =>
    p &&
    typeof p.x === 'number' &&
    Number.isFinite(p.x) &&
    p.x >= 0 &&
    p.x <= 1 &&
    typeof p.y === 'number' &&
    Number.isFinite(p.y) &&
    p.y >= 0 &&
    p.y <= 1;
  return (
    (drawing.side === 'before' || drawing.side === 'after') &&
    Number.isInteger(drawing.nativeWidth) &&
    drawing.nativeWidth > 0 &&
    drawing.nativeWidth <= 100000 &&
    Number.isInteger(drawing.nativeHeight) &&
    drawing.nativeHeight > 0 &&
    drawing.nativeHeight <= 100000 &&
    drawing.weight === 3 &&
    !!point(drawing.anchor) &&
    Array.isArray(drawing.strokes) &&
    drawing.strokes.length > 0 &&
    drawing.strokes.length <= 128 &&
    drawing.strokes.every(
      (stroke) =>
        Array.isArray(stroke) && stroke.length > 0 && stroke.length <= 4096 && stroke.every(point),
    ) &&
    drawing.strokes.reduce((count, stroke) => count + stroke.length, 0) <= 16384
  );
}

export function reviewDrawingPath(
  drawing: DesignReviewDrawing,
  stroke: DesignReviewDrawing['strokes'][number],
) {
  return (
    stroke
      .map(
        (point, index) =>
          `${index ? 'L' : 'M'}${point.x * drawing.nativeWidth} ${point.y * drawing.nativeHeight}`,
      )
      .join(' ') + (stroke.length === 1 ? ' l0 0' : '')
  );
}

/** Evidence is collected at native width on the server; this grouping has no IO. */
export type ReviewEvidence = {
  file: string;
  title: string;
  status: DesignReviewRow['status'];
  regions: { layer: string; title: string; added: string[]; removed: string[] }[];
  changeWords?: string;
  nothingElse: boolean;
  seen: boolean;
  changedSinceReview?: boolean;
};
export function groupReviewChanges(
  screens: ReviewEvidence[],
  names: string[] = [],
): DesignReviewRow[] {
  const mask = (text: string) => {
    for (const name of [...names].filter(Boolean).sort((a, b) => b.length - a.length))
      text = text.split(name).join('{name}');
    return text.replace(/\s+/g, ' ').trim();
  };
  const groups = new Map<string, { row: DesignReviewRow; removals: string[] }>();
  for (const screen of screens) {
    const added = [...new Set(screen.regions.flatMap((region) => region.added))];
    const removed = [...new Set(screen.regions.flatMap((region) => region.removed))];
    const signature = screen.regions
      .map((region) => ({
        layer: region.layer.replace(/-\d+$/, ''),
        added: region.added.map(mask).sort(),
      }))
      .sort((a, b) => a.layer.localeCompare(b.layer));
    // A second region or unaccounted-for pixels must never hide in a repeated-change row.
    const canGroup =
      screen.nothingElse &&
      screen.regions.length === 1 &&
      !['new', 'removed', 'pixelsOnly'].includes(screen.status);
    const key = canGroup
      ? JSON.stringify([screen.status, screen.changedSinceReview ?? true, signature])
      : screen.file;
    const removal = JSON.stringify(removed.map(mask).sort());
    const existing = groups.get(key);
    if (existing) {
      existing.row.screens.push(screen.file);
      existing.row.seen &&= screen.seen;
      existing.removals.push(removal);
    } else
      groups.set(key, {
        row: {
          id: screen.file,
          title: screen.changeWords || screen.regions[0]?.title || screen.title,
          status: screen.status,
          screens: [screen.file],
          added,
          removed,
          variations: 0,
          nothingElse: screen.nothingElse,
          seen: screen.seen,
        },
        removals: [removal],
      });
  }
  return [...groups.values()].map(({ row, removals }) => {
    const counts = new Map<string, number>();
    for (const removal of removals) counts.set(removal, (counts.get(removal) ?? 0) + 1);
    row.variations = removals.length - Math.max(...counts.values());
    return row;
  });
}

/** Anchors follow the element through reflow. Missing layers retain legacy coordinates. */
export function reviewNotePosition(
  pin: Pick<DesignReviewPin, 'x' | 'y' | 'layer' | 'offset'>,
  boxes: Record<string, DesignRect>,
) {
  const box = pin.layer && boxes[pin.layer];
  return box && pin.offset
    ? { x: box.x + box.w * pin.offset.x, y: box.y + box.h * pin.offset.y }
    : { x: pin.x, y: pin.y };
}
export function validReviewAnchor(
  value: { layer?: unknown; offset?: any; area?: any },
  width: number,
  height: number,
) {
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (
    value.layer !== undefined &&
    (typeof value.layer !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value.layer))
  )
    return false;
  if (
    value.offset !== undefined &&
    (!value.layer ||
      !value.offset ||
      ![value.offset.x, value.offset.y].every((n) => finite(n) && n >= 0 && n <= 1))
  )
    return false;
  const a = value.area;
  return (
    a === undefined ||
    !!(
      a &&
      [a.x, a.y, a.w, a.h].every(finite) &&
      a.x >= 0 &&
      a.y >= 0 &&
      a.w > 0 &&
      a.h > 0 &&
      a.x + a.w <= width &&
      a.y + a.h <= height
    )
  );
}
