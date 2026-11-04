import type {
  DesignRect,
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
