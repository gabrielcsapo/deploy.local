import type { DesignReview, DesignReviewSummary } from '../../../../../shared/v2/contracts';
export { nextUnseen, reviewCrop } from '../../../../../shared/v2/design-review';
export const counted = (count: number, noun: 'pin' | 'change' | 'screen') =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;
/** You proposed it yourself: the server names a proposer with no agent or task "You". */
export const proposedByYou = (proposer: DesignReview['proposer']) =>
  proposer.id === null && proposer.name === 'You';
export const missingSummary = (proposer: DesignReview['proposer']) =>
  proposedByYou(proposer)
    ? 'No summary. Add one when you propose again.'
    : `No summary. Ask ${proposer.name} to add one`;
/** "22 screens and 4 notes conflict with main": conflicts list notes as `note:<id>`. */
export function conflictCount(conflicts: string[]) {
  const notes = conflicts.filter((file) => file.startsWith('note:')).length;
  const screens = conflicts.length - notes;
  const parts = [
    screens && counted(screens, 'screen'),
    notes && `${notes} note${notes === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return `${parts.join(' and ')} conflict${conflicts.length === 1 ? 's' : ''} with main`;
}
/** Names at most two conflicts in words; with more, the Conflict tiles name them. */
export function conflictLine(
  conflicts: string[],
  name: (file: string) => string,
  proposer: DesignReview['proposer'],
) {
  const changed =
    conflicts.length <= 2
      ? `Main changed ${conflicts.map(name).join(' and ')}.`
      : 'Main changed them after this was proposed.';
  if (proposedByYou(proposer)) return `${changed} Update them with main and propose again.`;
  return `${changed} Ask ${proposer.name} to update ${conflicts.length <= 2 ? 'these screens' : 'them'}.`;
}
export const reviewHref = (id: string) => `/dashboard/inbox?item=${encodeURIComponent(id)}`;
export function reviewCounts(counts: DesignReviewSummary['counts']) {
  return [
    `${counts.screens} screen${counts.screens === 1 ? '' : 's'}`,
    `${counts.changed} changed`,
    `${counts.new} new`,
    `${counts.removed} removed`,
  ].join(' · ');
}
export function initialDesignProject(
  projects: { id: string; boards: number }[],
  requested: string | null,
  last: string | null,
) {
  return (
    projects.find((project) => project.boards > 0 && project.id === (requested || last))?.id ?? null
  );
}
export const openPins = (review: Pick<DesignReview, 'pins'>) =>
  review.pins.filter((pin) => !pin.resolved);
/**
 * The footer after a decision names the outcome, when, and how far the look got. Changes asked
 * from a task go to it; a design you proposed yourself has no task to go to.
 */
export function reviewOutcome(
  answer: { actionId: string; at: string },
  looked: { seen: number; total: number },
  task: string | null,
  when: (at: string) => string,
) {
  if (answer.actionId === 'approve') return 'Approved · this is the design on main';
  const start = `Changes requested · ${when(answer.at)}`;
  return task
    ? `${start} · you looked at ${looked.seen} of ${looked.total}`
    : `${start} · propose again when the screens are updated.`;
}
/** The chat card's "Also changed" line: every other changed screen by name. */
export const alsoChanged = (titles: string[]) =>
  titles.length ? `Also changed: ${titles.join(', ')}` : '';

/** Sent pins remain a record in every round; an approved review has no unsent changes. */
export function changesNotice(
  round: number,
  open: number,
  waiting: boolean,
  answer?: { actionId: string },
): 'sent' | 'draft' | null {
  if (!open) return null;
  if (!waiting) return answer?.actionId === 'changes' ? 'sent' : null;
  return round === 1 ? 'draft' : null;
}

/** Where an arrow key lands in a review: Left and Right walk every screen in order, crossing
 *  from one change to the next; Up and Down jump a whole change. Stays put at either end. */
export function reviewStep(
  rows: { id: string; screens: string[] }[],
  at: { id: string; screen: number },
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
): { id: string; screen: number } {
  const index = Math.max(
    0,
    rows.findIndex((row) => row.id === at.id),
  );
  const row = rows[index];
  if (!row) return at;
  const last = (entry: { screens: string[] }) => Math.max(0, entry.screens.length - 1);
  const screen = Math.min(at.screen, last(row));
  const forward = key === 'ArrowRight' || key === 'ArrowDown';
  if (key === 'ArrowLeft' && screen > 0) return { id: row.id, screen: screen - 1 };
  if (key === 'ArrowRight' && screen < last(row)) return { id: row.id, screen: screen + 1 };
  const next = rows[index + (forward ? 1 : -1)];
  if (!next) return { id: row.id, screen };
  return { id: next.id, screen: key === 'ArrowLeft' ? last(next) : 0 };
}
