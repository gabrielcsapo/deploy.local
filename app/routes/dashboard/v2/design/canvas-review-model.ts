import type { DesignReview, DesignReviewScreen } from '../../../../../shared/v2/contracts';
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
/** Web boards' own width: the width button reads it until another is chosen. */
export const defaultReviewWidth = 1440;
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

/** A frame's tick: its own seen, and every shared part looked at on it. */
export function frameTicked(review: Pick<DesignReview, 'parts'>, board: DesignReviewScreen) {
  return (
    board.seen && (review.parts ?? []).every((part) => part.lookAt.file !== board.file || part.seen)
  );
}
