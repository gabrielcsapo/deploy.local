// Waiting on you, grouped by what you must do (design/boards/Inbox.html, canvas note
// "waiting-grouped"): Decide now, Review designs, Proposals, Answer. Each group appears with its
// first item; every item but a Decide now card is one row with one action.
import type {
  DesignRect,
  DesignReviewPreview,
  DesignReviewSummary,
  InboxItem,
} from '../../../../../shared/v2/contracts.ts';
import { reviewCrop } from '../../../../../shared/v2/design-review.ts';

export type WaitingKind = 'risk' | 'design' | 'proposal' | 'learning' | 'question';
export type WaitingGroupId = 'decide' | 'designs' | 'proposals' | 'answer';
export type WaitingGroup = { id: WaitingGroupId; label: string; items: InboxItem[] };

const groupLabels: Record<WaitingGroupId, string> = {
  decide: 'Decide now',
  designs: 'Review designs',
  proposals: 'Proposals',
  answer: 'Answer',
};
const groupOrder: WaitingGroupId[] = ['decide', 'designs', 'proposals', 'answer'];

export const isDesignItem = (item: Pick<InboxItem, 'id' | 'designCheck'>) =>
  item.id.startsWith('design:') || !!item.designCheck;

/** What kind of decision an item is: the kind mark on its tile. */
export function waitingKind(item: Pick<InboxItem, 'id' | 'kind' | 'designCheck'>): WaitingKind {
  if (isDesignItem(item)) return 'design';
  // Hard to undo on a running app: a rollback, a release, an install.
  if (item.kind === 'rollback' || item.kind === 'merge' || item.kind === 'install') return 'risk';
  // Questions in a task, and an agent asking to use the screen for one.
  if (item.kind === 'question' || item.kind === 'control') return 'question';
  return 'proposal';
}

const kindGroup: Record<WaitingKind, WaitingGroupId> = {
  risk: 'decide',
  design: 'designs',
  proposal: 'proposals',
  learning: 'proposals',
  question: 'answer',
};

/** The groups in their fixed order, newest first inside each, leaving out empty ones. */
export function waitingGroups(items: InboxItem[]): WaitingGroup[] {
  const sorted = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return groupOrder
    .map((id) => ({
      id,
      label: groupLabels[id],
      items: sorted.filter((item) => kindGroup[waitingKind(item)] === id),
    }))
    .filter((group) => group.items.length > 0);
}

/** "17 min ago", "3 hours ago", "Yesterday", "2 days ago". */
export function waitingAge(at: string, now = new Date()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.max(1, Math.round((today.getTime() - day.getTime()) / 86400000));
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

export const screensLabel = (count: number) => `${count} screen${count === 1 ? '' : 's'}`;
export const notesLabel = (count: number) => `${count} note${count === 1 ? '' : 's'}`;

/**
 * A row's one line of context: project · who asked · age, then the screens for a design. A
 * risky decision reads "Warden asked"; a question says it was asked in a task.
 */
export function contextLine(
  item: InboxItem,
  {
    project,
    who,
    review,
    now = new Date(),
  }: {
    project?: string | null;
    who: string;
    review?: Pick<DesignReviewSummary, 'project' | 'proposer' | 'counts'> | null;
    now?: Date;
  },
) {
  const kind = waitingKind(item);
  const place = review?.project ?? project ?? null;
  const asker = review?.proposer.name ?? who;
  return [
    place,
    kind === 'risk' ? `${asker} asked` : asker,
    kind === 'question' && item.taskId ? 'in a task' : null,
    waitingAge(item.createdAt, now),
    review ? screensLabel(review.counts.screens) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What a row and the open item are called: a design's proposal title from its review summary,
 * which reads better than a title saved from the branch's cut name; else the item's own.
 */
export const waitingTitle = (
  item: Pick<InboxItem, 'title'>,
  review?: Pick<DesignReviewSummary, 'title'> | null,
) => review?.title || item.title;

/** "Compute, Git, Logs, Processes, Settings and 6 more": the first five names, then a count. */
export function namedList(names: string[], shown = 5) {
  if (names.length <= shown + 1) {
    if (names.length < 2) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/** The row's action: one per row. */
export const rowAction = (item: InboxItem) =>
  waitingKind(item) === 'question' ? 'Answer' : 'Review';

/** Where a row opens: the item in Waiting on you, beside the list or as its own page. */
export const waitingHref = (item: Pick<InboxItem, 'id'>) =>
  `/dashboard/inbox?item=${encodeURIComponent(item.id)}`;

/** The item open beside the list: the one asked for, else the first row (not a Decide now card). */
export function openItem(groups: WaitingGroup[], selected: string | null) {
  const all = groups.flatMap((group) => group.items);
  return (
    all.find((item) => item.id === selected) ??
    groups.find((group) => group.id !== 'decide')?.items[0] ??
    null
  );
}

/** The shot's frame: 16 by 10, as the design system draws `.dl-asks-shot`. */
const SHOT_ASPECT = 16 / 10;
/** The frame's width before it is measured: about a pair's column at 1440. */
export const SHOT_FRAME_WIDTH = 400;
/**
 * The part of a screen both the Before and the After shot show: one rectangle in the screen's
 * own pixels, so the two can be compared. It is the review's crop (the largest change with about
 * 48 px of context and whole elements, the rectangle Show changes uses), widened to the frame's
 * proportions and to at least the frame's width, so native pixels are never enlarged, and kept
 * on the screen.
 */
export function shotRegion(
  preview: Pick<DesignReviewPreview, 'width' | 'height' | 'areas' | 'crop'>,
  frameWidth = SHOT_FRAME_WIDTH,
): DesignRect {
  const crop =
    preview.crop ??
    reviewCrop(
      preview.width,
      preview.height,
      preview.areas.flatMap((area) => {
        const rect = area.after ?? area.before;
        return rect ? [rect] : [];
      }),
    );
  // Never narrower than the frame (a narrower region would be enlarged to fill it); the whole
  // screen at most, unless the change or the frame needs more, as on a phone.
  let w = Math.max(frameWidth, crop.w, crop.h * SHOT_ASPECT);
  if (w > preview.width && frameWidth <= preview.width && crop.h * SHOT_ASPECT <= preview.width)
    w = preview.width;
  const h = w / SHOT_ASPECT;
  // On the screen where it fits; centred on it where the region is larger than the screen.
  const place = (start: number, size: number, region: number, screen: number) =>
    region >= screen
      ? (screen - region) / 2
      : Math.min(screen - region, Math.max(0, start + size / 2 - region / 2));
  return {
    x: place(crop.x, crop.w, w, preview.width),
    y: place(crop.y, crop.h, h, preview.height),
    w,
    h,
  };
}

/** What each side outlines: where the change is on that side, else where it is on the other. */
export function shotOutlines(
  preview: Pick<DesignReviewPreview, 'areas'>,
  side: 'before' | 'after',
): DesignRect[] {
  const other = side === 'before' ? 'after' : 'before';
  return preview.areas.flatMap((area) => {
    const rect = area[side] ?? area[other];
    return rect ? [rect] : [];
  });
}
