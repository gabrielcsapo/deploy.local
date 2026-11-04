import type { DesignReview, DesignReviewSummary } from '../../../../../shared/v2/contracts';
export { nextUnseen, reviewCrop } from '../../../../../shared/v2/design-review';
export const counted = (count: number, noun: 'pin' | 'change' | 'screen') =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;
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
