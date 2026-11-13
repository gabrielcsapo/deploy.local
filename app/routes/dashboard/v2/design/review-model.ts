import type { DesignReview, DesignReviewSummary } from '../../../../../shared/v2/contracts';
export { reviewCrop } from '../../../../../shared/v2/design-review';
export const counted = (count: number, noun: 'pin' | 'change' | 'screen') =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;
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
export const reviewHref = (id: string) => `/dashboard/design?review=${encodeURIComponent(id)}`;
export const ago = (at: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  return minutes < 1
    ? 'now'
    : minutes < 60
      ? `${minutes} min ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} h ago`
        : `${Math.floor(minutes / 1440)} d ago`;
};
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
/** The chat card's "Also changed" line: every other changed screen by name. */
export const alsoChanged = (titles: string[]) =>
  titles.length ? `Also changed: ${titles.join(', ')}` : '';

/** The dashed record at the top of an approved review: who decided, when, where, and where it is. */
export function approvalRecord(
  review: Pick<DesignReview, 'item' | 'landing'>,
  clock: number,
  when: (at: string) => string,
) {
  const answer = review.item.answer;
  if (answer?.actionId !== 'approve') return null;
  const where =
    answer.on === 'iphone'
      ? 'on iPhone'
      : answer.on === 'cli'
        ? 'in the terminal'
        : answer.on === 'desktop'
          ? 'in the desktop app'
          : 'on the web';
  const landing = review.landing;
  const seconds = landing ? Math.max(0, Math.ceil((Date.parse(landing.at) - clock) / 1000)) : 0;
  const place =
    landing?.state === 'pending'
      ? `It goes to main in ${seconds} s.`
      : landing?.commit
        ? `On main as ${landing.commit.slice(0, 7)}.`
        : 'On main.';
  return { seconds, text: `${when(answer.at)}, ${where}. ${place}` };
}

/** What happens now that a design is approved. Never names a builder that does not exist. */
export function buildLine(review: Pick<DesignReview, 'landing' | 'proposer' | 'item'>): {
  text: string;
  taskId?: string;
} {
  const build = review.landing?.build;
  if (build?.taskId)
    return {
      text: `${build.name ?? 'A task'} is building it`,
      taskId: build.taskId,
    };
  return { text: 'not built yet' };
}

/** Automatic merges count as resolved; only overlapping parts need an answer. */
export function resolutionProgress(resolutions: NonNullable<DesignReview['resolutions']> = []) {
  const total = resolutions.length;
  const resolved = resolutions.filter((entry) => entry.kind === 'kept-both' || entry.choice).length;
  return {
    total,
    resolved,
    canContinue: resolved === total,
    label: `${resolved} of ${total} resolved`,
  };
}

/** A remembered choice only applies when this design has a task to continue. */
export function buildPlace(proposerTaskId: string | null | undefined, saved: string | null) {
  return proposerTaskId && saved !== 'new' ? 'proposer' : 'new';
}
export function canBuildDesign(review: Pick<DesignReview, 'item' | 'landing'>) {
  return (
    review.item.answer?.actionId === 'approve' &&
    review.landing?.state === 'landed' &&
    !review.landing.build
  );
}
