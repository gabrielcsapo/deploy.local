import type {
  DesignRect,
  DesignReview,
  DesignReviewPin,
  DesignReviewScreen,
} from '../../../../../shared/v2/contracts';
import type { Canvas } from './model';
import type { Comment } from './Comments';

export type ReviewSide = 'before' | 'after';
export const reviewProject = (id: string) => (id.startsWith('design:') ? id.split(':')[1] : null);
export const reviewBranch = (id: string) => id.split(':')[2]?.replaceAll('~', '/') ?? 'HEAD';

/** Canvas order, including removed frames which only exist in the previous canvas. */
export function reviewFrames(review: Pick<DesignReview, 'boards' | 'groups'>) {
  const byFile = new Map(review.boards.map((board) => [board.file, board]));
  const result: DesignReviewScreen[] = [];
  for (const file of review.groups.flatMap((group) => group.boards)) {
    const board = byFile.get(file);
    if (board) {
      result.push(board);
      byFile.delete(file);
    }
  }
  return [...result, ...byFile.values()];
}

export function reviewCanvas(
  after: Canvas | null,
  before: Canvas | null,
  boards: DesignReviewScreen[],
) {
  if (!after) return after;
  const removed = boards.filter((board) => board.removed && before?.boards[board.file]);
  if (!removed.length) return after;
  return {
    ...after,
    boards: {
      ...after.boards,
      ...Object.fromEntries(removed.map((board) => [board.file, before!.boards[board.file]])),
    },
  };
}

export function frameSource(board: DesignReviewScreen, side: ReviewSide) {
  if ((side === 'before' && board.added) || (side === 'after' && board.removed)) return null;
  return board[side];
}

export function reviewKey(
  event: Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey'>,
  editing: boolean,
) {
  if (editing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return null;
  return event.key === 'ArrowLeft'
    ? 'previous'
    : event.key === 'ArrowRight'
      ? 'next'
      : event.key === ' '
        ? 'approve'
        : null;
}

/** Include branch suggestions and only comments anchored to this proposal or its later edits. */
export function reviewFeedback(
  review: DesignReview,
  comments: Comment[],
  branch: string,
  commit?: string,
) {
  const relevant = comments.filter(
    (comment) =>
      !comment.resolved &&
      comment.commit &&
      (comment.commit === review.after ||
        (Date.parse(comment.createdAt) >= Date.parse(review.createdAt) &&
          comment.commit === commit)),
  );
  return [
    ...relevant.map(
      (comment) => `${comment.board}${comment.layer ? ` › ${comment.layer}` : ''}\n${comment.text}`,
    ),
    commit && commit !== review.after
      ? `Canvas suggestions (drawings and edits): ${branch} at ${commit}. Compare with the proposed design at ${review.after}; keep these suggestions when you propose again.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function stepFrame(
  boards: DesignReviewScreen[],
  current: string | undefined,
  delta: number,
) {
  if (!boards.length) return null;
  const index = Math.max(
    0,
    boards.findIndex((board) => board.file === current),
  );
  return boards[Math.max(0, Math.min(boards.length - 1, index + delta))].file;
}

export function seenFrame(review: DesignReview, file: string, revision: string): DesignReview {
  if (review.after !== revision) return review;
  return {
    ...review,
    boards: review.boards.map((board) => (board.file === file ? { ...board, seen: true } : board)),
    // Ticking the screen a shared part is looked at on ticks the part.
    ...(review.parts && {
      parts: review.parts.map((part) =>
        part.lookAt.file === file ? { ...part, seen: true } : part,
      ),
    }),
  };
}

/** What one approves in a review: each shared part once, then each screen with its own changes. */
export type ReviewUnit = { key: string; title: string; seen: boolean; changedSinceReview: boolean };
export function reviewUnits(review: Pick<DesignReview, 'boards' | 'groups' | 'parts'>) {
  return [
    ...(review.parts ?? []).map((part) => ({
      key: `part:${part.component}`,
      title: `${part.name} · ${screenCount(part.screens)}`,
      seen: part.seen,
      // Older coordinators do not say; the part then counts as changed.
      changedSinceReview: part.changedSinceReview ?? true,
    })),
    ...reviewFrames(review)
      .filter((board) => !board.instanceOnly)
      .map((board) => ({
        key: board.file,
        title: board.title,
        seen: board.seen,
        changedSinceReview: board.changedSinceReview,
      })),
  ] satisfies ReviewUnit[];
}

/**
 * The bar's count. A later round counts only what changed since the owner's last review: the rest
 * was looked at then. Round one counts everything, as before.
 */
export function reviewProgress(
  review: Pick<DesignReview, 'boards' | 'groups' | 'parts' | 'round'>,
) {
  const units = reviewUnits(review);
  if ((review.round ?? 1) <= 1)
    return {
      round: null,
      count: `${units.filter((unit) => unit.seen).length} of ${units.length} approved`,
    };
  const changed = units.filter((unit) => unit.changedSinceReview);
  return {
    round: `round ${review.round}`,
    count: `${changed.filter((unit) => unit.seen).length} of ${changed.length} changed screen${changed.length === 1 ? '' : 's'} approved`,
  };
}

/** A changed frame's tag. In a later round, a frame looked at before and unchanged since says so. */
export function frameTag(
  review: Pick<DesignReview, 'parts'> & { round?: number },
  board: DesignReviewScreen,
) {
  if (board.added) return { text: 'New', changed: true };
  if (board.removed) return { text: 'Removed', changed: true };
  const round = review.round ?? 1;
  // Older coordinators do not say when it was ticked: the previous round is the one it can be.
  const seenIn = board.seenInRound ?? round - 1;
  if (round > 1 && !board.changedSinceReview && frameTicked(review, board) && seenIn < round)
    return { text: `Seen in round ${seenIn}`, changed: false };
  return { text: 'Changed', changed: true };
}

export type SinceLastReviewNote = {
  id: string;
  number: number;
  text: string;
  board: string;
  screen: string;
  addressed: boolean;
  reply: string | null;
};
/** What a later round brings back: how many screens changed, and the notes sent last round. */
export function sinceLastReview(
  review: Pick<
    DesignReview,
    'boards' | 'groups' | 'parts' | 'round' | 'pins' | 'notes' | 'createdAt'
  >,
) {
  if ((review.round ?? 1) <= 1) return null;
  const changed = reviewUnits(review).filter((unit) => unit.changedSinceReview).length;
  // Older coordinators do not give a pin its round: last round's pins are the ones made before this one.
  const last = review.pins.filter((pin) =>
    pin.round === undefined
      ? Date.parse(pin.createdAt) < Date.parse(review.createdAt)
      : pin.round === review.round - 1,
  );
  const notes: SinceLastReviewNote[] = last.map((pin) => ({
    id: pin.id,
    number: pin.number,
    text: pin.text,
    board: pin.board,
    screen:
      review.boards.find((board) => board.file === pin.board)?.title ??
      review.notes.find((note) => note.id === pin.noteId)?.title ??
      pin.board.replace(/\.html$/, ''),
    addressed: pin.resolved,
    reply: pin.reply,
  }));
  const addressed = notes.filter((note) => note.addressed).length;
  return {
    summary: [
      `${screenCount(changed)} changed.`,
      notes.length
        ? `${addressed} of your ${notes.length} note${notes.length === 1 ? '' : 's'} addressed.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    notes,
  };
}

/** View state for comparing a review's frames. Never sent to the server or saved. */
export type ReviewCompare = { wipe: boolean; width: number | null; dark: boolean };
export const reviewWidths = [1440, 700, 390] as const;
/** The width menu: each board at its own width (null), then the widths to draw web boards at. */
export const reviewWidthOptions = [
  { width: null, label: 'Each board’s own' },
  ...reviewWidths.map((width) => ({ width, label: String(width) })),
] as const;
/** The width button names the chosen width, or says Width while each board keeps its own. */
export const widthLabel = (compare: Pick<ReviewCompare, 'width'>) =>
  compare.width ? String(compare.width) : 'Width';
/** A phone board keeps its width; the width menu draws web boards only. */
export const isPhoneBoard = (w: number) => w <= 500;
export function comparedWidth(compare: Pick<ReviewCompare, 'width'>, w: number) {
  return compare.width && !isPhoneBoard(w) ? compare.width : w;
}
/** Where the wipe divider sits, 0–1 from the left; keys move it by a twentieth. */
export function wipeStep(value: number, key: string) {
  const next =
    key === 'ArrowLeft' || key === 'ArrowDown'
      ? value - 0.05
      : key === 'ArrowRight' || key === 'ArrowUp'
        ? value + 0.05
        : key === 'Home'
          ? 0
          : key === 'End'
            ? 1
            : null;
  return next === null ? null : Math.round(Math.min(1, Math.max(0, next)) * 100) / 100;
}
export const screenCount = (count: number) => `${count} screen${count === 1 ? '' : 's'}`;

/**
 * A pin about to be made on a review screen, in the screen's own pixels at the width it is drawn
 * at: what the iPhone sends too, so a pin made on either shows on the other.
 */
export type PinDraft = {
  board: string;
  width: number;
  revision: string;
  x: number;
  y: number;
  layer?: string;
  offset?: { x: number; y: number };
  area?: DesignRect;
};

/** The smallest layer under a point holds the pin, so it follows that layer at any width. */
export function pinAnchor(point: { x: number; y: number }, boxes: Record<string, DesignRect>) {
  let best: { layer: string; box: DesignRect } | null = null;
  for (const [layer, box] of Object.entries(boxes)) {
    if (!(box.w > 0 && box.h > 0)) continue;
    if (point.x < box.x || point.x > box.x + box.w || point.y < box.y || point.y > box.y + box.h)
      continue;
    if (!best || box.w * box.h < best.box.w * best.box.h) best = { layer, box };
  }
  return best
    ? {
        layer: best.layer,
        offset: {
          x: (point.x - best.box.x) / best.box.w,
          y: (point.y - best.box.y) / best.box.h,
        },
      }
    : null;
}

/** A click is a point; a drag is an area, whose middle is the pin's point. Both stay on the screen. */
export function pinDraft(
  board: Pick<DesignReviewScreen, 'file' | 'after' | 'h'>,
  width: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
  boxes: Record<string, DesignRect>,
  dragged: boolean,
): PinDraft {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const [x1, x2] = [clamp(Math.min(start.x, end.x), width), clamp(Math.max(start.x, end.x), width)];
  const [y1, y2] = [
    clamp(Math.min(start.y, end.y), board.h),
    clamp(Math.max(start.y, end.y), board.h),
  ];
  const area = dragged && x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
  const point = area
    ? { x: area.x + area.w / 2, y: area.y + area.h / 2 }
    : { x: clamp(start.x, width), y: clamp(start.y, board.h) };
  const anchor = pinAnchor(point, boxes);
  return {
    board: board.file,
    width,
    revision: board.after,
    ...point,
    ...(anchor ?? {}),
    ...(area ? { area } : {}),
  };
}

/** The request that saves a new pin: the iPhone's body, with the words. */
export function pinBody(item: string, draft: PinDraft, text: string) {
  return { item, ...draft, text: text.trim() };
}

/**
 * Where a saved pin sits on a screen drawn at `width`, as the iPhone places it: by the layer it
 * holds to when that layer is there, otherwise only at the width it was made at.
 */
export function pinPlacement(
  pin: Pick<DesignReviewPin, 'x' | 'y' | 'width' | 'layer' | 'offset' | 'area'>,
  boxes: Record<string, DesignRect>,
  width: number,
): { point: { x: number; y: number }; area: DesignRect | null } | null {
  const box = pin.layer ? boxes[pin.layer] : undefined;
  if (box && pin.offset) {
    const point = { x: box.x + pin.offset.x * box.w, y: box.y + pin.offset.y * box.h };
    return {
      point,
      area: pin.area
        ? { ...pin.area, x: pin.area.x + point.x - pin.x, y: pin.area.y + point.y - pin.y }
        : null,
    };
  }
  return pin.width === width ? { point: { x: pin.x, y: pin.y }, area: pin.area ?? null } : null;
}

/** Pins made in this round. Older coordinators do not give a round: this round's came after it. */
export function roundPins(review: Pick<DesignReview, 'pins' | 'round' | 'createdAt'>) {
  const round = review.round ?? 1;
  return review.pins.filter((pin) =>
    pin.round === undefined
      ? Date.parse(pin.createdAt) >= Date.parse(review.createdAt)
      : pin.round === round,
  );
}

/** The number the server will give the next pin: one more than any in the review's lineage. */
export const nextPinNumber = (review: Pick<DesignReview, 'pins'>) =>
  Math.max(0, ...review.pins.map((pin) => pin.number)) + 1;

/** Which pins a screen shows on a side: this round's open ones made on that side. */
export function screenPins(
  review: Pick<DesignReview, 'pins' | 'round' | 'createdAt'>,
  board: Pick<DesignReviewScreen, 'file' | 'before' | 'main'>,
  side: ReviewSide,
) {
  return roundPins(review).filter((pin) => {
    if (pin.resolved || pin.noteId || pin.board !== board.file) return false;
    const before = pin.drawing
      ? pin.drawing.side === 'before'
      : pin.revision === board.before || pin.revision === board.main;
    return side === 'before' ? before : !before;
  });
}

export type ReviewNoteRow = {
  id: string;
  number: number;
  text: string;
  board: string;
  screen: string;
};
/** The Comments tab's notes for the proposer: this round's pins, open ones first, and whether they went. */
export function reviewNotes(
  review: Pick<
    DesignReview,
    'pins' | 'round' | 'createdAt' | 'boards' | 'notes' | 'proposer' | 'item'
  >,
) {
  const row = (pin: DesignReviewPin): ReviewNoteRow => ({
    id: pin.id,
    number: pin.number,
    text: pin.text,
    board: pin.board,
    screen:
      review.boards.find((board) => board.file === pin.board)?.title ??
      review.notes.find((note) => note.id === pin.noteId)?.title ??
      pin.board.replace(/\.html$/, ''),
  });
  const pins = roundPins(review);
  return {
    title: review.proposer.name === 'You' ? 'Notes' : `Notes for ${review.proposer.name}`,
    open: pins.filter((pin) => !pin.resolved).map(row),
    resolved: pins.filter((pin) => pin.resolved).map(row),
    // Ask for changes sends every open pin with it.
    sent: review.item.answer?.actionId === 'changes',
  };
}

/** The pin box's head: the screen, and the layer the pin holds to when that layer has a name. */
export function pinWhere(screen: string, layerName: string | null) {
  return layerName && layerName !== 'Frame' ? `${screen} › ${layerName}` : screen;
}

/** A frame's tick: its own seen, and every shared part looked at on it. */
export function frameTicked(review: Pick<DesignReview, 'parts'>, board: DesignReviewScreen) {
  return (
    board.seen && (review.parts ?? []).every((part) => part.lookAt.file !== board.file || part.seen)
  );
}
