'use client';
import { useEffect, useState } from 'react';
import { Action, Icon } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { request, useData } from '../projects/data';
import { boardName, isPhone, type Canvas } from './model';
import './review.css';

type Changes = { base: string; commit: string; files: { status: string; path: string }[] };

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
  const proposals = useData<{ proposals: InboxItem[] }>(
    api ? `${api}/proposals?v=${version}` : undefined,
  );
  const boards = (changes.data?.files ?? [])
    .filter((file) => file.path.startsWith('design/boards/') && file.status !== 'removed')
    .map((file) => file.path.slice('design/boards/'.length));
  const proposal = proposals.data?.proposals.find(
    (item) => item.taskId === taskId && item.state !== 'withdrawn',
  );
  return {
    api,
    changes: changes.data,
    canvas: canvas.data?.canvas ?? null,
    boards,
    proposal,
    refresh: () => setVersion((n) => n + 1),
  };
}
type TaskDesign = ReturnType<typeof useTaskDesign>;

/** A board as it is at a commit, scaled to fit a width. */
function BoardFrame({ src, width, w, h }: { src: string; width: number; w: number; h: number }) {
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
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  );
}

function useDecision(design: TaskDesign, taskId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (actionId: 'approve' | 'changes', note?: string) => {
    setBusy(true);
    setError('');
    try {
      let item = design.proposal;
      if (!item || item.state !== 'waiting')
        item = (
          await request<{ item: InboxItem }>(`${design.api}/propose`, {
            method: 'POST',
            body: JSON.stringify({ task: taskId }),
          })
        ).item;
      await request(`/api/v2/inbox/${encodeURIComponent(item.id)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ actionId, on: 'web', ...(note ? { note } : {}) }),
      });
      design.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, decide };
}

function outcome(item: InboxItem | undefined) {
  if (item?.state !== 'answered') return null;
  return item.answer?.actionId === 'approve'
    ? 'Approved. This is now the design on main.'
    : 'Changes asked.';
}

function Decision({
  design,
  taskId,
  projectId,
}: {
  design: TaskDesign;
  taskId: string;
  projectId: string;
}) {
  const { busy, error, decide } = useDecision(design, taskId);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const done = outcome(design.proposal);
  const open = `/dashboard/design?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(taskId)}${design.boards[0] ? `&board=${encodeURIComponent(design.boards[0])}` : ''}`;
  return (
    <div className="dzr-decision">
      {done ? (
        <span className="dzr-outcome">
          <Icon name="check" size={14} />
          {done}
        </span>
      ) : asking ? (
        <form
          className="dzr-note"
          onSubmit={(event) => {
            event.preventDefault();
            void decide('changes', note.trim());
          }}
        >
          <textarea
            value={note}
            rows={2}
            autoFocus
            placeholder="What should change?"
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="dzr-actions">
            <Action type="submit" variant="primary" disabled={!note.trim()} loading={busy}>
              Send
            </Action>
            <Action onClick={() => setAsking(false)}>Cancel</Action>
          </div>
        </form>
      ) : (
        <div className="dzr-actions">
          <Action variant="primary" loading={busy} onClick={() => void decide('approve')}>
            Approve design
          </Action>
          <Action onClick={() => setAsking(true)}>Ask for changes</Action>
          <a className="dl-btn quiet" href={open}>
            Open in Design
          </a>
        </div>
      )}
      {error && <p className="dzr-error">{error}</p>}
    </div>
  );
}

/** The task's Design tab: each changed board before (main) and after (this task), then the decision. */
export function DesignReview({
  projectId,
  taskId,
  design,
}: {
  projectId: string;
  taskId: string;
  design: TaskDesign;
}) {
  const [selected, setSelected] = useState('');
  const [width, setWidth] = useState(0);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  // Side by side, or stacked below 820 px like the stylesheet.
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 820px)');
    const update = () => setStacked(narrow.matches);
    update();
    narrow.addEventListener('change', update);
    return () => narrow.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  const board = design.boards.includes(selected) ? selected : design.boards[0];
  const placed = board ? design.canvas?.boards[board] : undefined;
  const changes = design.changes;
  if (!changes) return <div className="dzr-empty">Loading the design…</div>;
  const column = stacked ? Math.max(160, width) : (width - 16) / 2;
  return (
    <div className="dzr">
      <aside className="dzr-boards" aria-label="Changed boards">
        <div className="dzr-label">Changed boards · {design.boards.length}</div>
        {design.boards.map((file) => (
          <button
            key={file}
            type="button"
            className={file === board ? 'on' : ''}
            aria-current={file === board}
            onClick={() => setSelected(file)}
          >
            <Icon name="frame" size={13} />
            <span className="dzr-t">{boardName(file)}</span>
          </button>
        ))}
        {changes.files
          .filter((file) => !file.path.startsWith('design/boards/'))
          .map((file) => (
            <span key={file.path} className="dzr-other">
              {file.path.replace(/^design\//, '')} · {file.status}
            </span>
          ))}
      </aside>
      <div className="dzr-main">
        <Decision design={design} taskId={taskId} projectId={projectId} />
        <div className="dzr-compare" ref={setStage}>
          {placed && board ? (
            (['Before', 'After'] as const).map((label) => (
              <figure key={label}>
                <figcaption>
                  {label} <span>{label === 'Before' ? 'main' : 'this task'}</span>
                </figcaption>
                <BoardFrame
                  src={`${design.api}/files/${label === 'Before' ? changes.base : changes.commit}/boards/${encodeURIComponent(board)}`}
                  width={isPhone(placed) ? Math.min(column, placed.w) : column}
                  w={placed.w}
                  h={placed.h}
                />
              </figure>
            ))
          ) : (
            <p className="dzr-empty">This task changed design files but no boards on the canvas.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The decision in the task's chat, under the agent's reply. */
export function DesignCard({
  projectId,
  taskId,
  design,
}: {
  projectId: string;
  taskId: string;
  design: TaskDesign;
}) {
  const [after, setAfter] = useState(true);
  const board = design.boards[0];
  const placed = board ? design.canvas?.boards[board] : undefined;
  if (!design.changes || !board || !placed) return null;
  const commit = after ? design.changes.commit : design.changes.base;
  return (
    <section className="dzr-card" aria-label="Design change">
      <header>
        <Icon name="layers" size={14} />
        <b>{boardName(board)}</b>
        <span className="dl-meta">
          {design.boards.length > 1 ? `1 of ${design.boards.length} boards` : 'design waiting'}
        </span>
        <span className="dl-grow" />
        <div className="dl-seg" role="group" aria-label="Show">
          <a
            href="#"
            className={after ? '' : 'on'}
            onClick={(event) => (event.preventDefault(), setAfter(false))}
          >
            Before
          </a>
          <a
            href="#"
            className={after ? 'on' : ''}
            onClick={(event) => (event.preventDefault(), setAfter(true))}
          >
            After
          </a>
        </div>
      </header>
      <BoardFrame
        src={`${design.api}/files/${commit}/boards/${encodeURIComponent(board)}`}
        width={isPhone(placed) ? Math.min(240, placed.w) : 420}
        w={placed.w}
        h={placed.h}
      />
      {design.boards.length > 1 && (
        <ul>
          {design.boards.slice(1, 5).map((file) => (
            <li key={file}>Also changed: {boardName(file)}</li>
          ))}
        </ul>
      )}
      <Decision design={design} taskId={taskId} projectId={projectId} />
    </section>
  );
}
