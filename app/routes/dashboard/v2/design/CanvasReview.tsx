'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Action, Dialog, Icon, Seg, Skeleton } from '@/components/ui';
import type {
  DesignReview,
  DesignReviewPin,
  DesignReviewPreview,
  DesignReviewScreen,
} from '../../../../../shared/v2/contracts';
import { useAgentName, useInbox } from '../data/hooks';
import { authenticatedFetch, request, useData } from '../projects/data';
import { approvalRecord, buildLine, inboxItemHref, resolutionProgress } from './review-model';
import { approveLabel } from '../../../../../shared/v2/artifacts';
import {
  frameTicked,
  nextPinNumber,
  pinBody,
  reviewProgress,
  reviewUnits,
  reviewWidthOptions,
  seenFrame,
  type PinDraft,
  type ReviewCompare,
  type ReviewSide,
} from './canvas-review-model';
import { BuildDesign } from './BuildDesign';
import { DesignBuildDecision } from '../inbox/DesignBuildDecision';

export function useCanvasReview(project: string, item: string | null) {
  const api = `/api/projects/${encodeURIComponent(project)}/design`;
  const [data, setData] = useState<DesignReview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [side, setSide] = useState<ReviewSide>('after');
  // Wipe, width and dark are for looking only: never sent, never saved, gone when the review closes.
  const [compare, setCompare] = useState<ReviewCompare>({ wipe: false, width: null, dark: false });
  const version = useRef(0);
  const loading = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!item) return;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const read = ++version.current;
    loading.current = true;
    try {
      // evidence=text: the canvas never shows the review's `changes`, so the server need not draw
      // every screen in Chromium before answering. Each screen's areas come from its preview.
      const value = await request<DesignReview>(
        `${api}/review?item=${encodeURIComponent(item)}&evidence=text`,
        {
          signal: next.signal,
        },
      );
      if (version.current === read) {
        setData(value);
        setError('');
      }
    } catch (failure) {
      if (version.current === read) setError((failure as Error).message);
    } finally {
      if (controller.current === next) loading.current = false;
    }
  }, [api, item]);
  const invalidate = useCallback(() => {
    controller.current?.abort();
    version.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidate;
  }, [load, invalidate]);
  const pending = data?.landing?.state === 'pending';
  useEffect(() => {
    if (!item) return;
    const timer = window.setInterval(
      () => {
        if (!loading.current && !busy && (pending || document.visibilityState === 'visible'))
          void load();
      },
      pending ? 1000 : 15000,
    );
    return () => window.clearInterval(timer);
  }, [item, pending, load, busy]);
  const approveFrame = useCallback(
    async (file: string) => {
      const board = data?.boards.find((entry) => entry.file === file);
      if (!data || busy || data.item.state !== 'waiting' || (board && frameTicked(data, board)))
        return;
      version.current++;
      setBusy(true);
      try {
        await request(`${api}/review/seen`, {
          method: 'POST',
          body: JSON.stringify({ item, board: file, revision: data.after }),
        });
        setData((current) => current && seenFrame(current, file, data.after));
      } catch (failure) {
        setError((failure as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [api, item, data, busy],
  );
  // Pins answer with the review's whole list; a read already on its way would bring back the old one.
  const setPins = useCallback((pins: DesignReviewPin[]) => {
    version.current++;
    setData((current) => current && { ...current, pins });
  }, []);
  // A review of a design under Artifacts reads its boards from that design's folder.
  return {
    api: data?.api ?? api,
    item,
    data,
    error,
    setError,
    busy,
    setBusy,
    side,
    setSide,
    compare,
    setCompare,
    load,
    approveFrame,
    setPins,
  };
}
export type CanvasReview = ReturnType<typeof useCanvasReview>;

/** Mounted only beside a visible iframe. The server caches geometry; no DOM diff or image fetch. */
export function ReviewAreas({
  api,
  item,
  board,
  side,
  frameDocument,
  zoom = 1,
}: {
  api: string;
  item: string;
  board: DesignReviewScreen;
  side: ReviewSide;
  frameDocument?: Document | null;
  zoom?: number;
}) {
  const width = board.widths.reduce(
    (nearest, value) => (Math.abs(value - board.w) < Math.abs(nearest - board.w) ? value : nearest),
    board.widths[0],
  );
  const result = useData<DesignReviewPreview>(
    `${api}/review/preview?item=${encodeURIComponent(item)}&board=${encodeURIComponent(board.file)}&width=${width}&scale=1&revision=${board.after}`,
    { immutable: true },
  );
  return (
    <>
      {result.error && (
        <span className="dz-review-preview-error" role="status">
          {result.error} <Action onClick={result.refresh}>Retry</Action>
        </span>
      )}
      {result.data?.areas.map((area) => {
        const cached = area[side];
        // Review rectangles are cached at canonical widths. At a custom canvas width, use
        // the same changed layer’s visible bounds; this never computes a diff or loads a board.
        const layer =
          cached && board.w !== width
            ? frameDocument?.querySelector(`[data-layer="${CSS.escape(area.layer)}"]`)
            : null;
        const measured = layer?.getBoundingClientRect();
        // Cached rectangles are wrong at another width: with nothing measured, draw none.
        const rect =
          measured?.width && measured.height
            ? { x: measured.x, y: measured.y, w: measured.width, h: measured.height }
            : board.w === width
              ? cached
              : null;
        return (
          rect && (
            <i
              key={area.layer}
              className="dz-review-area"
              title={area.words}
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.w,
                height: rect.h,
                borderWidth: 1.5 / zoom,
                borderRadius: 3 / zoom,
              }}
            />
          )
        );
      })}
    </>
  );
}

/**
 * A review's decisions and exceptional states: what the heading says, the buttons that decide,
 * and the dialogs they open. The canvas shows them in its review strip and right panel; a
 * document shows them in one bar (CanvasReviewBar).
 */
export function useReviewDecision(
  review: CanvasReview,
  suggestions: string,
  beforeDecision: (action: 'approve' | 'changes' | 'update') => Promise<string>,
) {
  const { data, setBusy, setError, load, api, item } = review;
  const inbox = useInbox();
  const [dialog, setDialog] = useState<'approve' | 'send' | 'conflicts' | 'build' | null>(null);
  const [feedback, setFeedback] = useState('');
  const [conflictFile, setConflictFile] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // A shared part counts once, however many screens show it.
  const units = data ? reviewUnits(data) : [];
  const count = data ? reviewProgress(data) : null;
  const unticked = units.filter((unit) => !unit.seen);
  const open = data?.pins.filter((pin) => !pin.resolved) ?? [];
  const resolutions = data?.resolutions ?? [];
  const resolved = resolutionProgress(resolutions);
  const waiting = data?.item.state === 'waiting';
  // An approval that hit main's own change while landing went back to waiting: it is not on main.
  const notLanded = data?.landing?.state === 'conflict' && waiting && !resolved.canContinue;
  const approved = data?.item.answer?.actionId === 'approve' && data?.landing?.state !== 'conflict';
  const pending = data?.landing?.state === 'pending';
  const proposer = data?.proposer.name;
  const askToUpdate = proposer === 'You' ? 'Ask to update' : `Ask ${proposer} to update`;
  // Who has the owner's notes, decided when they were sent. A task's notes read as before.
  const kept = !approved && data?.feedback?.delivery !== 'task' ? data?.feedback : null;
  // A document is approved as a document, and has no screens to build.
  const document = data?.item.document;
  const approve = approveLabel(document);
  const record = data ? approvalRecord(data, clock, (at) => new Date(at).toLocaleString()) : null;
  const building = data && approved ? buildLine(data) : null;
  const build = inbox.items.find((entry) => entry.designCheck?.reviewId === item);
  const next = inbox.items.find(
    (entry) => entry.id !== item && entry.id.startsWith('design:') && entry.state === 'waiting',
  );
  const decide = async (actionId: 'approve' | 'changes' | 'update') => {
    setBusy(true);
    try {
      const savedSuggestions = await beforeDecision(actionId);
      await request(`/api/inbox/${encodeURIComponent(item!)}/answer`, {
        method: 'POST',
        body: JSON.stringify({
          actionId,
          on: 'web',
          ...(actionId === 'approve' ? { delay: true } : {}),
          note: [feedback.trim(), actionId === 'changes' ? savedSuggestions : '']
            .filter(Boolean)
            .join('\n\n'),
        }),
      });
      setDialog(null);
      setFeedback('');
      inbox.retry();
      await load();
    } catch (failure) {
      await load();
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = (path: 'undo' | 'task') => async () => {
    setBusy(true);
    try {
      await request(`${api}/review/${path}`, { method: 'POST', body: JSON.stringify({ item }) });
      inbox.retry();
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choice = async (file: string, value: 'main' | 'proposal' | null) => {
    setBusy(true);
    try {
      await request(`${api}/review/choice`, {
        method: 'POST',
        body: JSON.stringify({
          item,
          file,
          choice: value,
          main: data!.main,
          proposal: data!.after,
        }),
      });
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return {
    review,
    suggestions,
    dialog,
    setDialog,
    feedback,
    setFeedback,
    conflictFile,
    setConflictFile,
    units,
    count,
    unticked,
    open,
    resolutions,
    resolved,
    waiting,
    notLanded,
    approved,
    pending,
    askToUpdate,
    kept,
    document,
    approve,
    record,
    building,
    build,
    next,
    decide,
    undo: act('undo'),
    startTask: act('task'),
    choice,
  };
}
export type ReviewDecision = ReturnType<typeof useReviewDecision>;

/** The title, who proposed it and how far the review is, or where an answered review stands. */
export function ReviewHeading({
  decision,
  progress,
}: {
  decision: ReviewDecision;
  /** What the heading counts instead of seen frames: a document's changed blocks. */
  progress?: ReactNode;
}) {
  const { data } = decision.review;
  const { notLanded, kept, approved, count, pending, record, document, building } = decision;
  return (
    <span className="dz-review-heading">
      {data ? (
        <strong>{data.title}</strong>
      ) : (
        <span className="dz-review-loading" role="status">
          Loading the review
        </span>
      )}
      {data && notLanded && (
        <span>
          {' '}
          · <strong>Did not reach main</strong> · main changed first
        </span>
      )}
      {data && kept && (
        <span>
          {' '}
          · from {data.proposer.name} · {kept.notes} note{kept.notes === 1 ? '' : 's'}{' '}
          {kept.delivery === 'terminal'
            ? `sent to a terminal on ${kept.computer}`
            : 'kept · nobody is working on it'}
        </span>
      )}
      {data && !approved && !notLanded && !kept && (
        <span>
          {' '}
          · from {data.proposer.name}
          <span className="dz-review-progress">
            {' '}
            ·{' '}
            {progress ??
              (count?.round ? (
                <>
                  {count.round} · <span className="dz-review-count">{count.count}</span>
                </>
              ) : (
                count?.count
              ))}
          </span>
        </span>
      )}
      {data && approved && (
        <span>
          {' '}
          · <Icon name="check" size={14} className="text-success align-middle" />{' '}
          {pending
            ? `Approved · on main in ${record?.seconds} s`
            : `Approved · on main${data.landing?.commit ? ` as ${data.landing.commit.slice(0, 7)}` : ''}${document ? '' : ' · '}`}
          {!pending &&
            !document &&
            (building?.taskId ? (
              <a href={`/dashboard/tasks/${encodeURIComponent(building.taskId)}`}>
                {building.text}
              </a>
            ) : (
              building?.text
            ))}
        </span>
      )}
    </span>
  );
}

/** Ask for changes and Approve design while it waits; afterwards, what can still be done. */
export function ReviewDecisions({ decision }: { decision: ReviewDecision }) {
  const { data, busy, api, load } = decision.review;
  const { notLanded, kept, waiting, resolutions, resolved, approved, pending, build, next } =
    decision;
  const { document, setDialog } = decision;
  // While the review loads, its decisions hold their place.
  if (!data)
    return (
      <>
        <Action variant="secondary" disabled>
          Ask for changes
        </Action>
        <Action variant="primary" disabled>
          {decision.approve}
        </Action>
      </>
    );
  if (notLanded)
    return (
      <>
        <Action variant="secondary" disabled={busy} onClick={() => void decision.decide('update')}>
          {decision.askToUpdate}
        </Action>
        <Action variant="primary" disabled={busy} onClick={() => setDialog('conflicts')}>
          Choose what to keep
        </Action>
      </>
    );
  if (kept)
    return kept.delivery === 'nobody' ? (
      <Action variant="primary" disabled={busy} onClick={() => void decision.startTask()}>
        Start a task
      </Action>
    ) : null;
  if (waiting)
    return (
      <>
        {resolutions.length > 0 && (
          <Action onClick={() => setDialog('conflicts')}>{resolved.label}</Action>
        )}
        <Action variant="secondary" disabled={busy} onClick={() => setDialog('send')}>
          Ask for changes
        </Action>
        <Action
          variant="primary"
          disabled={busy}
          onClick={() => setDialog(!resolved.canContinue ? 'conflicts' : 'approve')}
        >
          {decision.approve}
        </Action>
      </>
    );
  return (
    <>
      {!approved && (
        <span className="dl-meta">
          {data.item.answer?.actionId === 'changes'
            ? `Sent to ${data.proposer.name}`
            : 'Asked to update'}
        </span>
      )}
      {approved && !document && (
        <BuildDesign key={data.id} review={data} api={api} refresh={() => void load()} />
      )}
      {pending && (
        <Action disabled={busy} onClick={() => void decision.undo()}>
          Undo
        </Action>
      )}
      {build && !document && (
        <Action onClick={() => setDialog('build')}>Built design differs</Action>
      )}
      {!approved && data.item.taskId && (
        <a
          className="dl-btn quiet"
          href={`/dashboard/tasks/${encodeURIComponent(data.item.taskId)}`}
        >
          Open the task
        </a>
      )}
      {!pending && !approved && (
        <a
          className="dl-btn quiet"
          href={next ? inboxItemHref(next) : '/dashboard/design?view=review'}
        >
          {next ? 'Next review' : 'Done'}
        </a>
      )}
    </>
  );
}

/** A failed read or decision, and the 30 seconds an approval can still be undone in. */
export function ReviewNotices({ decision }: { decision: ReviewDecision }) {
  const { error, load } = decision.review;
  const { record, pending, building } = decision;
  return (
    <>
      {error && (
        <div className="dz-error" role="alert">
          {error} <Action onClick={() => void load()}>Retry</Action>
        </div>
      )}
      {record && pending && (
        <div className="dz-review-record">
          <b>You approved this</b> {record.text} {building?.text}
        </div>
      )}
    </>
  );
}

/** Approve, Ask for changes, Changed on main too and Built design differs. */
export function ReviewDialogs({ decision }: { decision: ReviewDecision }) {
  const { data, busy, setBusy, setError, api, item } = decision.review;
  const inbox = useInbox();
  const agentName = useAgentName();
  const { dialog, setDialog, feedback, setFeedback, conflictFile, setConflictFile } = decision;
  const { unticked, open, suggestions, approve, resolutions, resolved, waiting, build } = decision;
  return (
    <>
      <Dialog
        open={dialog === 'approve'}
        title={approve}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Action onClick={() => setDialog(null)}>Cancel</Action>
            <Action
              variant="primary"
              disabled={busy}
              onClick={() => void decision.decide('approve')}
            >
              {unticked.length || open.length || suggestions ? 'Approve anyway' : approve}
            </Action>
          </>
        }
      >
        {unticked.length > 0 && (
          <>
            <p>These frames haven’t been approved:</p>
            <ul>
              {unticked.map((unit) => (
                <li key={unit.key}>{unit.title}</li>
              ))}
            </ul>
          </>
        )}
        {(open.length > 0 || suggestions) && (
          <p>
            Your notes and canvas suggestions haven’t been sent. Approving puts the proposed design
            on main. <Action onClick={() => setDialog('send')}>Send notes</Action>
          </p>
        )}
        <p>You can undo for 30 seconds.</p>
      </Dialog>
      <Dialog
        open={dialog === 'send'}
        title={
          open.length
            ? `Send ${open.length} note${open.length === 1 ? '' : 's'} to ${data?.proposer.name}`
            : 'Ask for changes'
        }
        onClose={() => setDialog(null)}
        actions={
          <>
            <Action onClick={() => setDialog(null)}>Cancel</Action>
            <Action
              variant="primary"
              disabled={busy || (!feedback.trim() && !suggestions && !open.length)}
              onClick={() => void decision.decide('changes')}
            >
              Send
            </Action>
          </>
        }
      >
        <p>Each note goes with its screen. {data?.proposer.name} will propose again here.</p>
        {open.map((pin) => (
          <p key={pin.id}>
            {pin.board} · {pin.text}
            {pin.resolved ? ' · Addressed' : ''}
          </p>
        ))}
        {suggestions && <p className="dz-review-feedback">{suggestions}</p>}
        <textarea
          className="dl-field"
          aria-label="What should change?"
          placeholder={
            open.length || suggestions ? 'Anything else? (optional)' : 'What should change?'
          }
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
        />
      </Dialog>
      <Dialog
        open={dialog === 'conflicts'}
        title="Changed on main too"
        onClose={() => setDialog(null)}
        actions={
          <>
            <Action disabled={busy} onClick={() => void decision.decide('update')}>
              {decision.askToUpdate}
            </Action>
            <Action
              variant="primary"
              disabled={busy || !resolved.canContinue}
              onClick={() => setDialog(null)}
            >
              Continue review
            </Action>
          </>
        }
      >
        <p>Choose what to keep on each. Nothing reaches main until you approve.</p>
        {resolutions.map((entry) => (
          <section className="dl-section" key={entry.file}>
            <b>
              {data?.boards.find((board) => board.file === entry.file)?.title ??
                data?.notes.find((note) => `note:${note.id}` === entry.file)?.title ??
                entry.file}{' '}
              · {entry.kind === 'kept-both' ? 'Kept both' : 'Same part'}
            </b>
            <p>{entry.detail}</p>
            {data?.boards.some((board) => board.file === entry.file) && (
              <Action
                onClick={() => setConflictFile(conflictFile === entry.file ? null : entry.file)}
              >
                Before / After
              </Action>
            )}
            {conflictFile === entry.file && data && (
              <ConflictPreview
                api={api}
                item={item!}
                board={data.boards.find((board) => board.file === entry.file)!}
                main={data.main}
              />
            )}

            {entry.kind === 'same-part' && (
              <>
                <p>
                  Main: {entry.mainChanged}
                  <br />
                  This proposal: {entry.proposalChanged}
                </p>
                <span className="dl-rv-choice">
                  <Action
                    variant="secondary"
                    disabled={busy || !waiting}
                    aria-pressed={entry.choice === 'main'}
                    onClick={() =>
                      void decision.choice(entry.file, entry.choice === 'main' ? null : 'main')
                    }
                  >
                    Keep main’s
                  </Action>
                  <Action
                    variant="primary"
                    disabled={busy || !waiting}
                    aria-pressed={entry.choice === 'proposal'}
                    onClick={() =>
                      void decision.choice(
                        entry.file,
                        entry.choice === 'proposal' ? null : 'proposal',
                      )
                    }
                  >
                    Keep this proposal’s
                  </Action>
                </span>
              </>
            )}
          </section>
        ))}
      </Dialog>
      <Dialog
        open={dialog === 'build'}
        title="Built design differs"
        onClose={() => setDialog(null)}
      >
        {build && (
          <DesignBuildDecision
            item={build}
            name={build.fromName || agentName(build.from)}
            pending={busy}
            submit={(actionId) => {
              setBusy(true);
              void request(`/api/inbox/${encodeURIComponent(build.id)}/answer`, {
                method: 'POST',
                body: JSON.stringify({ actionId, on: 'web' }),
              })
                .then(() => {
                  inbox.retry();
                  setDialog(null);
                })
                .catch((failure) => setError(failure.message))
                .finally(() => setBusy(false));
            }}
          />
        )}
      </Dialog>
    </>
  );
}

/** Before and After, and Wipe on a canvas: what the review shows. */
function ReviewVersion({
  review,
  noBefore,
  wipe,
}: {
  review: CanvasReview;
  noBefore: boolean;
  wipe: boolean;
}) {
  return (
    <Seg
      label="Review version"
      value={wipe && review.compare.wipe ? 'wipe' : review.side}
      options={[
        { value: 'before', label: 'Before', disabled: noBefore },
        { value: 'after', label: 'After' },
        ...(wipe ? [{ value: 'wipe', label: 'Wipe', disabled: noBefore }] : []),
      ]}
      onChange={(value) => {
        // Wipe shows both sides; edits and notes follow After, as they do outside it.
        review.setCompare((current) => ({ ...current, wipe: value === 'wipe' }));
        review.setSide(value === 'before' ? 'before' : 'after');
      }}
    />
  );
}

/** Keeps --dz-review-bar-height on the stage, for what sits below a bar of changing height. */
function useBarHeight() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = bar.current;
    const stage = element?.parentElement;
    if (!element || !stage) return;
    const observer = new ResizeObserver(([entry]) =>
      stage.style.setProperty(
        '--dz-review-bar-height',
        `${entry.borderBoxSize[0]?.blockSize ?? element.offsetHeight}px`,
      ),
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      stage.style.removeProperty('--dz-review-bar-height');
    };
  }, []);
  return bar;
}

/** A document's review: one bar with the heading, Before and After, and the decisions. */
export function CanvasReviewBar({
  review,
  suggestions,
  beforeDecision,
  progress,
  noBefore = false,
}: {
  review: CanvasReview;
  suggestions: string;
  beforeDecision: (action: 'approve' | 'changes' | 'update') => Promise<string>;
  /** What the heading counts instead of seen frames: a document's changed blocks. */
  progress?: ReactNode;
  /** Nothing on main to compare with: Before cannot be chosen. */
  noBefore?: boolean;
}) {
  const decision = useReviewDecision(review, suggestions, beforeDecision);
  const bar = useBarHeight();
  return (
    <>
      <div ref={bar} className="dl-design-waiting-banner dz-review-bar">
        <ReviewHeading decision={decision} progress={progress} />
        <ReviewVersion review={review} noBefore={noBefore} wipe={false} />
        <ReviewDecisions decision={decision} />
      </div>
      <ReviewNotices decision={decision} />
      <ReviewDialogs decision={decision} />
    </>
  );
}

/**
 * Review is a mode of the editor: the strip above the canvas says what is being reviewed, by whom
 * and how far along, with Before / After / Wipe at its end. The decisions are in the right panel;
 * on a phone, where that panel does not show, they come here too.
 */
export function ReviewStrip({
  decision,
  loading,
  onShowLeft,
  onShowRight,
  noBefore = false,
}: {
  decision: ReviewDecision;
  /** The right panel is hidden: its show button ends the strip. */
  onShowRight?: () => void;
  /** Screens whose renders have arrived, of those being drawn; shown until all have. */
  loading?: { done: number; total: number } | null;
  /** The left panel is folded: its show button starts the strip. */
  onShowLeft?: () => void;
  noBefore?: boolean;
}) {
  const bar = useBarHeight();
  const loadingShown = loading && loading.total > 0 && loading.done < loading.total;
  return (
    <>
      <div
        ref={bar}
        className={`dl-design-waiting-banner dz-review-strip${loadingShown ? ' loading' : ''}`}
      >
        {onShowLeft && (
          <button
            type="button"
            className="dl-icon-btn dz-strip-show-left"
            aria-label="Show left panel"
            title="Show left panel"
            onClick={onShowLeft}
          >
            <Icon name="sidebar" size={15} />
          </button>
        )}
        <ReviewHeading decision={decision} />
        {loadingShown && (
          <span className="dz-strip-loading" role="status">
            Loading {loading.done} of {loading.total} screens
            <span className="dl-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((loading.done / loading.total) * 100)}%` }} />
            </span>
          </span>
        )}
        <span className="dl-grow" />
        <ReviewVersion review={decision.review} noBefore={noBefore} wipe />
        <span className="dz-strip-decide">
          <ReviewDecisions decision={decision} />
        </span>
        {onShowRight && (
          <button
            type="button"
            className="dl-icon-btn dz-strip-show-right"
            aria-label="Show right panel"
            title="Show right panel"
            onClick={onShowRight}
          >
            <Icon name="panel" size={15} />
          </button>
        )}
      </div>
      <ReviewNotices decision={decision} />
    </>
  );
}

/** Width and Dark, for looking only: in the zoom menu of a canvas review. */
export function ReviewViewItems({ review }: { review: CanvasReview }) {
  const view = review.compare;
  return (
    <>
      <div className="dz-menu-label" role="presentation">
        Width
      </div>
      {reviewWidthOptions.map(({ width, label }) => (
        <button
          key={label}
          type="button"
          className="dl-menu-item"
          role="menuitemradio"
          aria-checked={view.width === width}
          onClick={() => review.setCompare((current) => ({ ...current, width }))}
        >
          {label}
          {view.width === width && (
            <span className="dl-end">
              <Icon name="tick" size={14} />
            </span>
          )}
        </button>
      ))}
      <button
        type="button"
        className="dl-menu-item"
        role="menuitemcheckbox"
        aria-checked={view.dark}
        onClick={() => review.setCompare((current) => ({ ...current, dark: !current.dark }))}
      >
        Dark
        {view.dark && (
          <span className="dl-end">
            <Icon name="tick" size={14} />
          </span>
        )}
      </button>
    </>
  );
}

/** Only the conflict opened in the existing decision dialog requests its cached pair. */
function ConflictPreview({
  api,
  item,
  board,
  main,
}: {
  api: string;
  item: string;
  board: DesignReviewScreen;
  main: string;
}) {
  const [side, setSide] = useState<ReviewSide>('before');
  const pair = useData<DesignReviewPreview>(
    `${api}/review/preview?item=${encodeURIComponent(item)}&board=${encodeURIComponent(board.file)}&width=${board.widths[0]}&comparison=main&main=${main}`,
    { immutable: true },
  );
  const source = pair.data?.[side];
  const [image, setImage] = useState('');
  const [imageError, setImageError] = useState('');
  useEffect(() => {
    setImage('');
    setImageError('');
    if (!source) return;
    const controller = new AbortController();
    let url = '';
    void authenticatedFetch(source, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('The preview could not be loaded.');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImage(url);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setImageError(failure.message);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [source]);

  return (
    <>
      <Seg
        label="Conflict version"
        value={side}
        options={[
          { value: 'before', label: 'Main' },
          { value: 'after', label: 'This proposal' },
        ]}
        onChange={(value) => setSide(value as ReviewSide)}
      />
      {pair.error ? (
        <p role="alert">
          {pair.error} <Action onClick={pair.refresh}>Retry</Action>
        </p>
      ) : !pair.data ? (
        <Skeleton block label="Loading the conflict" />
      ) : imageError ? (
        <p role="alert">{imageError}</p>
      ) : source && !image ? (
        <Skeleton block label="Loading the conflict" />
      ) : image ? (
        <img
          className="dz-conflict-preview"
          src={image}
          alt={`${board.title} · ${side === 'before' ? 'Main' : 'This proposal'}`}
        />
      ) : (
        <p>{side === 'before' ? 'New frame · no Before' : 'Removed frame · no After'}</p>
      )}
    </>
  );
}

/** The pin being made or read again in a waiting review: a new one's place, or a saved pin. */
export type PinOpen = { draft: PinDraft; number: number } | { pin: DesignReviewPin };
export function useReviewPins(review: CanvasReview) {
  const { api, item, data, setPins } = review;
  const [open, setOpen] = useState<PinOpen | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = useCallback(
    (draft: PinDraft) => {
      if (!data) return;
      setOpen({ draft, number: nextPinNumber(data) });
      setText('');
      setError('');
    },
    [data],
  );
  const edit = useCallback((pin: DesignReviewPin) => {
    setOpen({ pin });
    setText(pin.text);
    setError('');
  }, []);
  const cancel = useCallback(() => {
    setOpen(null);
    setText('');
    setError('');
  }, []);
  const send = async (method: 'POST' | 'PATCH' | 'DELETE', body: unknown) => {
    setBusy(true);
    setError('');
    try {
      const result = await request<{ pins: DesignReviewPin[] }>(`${api}/review/pins`, {
        method,
        body: JSON.stringify(body),
      });
      setPins(result.pins);
      cancel();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // A pin open when the review stops waiting can no longer be saved, so it closes.
  const shown = data?.item.state === 'waiting' ? open : null;
  const save = () => {
    if (!shown || !item || busy || !text.trim()) return;
    void ('draft' in shown
      ? send('POST', pinBody(item, shown.draft, text))
      : send('PATCH', { item, id: shown.pin.id, text: text.trim() }));
  };
  const remove = () => {
    if (!shown || !item || busy || 'draft' in shown) return;
    void send('DELETE', { item, id: shown.pin.id });
  };
  return { open: shown, text, setText, busy, error, start, edit, cancel, save, remove };
}
export type ReviewPins = ReturnType<typeof useReviewPins>;

/** Beside a pin: its number and where it is, what should change, and Add (or Save). */
export function PinBox({
  pins,
  number,
  where,
}: {
  pins: Pick<
    ReviewPins,
    'open' | 'text' | 'setText' | 'busy' | 'error' | 'cancel' | 'save' | 'remove'
  >;
  number: number;
  where: string;
}) {
  const editing = pins.open && 'pin' in pins.open;
  return (
    <div
      className="dz-pin-box-inner"
      role="dialog"
      aria-label={`Pin ${number}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          pins.cancel();
        }
      }}
    >
      <span className="dz-pin-head">
        <b>Pin {number}</b>
        <span className="dl-meta">{where}</span>
      </span>
      <textarea
        className="dz-pin-field"
        aria-label="What should change?"
        placeholder="What should change?"
        rows={3}
        autoFocus
        value={pins.text}
        disabled={pins.busy}
        onChange={(event) => pins.setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            pins.save();
          }
        }}
      />
      {pins.error && <p className="dz-error">{pins.error}</p>}
      <span className="dz-pin-foot">
        {editing && (
          <Action variant="quiet" disabled={pins.busy} onClick={pins.remove}>
            Remove pin
          </Action>
        )}
        <span className="dl-grow" />
        <Action variant="quiet" disabled={pins.busy} onClick={pins.cancel}>
          Cancel
        </Action>
        <Action variant="primary" disabled={pins.busy || !pins.text.trim()} onClick={pins.save}>
          {editing ? 'Save' : 'Add'}
        </Action>
      </span>
    </div>
  );
}
