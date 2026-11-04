'use client';
import { useState } from 'react';
import { Icon } from '@/components/ui';
import { DesignItemReview } from './ItemReview';
import { reviewHref, counted } from './review-model';
import type { InboxItem } from '../../../../../shared/v2/contracts';
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

/** The chat card opens the proposal; decisions happen after the preview and conflict checks. */
export function DesignCard({ design }: { projectId: string; taskId: string; design: TaskDesign }) {
  const item = design.proposal;
  if (!item) return null;
  return (
    <section className="dzr-card" aria-label="Design review">
      <header>
        <Icon name="layers" size={14} />
        <b>{item.title}</b>
      </header>
      <p className="dl-meta">Design · {counted(design.boards.length, 'screen')}</p>
      <a className="dl-btn primary" href={reviewHref(item.id)}>
        Review
      </a>
    </section>
  );
}
