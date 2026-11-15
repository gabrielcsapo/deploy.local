'use client';
import { Action, Skeleton } from '@/components/ui';
import { useEffect, useRef, useState } from 'react';
import { BuildDesign } from './BuildDesign';
import { approvalRecord, buildLine } from './review-model';
import { ReviewRedirect } from './ReviewRedirect';
import { alsoChanged, reviewCrop, reviewHref, counted, documentReviewHref } from './review-model';
import { previewKey, useReviewPreviews, type Preview } from './ReviewPreviews';
import type {
  DesignReview,
  DesignReviewScreen,
  ConversationEvent,
  InboxItem,
} from '../../../../../shared/v2/contracts';
import { useData } from '../projects/data';
import { designApi, designFolderOf, type Canvas, type LayerChange } from './model';
import './review.css';

type Changes = {
  base: string;
  commit: string;
  files: { status: string; path: string; layers?: LayerChange[] }[];
  /** The artifacts the task changed instead of design/, each with its kind. */
  artifacts?: { artifact: string; kind: 'design' | 'document'; files: string[] }[];
};

/** What a task changed in its project's design, and the review request for it. */
export function useTaskDesign(projectId: string | undefined, taskId: string) {
  const appApi = projectId ? designApi(projectId) : '';
  const [version, setVersion] = useState(0);
  const changes = useData<Changes>(
    appApi ? `${appApi}/changes?task=${encodeURIComponent(taskId)}&v=${version}` : undefined,
  );
  const appBoards = (changes.data?.files ?? [])
    .filter((file) => file.path.startsWith('design/boards/'))
    .map((file) => file.path.slice('design/boards/'.length));
  // A task that works on an artifact instead of design/ shows that artifact here.
  const target = appBoards.length ? undefined : changes.data?.artifacts?.[0];
  const artifact = target?.artifact ?? null;
  const document = target?.kind === 'document' ? target.artifact : null;
  const api = projectId ? designApi(projectId, artifact) : '';
  const canvas = useData<{ canvas: Canvas | null }>(
    api && changes.data && !document ? `${api}?ref=${changes.data.commit}` : undefined,
  );
  const beforeCanvas = useData<{ canvas: Canvas | null }>(
    api && changes.data && !document ? `${api}?ref=${changes.data.base}` : undefined,
  );
  const proposals = useData<{ proposals: InboxItem[] }>(
    api && changes.data ? `${api}/proposals?v=${version}` : undefined,
  );
  const boardsDir = `${designFolderOf(artifact)}/boards/`;
  const boards = target
    ? target.files
        .filter((path) => path.startsWith(boardsDir))
        .map((path) => path.slice(boardsDir.length))
    : appBoards;
  const proposal = proposals.data?.proposals.find(
    (item) => item.taskId === taskId && item.state !== 'withdrawn',
  );
  return {
    api,
    artifact,
    document,
    changes: changes.data,
    canvas: canvas.data?.canvas ?? null,
    beforeCanvas: beforeCanvas.data?.canvas ?? null,
    boards,
    proposal,
    /** What the Design tab counts: changed boards, or the document once it is proposed. */
    count: document ? (proposal ? 1 : 0) : boards.length,
    refresh: () => setVersion((n) => n + 1),
  };
}
type TaskDesign = ReturnType<typeof useTaskDesign>;

/** The task bar's line while a design decision is open or made. */
export function designStatus(design: TaskDesign) {
  const count = `${design.boards.length} board${design.boards.length === 1 ? '' : 's'} changed in ${designFolderOf(design.artifact)}/`;
  const answer = design.proposal?.state === 'answered' ? design.proposal.answer?.actionId : null;
  if (answer === 'approve') return `${count} · approved`;
  if (answer === 'changes') return `${count} · changes asked`;
  return `${count} · waiting for your approval`;
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
    return (
      <ReviewRedirect
        item={design.proposal.id}
        href={
          design.document
            ? documentReviewHref(projectId, design.document, design.proposal.id)
            : undefined
        }
      />
    );
  return (
    <div className="dzr-empty">
      <a
        className="dl-btn secondary"
        href={`/dashboard/design?project=${encodeURIComponent(projectId)}${design.artifact ? `&artifact=${encodeURIComponent(design.artifact)}` : ''}&task=${encodeURIComponent(taskId)}`}
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
    item ? `${design.api}/review?item=${encodeURIComponent(item.id)}&evidence=text` : undefined,
  );
  const refreshReview = useRef(review.refresh);
  refreshReview.current = review.refresh;
  useEffect(() => {
    if (item.answer?.actionId !== 'approve') return;
    refreshReview.current();
    const timer = window.setInterval(
      () => refreshReview.current(),
      review.data?.landing?.state === 'pending' ? 1000 : 15000,
    );
    return () => window.clearInterval(timer);
  }, [item.id, item.answer?.actionId, review.data?.landing?.state]);
  const approved = item.answer?.actionId === 'approve';
  const building = review.data ? buildLine(review.data) : null;
  const record = review.data ? approvalRecord(review.data, Date.now(), () => '') : null;
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
      {approved && !review.data && <p className="dzr-card-more">Approved</p>}
      {review.error && (
        <p className="dzr-card-more" role="alert">
          {review.error} <Action onClick={review.refresh}>Retry</Action>
        </p>
      )}
      {approved && review.data && (
        <p className="dzr-card-more">
          Approved ·{' '}
          {review.data?.landing?.state === 'pending' ? (
            `on main in ${record?.seconds ?? 30} s`
          ) : (
            <>
              on main
              {review.data?.landing?.commit
                ? ` as ${review.data.landing.commit.slice(0, 7)}`
                : ''}{' '}
              ·{' '}
              {building?.taskId ? (
                <a href={`/dashboard/tasks/${encodeURIComponent(building.taskId)}`}>
                  {building.text}
                </a>
              ) : (
                'not built yet'
              )}
            </>
          )}
        </p>
      )}
      <footer className="dzr-card-foot">
        {approved && review.data && (
          <BuildDesign
            key={item.id}
            review={review.data}
            api={design.api}
            refresh={review.refresh}
            inChat
          />
        )}
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
