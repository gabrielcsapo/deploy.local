'use client';
import { Skeleton } from '@/components/ui';
import { useState } from 'react';
import { DesignItemReview } from './ItemReview';
import { alsoChanged, reviewCrop, reviewHref, counted } from './review-model';
import { previewKey, useReviewPreviews, type Preview } from './ReviewPreviews';
import type {
  DesignReview,
  DesignReviewScreen,
  ConversationEvent,
  InboxItem,
} from '../../../../../shared/v2/contracts';
import { useData } from '../projects/data';
import { type Canvas, type LayerChange } from './model';
import './review.css';

type Changes = {
  base: string;
  commit: string;
  files: { status: string; path: string; layers?: LayerChange[] }[];
};

/** What a task changed in its project's design, and the review request for it. */
export function useTaskDesign(projectId: string | undefined, taskId: string) {
  const api = projectId ? `/api/v2/projects/${encodeURIComponent(projectId)}/design` : '';
  const [version, setVersion] = useState(0);
  const changes = useData<Changes>(
    api ? `${api}/changes?task=${encodeURIComponent(taskId)}&v=${version}` : undefined,
  );
  const canvas = useData<{ canvas: Canvas | null }>(
    api && changes.data ? `${api}?ref=${changes.data.commit}` : undefined,
  );
  const beforeCanvas = useData<{ canvas: Canvas | null }>(
    api && changes.data ? `${api}?ref=${changes.data.base}` : undefined,
  );
  const proposals = useData<{ proposals: InboxItem[] }>(
    api ? `${api}/proposals?v=${version}` : undefined,
  );
  const boards = (changes.data?.files ?? [])
    .filter((file) => file.path.startsWith('design/boards/'))
    .map((file) => file.path.slice('design/boards/'.length));
  const proposal = proposals.data?.proposals.find(
    (item) => item.taskId === taskId && item.state !== 'withdrawn',
  );
  return {
    api,
    changes: changes.data,
    canvas: canvas.data?.canvas ?? null,
    beforeCanvas: beforeCanvas.data?.canvas ?? null,
    boards,
    proposal,
    refresh: () => setVersion((n) => n + 1),
  };
}
type TaskDesign = ReturnType<typeof useTaskDesign>;

/** The task bar's line while a design decision is open or made. */
export function designStatus(design: TaskDesign) {
  const count = `${design.boards.length} board${design.boards.length === 1 ? '' : 's'} changed in design/`;
  const answer = design.proposal?.state === 'answered' ? design.proposal.answer?.actionId : null;
  if (answer === 'approve') return `${count} · approved`;
  if (answer === 'changes') return `${count} · changes asked`;
  return `${count} · waiting for your approval`;
}

/** A board as it is at a commit, scaled to fit a width. */
export function BoardFrame({
  src,
  width,
  w,
  h,
}: {
  src: string;
  width: number;
  w: number;
  h: number;
}) {
  // `w` is the width the board lays out at (1440, 700 or 390); `width` is how wide it shows.
  const scale = width / w;
  return (
    <div className="dzr-frame" style={{ width, height: h * scale }}>
      <iframe
        title="Board"
        sandbox="allow-same-origin"
        src={src}
        width={w}
        height={h}
        loading="lazy"
        tabIndex={-1}
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  );
}

/** The widths a board is reviewed at: web boards at 1440 and 700, phone boards at their own. */
export const widthsOf = (board: { w: number }) => (board.w <= 500 ? [board.w] : [1440, 700]);

export function WidthSwitch({
  widths,
  value,
  onChange,
}: {
  widths: number[];
  value: number;
  onChange: (width: number) => void;
}) {
  if (widths.length < 2) return null;
  return (
    <div className="dl-seg" role="radiogroup" aria-label="Width">
      {widths.map((width) => (
        <a
          key={width}
          href="#"
          role="radio"
          aria-checked={value === width}
          className={value === width ? 'on' : ''}
          onClick={(event) => {
            event.preventDefault();
            onChange(width);
          }}
        >
          {width}
        </a>
      ))}
    </div>
  );
}

/** Every entry point opens the same review, with the same pins and decision checks. */
export function DesignReview({
  projectId,
  taskId,
  design,
}: {
  projectId: string;
  taskId: string;
  design: TaskDesign;
}) {
  if (design.proposal)
    return <DesignItemReview key={design.proposal.id} item={design.proposal} embedded />;
  return (
    <div className="dzr-empty">
      <a
        className="dl-btn secondary"
        href={`/dashboard/design?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(taskId)}`}
      >
        Open in Design
      </a>
    </div>
  );
}

const noScreens: DesignReviewScreen[] = [];
/** The review's screens in canvas order, as the review lists them. */
function canvasOrder(review: DesignReview) {
  const remaining = [...review.boards];
  const ordered: DesignReviewScreen[] = [];
  for (const file of review.groups.flatMap((group) => group.boards)) {
    const index = remaining.findIndex((board) => board.file === file);
    if (index >= 0) ordered.push(...remaining.splice(index, 1));
  }
  return [...ordered, ...remaining];
}

/**
 * The chat card shows the first changed screen, Before on main and After on this task, cropped
 * to the change, and opens the review; decisions happen there, after the preview and conflict
 * checks.
 */
type DesignCardProps = {
  projectId: string;
  taskId?: string;
  design: Pick<TaskDesign, 'api' | 'proposal'>;
};
export function DesignCard({
  events = [],
  ...props
}: DesignCardProps & {
  /** A decision event owns its card; this instance only fills the event-delivery gap. */
  events?: ConversationEvent[];
}) {
  const item = props.design.proposal;
  if (!item || events.some((event) => event.kind === 'decision' && event.inboxItemId === item.id))
    return null;
  return <DesignCardPreview {...props} item={item} />;
}
function DesignCardPreview({
  projectId,
  taskId,
  design,
  item,
}: DesignCardProps & { item: InboxItem }) {
  const review = useData<DesignReview>(
    item ? `${design.api}/review?item=${encodeURIComponent(item.id)}` : undefined,
  );
  const screens = review.data ? canvasOrder(review.data) : noScreens;
  const shown = screens[0];
  const images = useReviewPreviews(design.api, item?.id ?? '', shown ? [shown] : noScreens);
  const preview = shown ? images.previews[previewKey(shown.file, shown.widths[0])] : undefined;
  const more = alsoChanged(screens.slice(1).map((screen) => screen.title));
  return (
    <section className="dzr-card" aria-label="Design change">
      <header className="dzr-card-head">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
        <b>{shown?.title ?? item.title}</b>
        {shown && <span className="dl-meta">1 of {counted(screens.length, 'screen')} changed</span>}
      </header>
      <div className="dzr-card-pair">
        {(['before', 'after'] as const).map(
          (side) =>
            // A new screen has no Before and a removed one no After: that side is left out.
            (!preview || preview[side]) && (
              <figure key={side}>
                <CardShot preview={preview} side={side} title={shown?.title ?? item.title} />
                <figcaption>{side === 'before' ? 'Before · main' : 'After · this task'}</figcaption>
              </figure>
            ),
        )}
      </div>
      {more && <p className="dzr-card-more">{more}</p>}
      <footer className="dzr-card-foot">
        <a className="dl-btn primary" href={reviewHref(item.id)}>
          Review
        </a>
        <a
          className="dl-btn quiet"
          href={`/dashboard/design?project=${encodeURIComponent(projectId)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}`}
        >
          Open in Design
        </a>
      </footer>
    </section>
  );
}

/** The card's mini is 264 by 165, like the board's; the screen fills it around the change. */
const cardMini = { width: 264, height: 165 };
/** The part of a screen the card shows: the change with context, in the mini's proportions. */
export function cardRegion(
  preview: Pick<Preview, 'width' | 'height' | 'areas' | 'crop'>,
  side: 'before' | 'after',
) {
  const rects = preview.areas.map((area) => area[side]).filter((rect) => rect !== null);
  const crop = rects.length ? reviewCrop(preview.width, preview.height, rects) : preview.crop;
  const aspect = cardMini.width / cardMini.height;
  // Keep the board's zoom: a changed wrapper must not shrink the screen to a whole-page mini.
  const w = Math.min(
    preview.width,
    preview.height * aspect,
    preview.width > 500 ? preview.width * 0.52 : preview.width,
  );
  const h = w / aspect;
  const clamp = (value: number, max: number) => Math.min(Math.max(0, max), Math.max(0, value));
  return {
    x: clamp(crop.x + crop.w / 2 - w / 2, preview.width - w),
    y: clamp(crop.y + crop.h / 2 - h / 2, preview.height - h),
    w,
    h,
  };
}

function CardShot({
  preview,
  side,
  title,
}: {
  preview?: Preview;
  side: 'before' | 'after';
  title: string;
}) {
  const src = side === 'before' ? preview?.beforeSrc : preview?.afterSrc;
  if (!preview || !src)
    return (
      <div className="dzr-card-mini">
        <Skeleton block label={`Loading ${title}`} />
      </div>
    );
  const region = cardRegion(preview, side);
  return (
    <div className="dzr-card-mini">
      <svg
        role="img"
        aria-label={`${title}, ${side === 'before' ? 'before' : 'after'}`}
        viewBox={`${region.x} ${region.y} ${region.w} ${region.h}`}
        preserveAspectRatio="xMidYMid slice"
      >
        <image href={src} width={preview.width} height={preview.height} />
      </svg>
    </div>
  );
}
