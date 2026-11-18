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
export type ReviewUnit = { key: string; title: string; seen: boolean };
export function reviewUnits(review: Pick<DesignReview, 'boards' | 'groups' | 'parts'>) {
  return [
    ...(review.parts ?? []).map((part) => ({
      key: `part:${part.component}`,
      title: `${part.name} · ${screenCount(part.screens)}`,
      seen: part.seen,
    })),
    ...reviewFrames(review)
      .filter((board) => !board.instanceOnly)
      .map((board) => ({ key: board.file, title: board.title, seen: board.seen })),
  ] satisfies ReviewUnit[];
}
export const screenCount = (count: number) => `${count} screen${count === 1 ? '' : 's'}`;

/** A frame's tick: its own seen, and every shared part looked at on it. */
export function frameTicked(review: Pick<DesignReview, 'parts'>, board: DesignReviewScreen) {
  return (
    board.seen && (review.parts ?? []).every((part) => part.lookAt.file !== board.file || part.seen)
  );
}
