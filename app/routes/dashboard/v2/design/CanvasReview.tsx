'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Action, Dialog, Icon, Seg, Skeleton } from '@/components/ui';
import type {
  DesignReview,
  DesignReviewPreview,
  DesignReviewScreen,
} from '../../../../../shared/v2/contracts';
import { useAgentName, useInbox } from '../data/hooks';
import { authenticatedFetch, request, useData } from '../projects/data';
import { approvalRecord, buildLine, inboxItemHref, resolutionProgress } from './review-model';
import { approveLabel } from '../../../../../shared/v2/artifacts';
import { reviewFrames, seenFrame, type ReviewSide } from './canvas-review-model';
import { BuildDesign } from './BuildDesign';
import { DesignBuildDecision } from '../inbox/DesignBuildDecision';

export function useCanvasReview(project: string, item: string | null) {
  const api = `/api/projects/${encodeURIComponent(project)}/design`;
  const [data, setData] = useState<DesignReview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [side, setSide] = useState<ReviewSide>('after');
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
      if (
        !data ||
        busy ||
        data.item.state !== 'waiting' ||
        data.boards.find((board) => board.file === file)?.seen
      )
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
    load,
    approveFrame,
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
        const rect =
          measured?.width && measured.height
            ? { x: measured.x, y: measured.y, w: measured.width, h: measured.height }
            : cached;
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

/** Existing decisions and exceptional states, reached from the canvas bar. */
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
  /** What the heading counts instead of approved frames: a document's changed blocks. */
  progress?: ReactNode;
  /** Nothing on main to compare with: Before cannot be chosen. */
  noBefore?: boolean;
}) {
  const { data, busy, setBusy, setError, load, api, item } = review;
  const inbox = useInbox();
  const agentName = useAgentName();
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
  const [dialog, setDialog] = useState<'approve' | 'send' | 'conflicts' | 'build' | null>(null);
  const [feedback, setFeedback] = useState('');
  const [conflictFile, setConflictFile] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const frames = data ? reviewFrames(data) : [];
  const unticked = frames.filter((board) => !board.seen);
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
  const undo = async () => {
    setBusy(true);
    try {
      await request(`${api}/review/undo`, { method: 'POST', body: JSON.stringify({ item }) });
      inbox.retry();
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startTask = async () => {
    setBusy(true);
    try {
      await request(`${api}/review/task`, { method: 'POST', body: JSON.stringify({ item }) });
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
  return (
    <>
      <div ref={bar} className="dl-design-waiting-banner dz-review-bar">
        <span className="dz-review-heading">
          {data ? <strong>{data.title}</strong> : <Skeleton rows={1} label="Loading the review" />}
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
              · from {data.proposer.name} ·{' '}
              {progress ?? (
                <>
                  {frames.filter((board) => board.seen).length} of {frames.length} approved
                </>
              )}
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
        <Seg
          label="Review version"
          value={review.side}
          options={[
            { value: 'before', label: 'Before', disabled: noBefore },
            { value: 'after', label: 'After' },
          ]}
          onChange={(value) => review.setSide(value as ReviewSide)}
        />
        {!data ? (
          <Skeleton label="Loading review decisions" />
        ) : notLanded ? (
          <>
            <Action variant="secondary" disabled={busy} onClick={() => void decide('update')}>
              {askToUpdate}
            </Action>
            <Action variant="primary" disabled={busy} onClick={() => setDialog('conflicts')}>
              Choose what to keep
            </Action>
          </>
        ) : kept ? (
          kept.delivery === 'nobody' && (
            <Action variant="primary" disabled={busy} onClick={() => void startTask()}>
              Start a task
            </Action>
          )
        ) : waiting ? (
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
              {approve}
            </Action>
          </>
        ) : (
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
              <Action disabled={busy} onClick={() => void undo()}>
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
        )}
      </div>
      {review.error && (
        <div className="dz-error" role="alert">
          {review.error} <Action onClick={() => void load()}>Retry</Action>
        </div>
      )}
      {record && pending && (
        <div className="dz-review-record">
          <b>You approved this</b> {record.text} {building?.text}
        </div>
      )}
      <Dialog
        open={dialog === 'approve'}
        title={approve}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Action onClick={() => setDialog(null)}>Cancel</Action>
            <Action variant="primary" disabled={busy} onClick={() => void decide('approve')}>
              {unticked.length || open.length || suggestions ? 'Approve anyway' : approve}
            </Action>
          </>
        }
      >
        {unticked.length > 0 && (
          <>
            <p>These frames haven’t been approved:</p>
            <ul>
              {unticked.map((board) => (
                <li key={board.file}>{board.title}</li>
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
              onClick={() => void decide('changes')}
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
            <Action disabled={busy} onClick={() => void decide('update')}>
              {askToUpdate}
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
                    onClick={() => void choice(entry.file, entry.choice === 'main' ? null : 'main')}
                  >
                    Keep main’s
                  </Action>
                  <Action
                    variant="primary"
                    disabled={busy || !waiting}
                    aria-pressed={entry.choice === 'proposal'}
                    onClick={() =>
                      void choice(entry.file, entry.choice === 'proposal' ? null : 'proposal')
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
