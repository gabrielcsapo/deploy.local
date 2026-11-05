'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Action, Head, Icon, IconButton } from '@/components/ui';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import type {
  DesignReview,
  DesignReviewPin,
  DesignReviewScreen,
  InboxItem,
} from '../../../../../shared/v2/contracts';
import type { NoteChange } from '../../../../../shared/v2/design';
import { useInbox } from '../data/hooks';
import { request } from '../projects/data';
import { WidthSwitch } from './Review';
import {
  conflictCount,
  conflictLine,
  missingSummary,
  nextUnseen,
  openPins,
  reviewCounts,
  counted,
} from './review-model';
import {
  previewKey,
  ReviewCrop,
  useReviewPreviews,
  useReviewPinPreview,
  type Preview,
} from './ReviewPreviews';
import { reviewDrawingPath } from '../../../../../shared/v2/design-review';
import './review.css';

type Picked = { kind: 'board'; file: string } | { kind: 'note'; id: string };
type Draft = {
  id?: string;
  number: number;
  board: string;
  noteId: string | null;
  width: number;
  revision: string;
  x: number;
  y: number;
  text: string;
};
const noBoards: DesignReviewScreen[] = [];
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

export function DesignItemReview({
  item,
  embedded = false,
}: {
  item: InboxItem;
  embedded?: boolean;
}) {
  const api = `/api/v2/projects/${encodeURIComponent(item.projectId ?? item.id.split(':')[1])}/design`;
  const inbox = useInbox();
  const [data, setData] = useState<DesignReview>();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [chosenWidth, setChosenWidth] = useState(1440);
  const [revision, setRevision] = useState<'before' | 'after'>('after');
  const [changes, setChanges] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [allPins, setAllPins] = useState(false);
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState('');
  const gridScroll = useRef<HTMLDivElement>(null);
  const pinTray = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const readVersion = useRef(0);
  const invalidateReads = useCallback(() => {
    readVersion.current++;
  }, []);
  const load = useCallback(async () => {
    const version = ++readVersion.current;
    setChecking(true);
    try {
      const value = await request<DesignReview>(
        `${api}/review?item=${encodeURIComponent(item.id)}`,
      );
      if (version !== readVersion.current) return;
      setData(value);
      setError('');
    } catch {
      if (version === readVersion.current) setError('This review could not be loaded. Try again.');
    } finally {
      if (version === readVersion.current) setChecking(false);
    }
  }, [api, item.id]);
  useEffect(() => {
    setData(undefined);
    setPicked(null);
    setDraft(null);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30000);
    return () => {
      invalidateReads();
      window.clearInterval(timer);
    };
  }, [load, invalidateReads]);
  const boards = data?.boards ?? noBoards;
  const board =
    picked?.kind === 'board' ? boards.find((entry) => entry.file === picked.file) : undefined;
  const note =
    picked?.kind === 'note' ? data?.notes.find((entry) => entry.id === picked.id) : undefined;
  const pins = data?.pins ?? [];
  const selectedDrawing = pins.find(
    (pin) =>
      pin.id === draft?.id && pin.drawing && pin.board === board?.file && pin.width === chosenWidth,
  );
  const width = selectedDrawing
    ? selectedDrawing.width
    : board?.widths.includes(chosenWidth)
      ? chosenWidth
      : (board?.widths[0] ?? chosenWidth);
  const images = useReviewPreviews(
    api,
    item.id,
    boards,
    board?.widths.includes(width) ? { file: board.file, width } : undefined,
  );
  const currentPreview = board ? images.previews[previewKey(board.file, width)] : undefined;
  const historicalPin =
    selectedDrawing &&
    (![board?.before, board?.after].includes(selectedDrawing.revision) ||
      !board?.widths.includes(selectedDrawing.width) ||
      (currentPreview && currentPreview.height !== selectedDrawing.drawing!.nativeHeight))
      ? selectedDrawing
      : undefined;
  const historical = useReviewPinPreview(api, historicalPin);
  const preview = historicalPin ? historical.preview : currentPreview;
  const unresolved = data ? openPins(data) : [];
  const waiting =
    (inbox.items.find((entry) => entry.id === item.id) ?? data?.item ?? item).state === 'waiting';
  const loading = !data || !images.ready || (Boolean(board) && !preview);
  // A conflict's Close and Ask to update wait only for the conflict check, not for previews.
  const disabled = data?.stale
    ? checking || busy || Boolean(error)
    : loading || checking || busy || Boolean(error) || Boolean(images.error);
  const seenCount = boards.filter((entry) => entry.seen).length;
  const activeBoards =
    data?.round && data.round > 1 ? boards.filter((entry) => entry.changedSinceReview) : boards;
  const sequence = board && !board.changedSinceReview ? boards : activeBoards;
  const index = board ? sequence.findIndex((entry) => entry.file === board.file) : -1;
  const openBoard = useCallback((file: string) => {
    setPicked({ kind: 'board', file });
    setRevision('after');
    setDraft(null);
    setAllPins(false);
  }, []);
  const leave = () => {
    setPicked(null);
    setDraft(null);
  };
  const step = (delta: number) => {
    const next = sequence[index + delta];
    if (next) openBoard(next.file);
  };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (draft) setDraft(null);
        else setPicked(null);
        return;
      }
      if (
        !board ||
        draft ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable]'))
      )
        return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const next = sequence[index + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (next) openBoard(next.file);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [board, draft, sequence, index, openBoard]);
  const shownFile = board?.file;
  const wasSeen = board?.seen;
  const previewReady = Boolean(preview) && !historicalPin;
  const proposalRevision = data?.after;
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || !preview) return;
    const shot = Array.from(element.querySelectorAll<HTMLElement>('.dl-review-shot-image')).find(
      (image) => image.getBoundingClientRect().width > 0,
    );
    if (!shot) return;
    // Compact layouts scroll the viewer (including its pins); wide layouts scroll the stage.
    const scroller =
      getComputedStyle(element).overflowY === 'auto' ? element : element.parentElement!;
    const first = preview.areas[0];
    const rect = first?.after ?? first?.before;
    const header = element.querySelector<HTMLElement>('.dl-review-stage-head');
    const scale = shot.getBoundingClientRect().width / preview.width;
    scroller.scrollTop = rect
      ? Math.max(
          0,
          scroller.scrollTop +
            shot.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            rect.y * scale -
            (header?.offsetHeight ?? 0) -
            48,
        )
      : 0;
  }, [shownFile, preview]);
  useEffect(() => {
    if (!shownFile || wasSeen || !previewReady || !proposalRevision) return;
    let timer: number | undefined;
    const mark = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      timer = window.setTimeout(() => {
        void request(`${api}/review/seen`, {
          method: 'POST',
          body: JSON.stringify({ item: item.id, board: shownFile, revision: proposalRevision }),
        })
          .then(() =>
            setData(
              (current) =>
                current && {
                  ...current,
                  boards: current.boards.map((entry) =>
                    entry.file === shownFile ? { ...entry, seen: true } : entry,
                  ),
                },
            ),
          )
          .catch(() => setError('Your review progress could not be saved. Try again.'));
      }, 1000);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [api, item.id, proposalRevision, shownFile, wasSeen, previewReady]);

  const savePin = async (method: 'POST' | 'PATCH' | 'DELETE', body: object) => {
    readVersion.current++;
    setChecking(false);
    setBusy(true);
    try {
      const value = await request<{ pins: DesignReviewPin[] }>(`${api}/review/pins`, {
        method,
        body: JSON.stringify({ ...body, item: item.id }),
      });
      setData((current) => current && { ...current, pins: value.pins });
      setDraft(null);
      setError('');
    } catch {
      setError('Your pin could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const editPin = (pin: DesignReviewPin) => {
    setChanges(true);
    if (pin.noteId) setPicked({ kind: 'note', id: pin.noteId });
    else openBoard(pin.board);
    setChosenWidth(pin.width);
    const onBoard = boards.find((entry) => entry.file === pin.board);
    setRevision(
      pin.revision === onBoard?.before
        ? 'before'
        : pin.revision === onBoard?.after
          ? 'after'
          : (pin.drawing?.side ?? 'after'),
    );
    setDraft(pin);
    setAllPins(false);
  };
  const decide = async (action: 'approve' | 'changes' | 'update') => {
    setBusy(true);
    try {
      const result = await inbox.answer(
        item.id,
        action,
        action === 'changes' ? feedback.trim() : undefined,
      );
      if (result?.conflict) throw new Error('This decision changed meanwhile');
      setAsking(false);
      setFeedback('');
      await load();
    } catch {
      setError('Your answer could not be saved. Refresh the review and try again.');
    } finally {
      setBusy(false);
    }
  };
  const countsFor = (file: string) => pins.filter((pin) => pin.board === file);
  const tiles = (entries: DesignReviewScreen[]) => (
    <div className="dl-review-grid">
      {entries.map((entry) => {
        const onScreen = countsFor(entry.file),
          open = onScreen.filter((pin) => !pin.resolved).length;
        const image = images.previews[previewKey(entry.file, entry.widths[0])];
        return (
          <button
            type="button"
            className="dl-review-tile"
            key={entry.file}
            onClick={() => openBoard(entry.file)}
          >
            <figure>
              <ReviewCrop
                preview={image}
                title={entry.title}
                changed={entry.status === 'changed'}
              />
              <figcaption>
                {entry.title}
                {image && image.areas.length > 1 && (
                  <span className="dl-review-more">+{image.areas.length - 1} more</span>
                )}
                {(entry.conflict || entry.status !== 'changed') && (
                  <span className="dl-review-tag">
                    {entry.conflict ? 'Conflict' : entry.status === 'new' ? 'New' : 'Removed'}
                  </span>
                )}
                <span className="dl-review-tile-meta">
                  <span className={entry.seen ? 'dl-review-seen' : ''}>
                    {entry.seen ? '✓ Seen' : 'Not seen'}
                  </span>
                  {data && data.round > 1 ? (
                    <span>
                      {onScreen.length
                        ? [
                            onScreen.length - open ? `${onScreen.length - open} addressed` : '',
                            open ? `${open} open` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : 'No pins'}
                    </span>
                  ) : (
                    onScreen.length > 0 && (
                      <span>
                        {onScreen.length} pin{onScreen.length === 1 ? '' : 's'}
                      </span>
                    )
                  )}
                </span>
              </figcaption>
            </figure>
          </button>
        );
      })}
    </div>
  );
  const grouped = (entries: DesignReviewScreen[]) =>
    data?.groups.map((group) => {
      const screens = entries.filter((entry) => group.boards.includes(entry.file));
      return screens.length ? (
        <section key={group.id ?? 'unplaced'}>
          <h2>
            {group.title ?? 'Screens'} · {screens.length}
          </h2>
          {tiles(screens)}
        </section>
      ) : null;
    });
  const pinRows = (entries: DesignReviewPin[]) => (
    <div className="dl-group">
      {entries.map((pin) => (
        <button
          type="button"
          className="dl-item dl-review-pin-row"
          key={pin.id}
          onClick={() => editPin(pin)}
        >
          <span className="dl-review-pin-number">{pin.number}</span>
          <span className="dl-t">
            <span>{pin.text}</span>
            <span>
              {boards.find((entry) => entry.file === pin.board)?.title ??
                data?.notes.find((entry) => entry.id === pin.noteId)?.title}
              {data && data.round > 1 ? ' · ' : ''}
              {data && data.round > 1 ? (pin.resolved ? 'Addressed' : 'Still open') : ''}
            </span>
            {pin.reply && <span className="dl-review-pin-reply">{pin.reply}</span>}
          </span>
          <span aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  );
  const next = nextUnseen(activeBoards, board?.file);
  const shownPins = allPins
    ? pins
    : pins.filter((pin) => (board ? pin.board === board.file : pin.noteId === note?.id));
  const tray = (
    <aside className="dl-review-pins" ref={pinTray}>
      <h2>
        {allPins ? 'All pins' : 'Pins on this screen'} · {shownPins.length}
      </h2>
      {pinRows(shownPins)}
      <Action variant="quiet" onClick={() => setAllPins(!allPins)}>
        {allPins ? 'This screen' : `All pins · ${pins.length}`}
      </Action>
      {draft && (
        <form
          className="dl-review-pin-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void savePin(
              draft.id ? 'PATCH' : 'POST',
              draft.id ? { id: draft.id, text: draft.text } : draft,
            );
          }}
        >
          <h2>{draft.id ? `Pin ${draft.number}` : 'Add a pin'}</h2>
          <textarea
            className="dl-review-note-field"
            autoFocus
            aria-label={`Pin ${draft.number}`}
            placeholder="What should change?"
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <div className="dl-review-pin-actions">
            <Action
              type="submit"
              variant="primary"
              disabled={!draft.text.trim() || busy || !waiting}
            >
              Save pin
            </Action>
            <Action onClick={() => setDraft(null)}>Cancel</Action>
          </div>
          {draft.id && (
            <div className="dl-review-pin-actions">
              <Action
                disabled={busy || !waiting}
                onClick={() => void savePin('DELETE', { id: draft.id })}
              >
                Delete
              </Action>
              {pins.find((pin) => pin.id === draft.id)?.resolved && (
                <Action
                  disabled={busy || !waiting}
                  onClick={() => void savePin('PATCH', { id: draft.id, resolved: false })}
                >
                  Reopen
                </Action>
              )}
            </div>
          )}
        </form>
      )}
    </aside>
  );
  return (
    <div className={`dl-review${embedded ? ' dl-review-embedded' : ''}`}>
      {(!embedded || picked) && (
        <Head
          className={picked ? 'dl-review-viewer-head' : ''}
          title={
            picked
              ? board
                ? `${boards.findIndex((entry) => entry.file === board.file) + 1} of ${boards.length}`
                : (note?.title ?? 'Design review')
              : 'Design review'
          }
          subtitle={picked ? undefined : data?.project}
          menu={
            <>
              <IconButton
                icon="menu"
                label="Show sidebar"
                className="dl-menu-btn"
                onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
              />
              {picked && (
                <Action variant="quiet" onClick={leave}>
                  ‹ Grid
                </Action>
              )}
            </>
          }
          actions={
            picked ? (
              <>
                <nav className="dl-review-navigation" aria-label="Screens">
                  <Action disabled={index <= 0} onClick={() => step(-1)}>
                    Previous
                  </Action>
                  <Action
                    disabled={index < 0 || index >= sequence.length - 1}
                    onClick={() => step(1)}
                  >
                    Next
                  </Action>
                </nav>
                <span className="dl-meta">Esc to grid</span>
              </>
            ) : (
              <a className="dl-btn quiet" href="/dashboard/design?view=review">
                To review
              </a>
            )
          }
        />
      )}
      {(error || images.error) && (
        <div className="dl-review-notice" role="alert">
          {error || images.error}{' '}
          <Action
            onClick={() => {
              void load();
              if (images.error) images.retry();
            }}
          >
            Retry
          </Action>
        </div>
      )}
      <div className="dl-review-scroll" ref={gridScroll} hidden={Boolean(picked)}>
        <div className="dl-review-content">
          <div className="dl-review-intro">
            <h1>
              {data?.round && data.round > 1
                ? 'Since your last review'
                : (data?.title ?? item.title)}
            </h1>
            {data &&
              (data.summary ? (
                <p className="dl-review-summary">{data.summary}</p>
              ) : (
                <p className="dl-meta dl-review-summary-missing">{missingSummary(data.proposer)}</p>
              ))}
            {data && (
              <>
                <p className="dl-meta dl-review-total">
                  {data.round > 1
                    ? `${counted(activeBoards.length, 'screen')} changed · ${pins.filter((pin) => pin.resolved).length} of your ${counted(pins.length, 'pin')} addressed`
                    : reviewCounts(data.counts)}
                </p>
                <div className="dl-review-byline">
                  {data.proposer.id && (
                    <AgentAvatar
                      id={data.proposer.id}
                      avatar={data.proposer.avatar ?? undefined}
                      size={24}
                    />
                  )}
                  <span>
                    {data.round > 1
                      ? `${data.proposer.name} · revised`
                      : `Proposed by ${data.proposer.name} ·`}{' '}
                    {ago(data.createdAt)}
                  </span>
                  <span>{data.round > 1 ? data.title : data.project}</span>
                </div>
                {!data.stale && data.updatedWithMainAt && (
                  <p className="dl-meta dl-review-updated">
                    Updated with main {ago(data.updatedWithMainAt)} · no conflicts
                  </p>
                )}
              </>
            )}
          </div>
          {data?.stale ? (
            <section className="dl-review-notice">
              <h2>{conflictCount(data.conflicts)}</h2>
              <p>
                {conflictLine(
                  data.conflicts,
                  (file) =>
                    file.startsWith('note:')
                      ? (data.notes.find((entry) => `note:${entry.id}` === file)?.title ??
                        'a canvas note')
                      : (boards.find((entry) => entry.file === file)?.title ?? file),
                  data.proposer,
                )}
              </p>
              {!images.ready && <ReviewLoading total={boards.length} loaded={images.loaded} />}
              {tiles(boards.filter((entry) => entry.conflict))}
            </section>
          ) : (
            <>
              {loading && (
                <ReviewLoading total={data ? boards.length : null} loaded={images.loaded} />
              )}
              {!data && (
                <div className="dl-review-grid">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="dl-review-skeleton dl-skel" />
                  ))}
                </div>
              )}
              {data && data.round === 1 && unresolved.length > 0 && (
                <section className="dl-review-notice">
                  <h2>
                    {unresolved.length} change{unresolved.length === 1 ? '' : 's'} to ask for
                  </h2>
                  <p>
                    Each pin goes to {data.proposer.name} with its screen. You can add more before
                    sending.
                  </p>
                  <details className="dl-review-all-pins">
                    <summary>All pins · {pins.length}</summary>
                    {pinRows(pins)}
                  </details>
                </section>
              )}
              {data && data.round > 1 && (
                <section>
                  <h2>Your pins · {pins.length}</h2>
                  {pinRows(pins)}
                </section>
              )}
              {data && data.round > 1 ? (
                <>
                  <section>
                    <h2>Changed since your review · {activeBoards.length}</h2>
                    {tiles(activeBoards)}
                  </section>
                  <details className="dl-review-unchanged">
                    <summary>
                      {boards.filter((entry) => !entry.changedSinceReview && entry.seen).length ===
                      boards.length - activeBoards.length
                        ? `${counted(boards.length - activeBoards.length, 'screen')} you already saw`
                        : counted(boards.length - activeBoards.length, 'screen')}{' '}
                      · unchanged
                    </summary>
                    {grouped(boards.filter((entry) => !entry.changedSinceReview))}
                  </details>
                </>
              ) : (
                grouped(boards)
              )}
              {Boolean(data?.notes.length) && (
                <section>
                  <h2>Canvas notes · {data!.notes.length} updated</h2>
                  <div className="dl-group">
                    {data!.notes.map((entry) => (
                      <button
                        className="dl-item"
                        type="button"
                        key={entry.id}
                        onClick={() => {
                          setPicked({ kind: 'note', id: entry.id });
                          setRevision('after');
                        }}
                      >
                        <span className="dl-t">{entry.title}</span>
                        <span aria-hidden="true">›</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {picked && (
        <>
          <div className="dl-review-toolbar">
            <strong>
              {board?.title ?? note?.title}
              {board?.added ? ' · New' : board?.removed ? ' · Removed' : ''}
            </strong>
            {board && (
              <button
                type="button"
                className="dl-btn quiet dl-review-pin-jump"
                onClick={() => pinTray.current?.scrollIntoView({ behavior: 'smooth' })}
              >
                {counted(countsFor(board.file).length, 'pin')} ↓
              </button>
            )}
            <span className="dl-grow" />
            {board?.added && <span className="dl-meta">After only</span>}
            {board?.removed && <span className="dl-meta">Before only</span>}
            {board && (
              <WidthSwitch
                widths={historicalPin ? [historicalPin.width] : board.widths}
                value={width}
                onChange={setChosenWidth}
              />
            )}
            {!historicalPin && (!board || (!board.added && !board.removed)) && (
              <>
                <div
                  className={`dl-seg dl-review-comparison${note ? ' note' : ''}`}
                  role="radiogroup"
                  aria-label="Revision"
                >
                  {(['before', 'after'] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      role="radio"
                      aria-checked={revision === value}
                      className={revision === value ? 'on' : ''}
                      onClick={() => setRevision(value)}
                    >
                      {value === 'before' ? 'Before' : 'After'}
                    </button>
                  ))}
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={changes}
                    onChange={(event) => setChanges(event.target.checked)}
                  />
                  Show changes
                </label>
              </>
            )}
          </div>
          <div className="dl-review-viewer">
            <div className="dl-review-stage" ref={stage}>
              {board && (
                <div className="dl-review-stage-head">
                  <p className="dl-meta dl-review-hint" hidden={Boolean(historicalPin)}>
                    Click the screen to add a pin. Use ← → to move between screens.
                  </p>
                  <div
                    className={`dl-review-screen dl-review-captions ${historicalPin || board.added || board.removed ? 'single' : ''}`}
                    data-revision={revision}
                    aria-hidden="true"
                  >
                    {(historicalPin ? historicalPin.drawing?.side === 'before' : !board.added) && (
                      <span className="before">Before</span>
                    )}
                    {(historicalPin ? historicalPin.drawing?.side === 'after' : !board.removed) && (
                      <span className="after">After</span>
                    )}
                  </div>
                </div>
              )}
              {board ? (
                preview ? (
                  <div
                    className={`dl-review-screen ${historicalPin || board.added || board.removed ? 'single' : ''}`}
                    data-revision={revision}
                  >
                    {(['before', 'after'] as const).map(
                      (side) =>
                        (side === 'before' ? preview.beforeSrc : preview.afterSrc) && (
                          <ScreenShot
                            key={side}
                            preview={preview}
                            side={side}
                            changes={changes && !historicalPin && !board.added && !board.removed}
                            pins={pins.filter(
                              (pin) =>
                                changes &&
                                pin.board === board.file &&
                                pin.width === width &&
                                pin.revision ===
                                  (historicalPin?.revision ??
                                    (side === 'before' ? board.before : board.after)),
                            )}
                            draft={
                              draft?.board === board.file &&
                              draft.width === width &&
                              draft.revision ===
                                (historicalPin?.revision ??
                                  (side === 'before' ? board.before : board.after))
                                ? draft
                                : null
                            }
                            editPin={editPin}
                            addPin={(x, y) =>
                              waiting &&
                              !historicalPin &&
                              !data?.stale &&
                              setDraft({
                                number: Math.max(0, ...pins.map((pin) => pin.number)) + 1,
                                board: board.file,
                                noteId: null,
                                width,
                                revision: side === 'before' ? board.before : board.after,
                                x,
                                y,
                                text: '',
                              })
                            }
                          />
                        ),
                    )}
                  </div>
                ) : (
                  <div className="dl-review-skeleton dl-skel" role="status">
                    {historical.error || 'Loading screen…'}
                  </div>
                )
              ) : (
                note && (
                  <div className="dl-review-note">
                    <h2>{note.title}</h2>
                    <NoteText note={note} after={revision === 'after'} changes={changes} />
                  </div>
                )
              )}
            </div>
            {tray}
          </div>
        </>
      )}
      <footer className="dl-review-footer">
        {!waiting ? (
          <span className="dl-meta">
            {(data?.item ?? item).answer?.actionId === 'approve'
              ? 'Approved. This is now the design on main.'
              : 'Changes requested.'}
          </span>
        ) : data?.stale ? (
          <>
            <a className="dl-btn secondary" href="/dashboard/design?view=review">
              Close
            </a>
            <Action variant="primary" disabled={disabled} onClick={() => void decide('update')}>
              Ask to update
            </Action>
          </>
        ) : asking ? (
          <form
            className="dl-review-feedback"
            onSubmit={(event) => {
              event.preventDefault();
              void decide('changes');
            }}
          >
            <textarea
              className="dl-review-note-field"
              autoFocus
              placeholder="What should change?"
              aria-label="What should change?"
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
            />
            <Action type="submit" variant="primary" disabled={disabled || !feedback.trim()}>
              Send
            </Action>
            <Action onClick={() => setAsking(false)}>Cancel</Action>
          </form>
        ) : (
          <>
            <div className="dl-review-progress">
              <span className="dl-meta">
                {loading
                  ? `Loading ${data ? counted(boards.length, 'screen') : 'the review'}…`
                  : `You’ve looked at ${seenCount} of ${boards.length}`}
              </span>
              <Action
                variant="quiet"
                disabled={!next || !data}
                onClick={() => next && openBoard(next)}
              >
                {next || !data ? 'Next unseen' : 'All screens seen'}
              </Action>
            </div>
            {unresolved.length > 0 && (
              <Action variant="primary" disabled={disabled} onClick={() => void decide('changes')}>
                Ask for {unresolved.length} change{unresolved.length === 1 ? '' : 's'}
              </Action>
            )}
            <Action
              variant={unresolved.length ? 'secondary' : 'primary'}
              disabled={disabled}
              onClick={() => void decide('approve')}
            >
              Approve design
            </Action>
            {!unresolved.length && (
              <Action disabled={disabled} onClick={() => setAsking(true)}>
                Ask for changes
              </Action>
            )}
          </>
        )}
      </footer>
    </div>
  );
}

function ScreenShot({
  preview,
  side,
  changes,
  pins,
  draft,
  editPin,
  addPin,
}: {
  preview: Preview;
  side: 'before' | 'after';
  changes: boolean;
  pins: DesignReviewPin[];
  draft: Draft | null;
  editPin: (pin: DesignReviewPin) => void;
  addPin: (x: number, y: number) => void;
}) {
  return (
    <figure
      className={`dl-review-shot ${side}`}
      aria-label={side === 'before' ? 'Before' : 'After'}
    >
      <div
        className="dl-review-shot-image"
        style={{ maxWidth: preview.width }}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          addPin(
            Math.round(((event.clientX - bounds.left) * preview.width) / bounds.width),
            Math.round(((event.clientY - bounds.top) * preview.height) / bounds.height),
          );
        }}
      >
        <img
          alt={`${side === 'before' ? 'Before' : 'After'} screen`}
          src={(side === 'before' ? preview.beforeSrc : preview.afterSrc)!}
          width={preview.width}
          height={preview.height}
          draggable={false}
        />
        {changes && (
          <svg
            className="dl-review-outlines"
            viewBox={`0 0 ${preview.width} ${preview.height}`}
            aria-hidden="true"
          >
            {preview.areas.map((area) => {
              const rect = area[side] ?? area[side === 'before' ? 'after' : 'before'];
              return (
                rect && (
                  <rect
                    key={area.layer}
                    className="dl-review-change-outline"
                    x={rect.x}
                    y={rect.y}
                    width={rect.w}
                    height={rect.h}
                  >
                    <title>{area.words}</title>
                  </rect>
                )
              );
            })}
          </svg>
        )}
        <svg
          className="dl-review-outlines"
          viewBox={`0 0 ${preview.width} ${preview.height}`}
          aria-hidden="true"
        >
          {pins
            .filter(
              (pin) =>
                pin.drawing &&
                pin.drawing.nativeWidth === preview.width &&
                pin.drawing.nativeHeight === preview.height,
            )
            .map((pin) =>
              pin.drawing!.strokes.map((stroke, index) => (
                <path
                  key={`${pin.id}-${index}`}
                  className="dl-review-drawing"
                  d={reviewDrawingPath(pin.drawing!, stroke)}
                  strokeWidth={pin.drawing!.weight}
                />
              )),
            )}
        </svg>
        {pins.map((pin) => (
          <button
            type="button"
            className="dl-review-pin"
            key={pin.id}
            aria-label={`Pin ${pin.number}: ${pin.text}`}
            style={{
              left: `${(pin.x / preview.width) * 100}%`,
              top: `${(pin.y / preview.height) * 100}%`,
            }}
            onClick={(event) => {
              event.stopPropagation();
              editPin(pin);
            }}
          >
            {pin.number}
          </button>
        ))}
        {draft && !draft.id && (
          <span
            className="dl-review-pin"
            style={{
              left: `${(draft.x / preview.width) * 100}%`,
              top: `${(draft.y / preview.height) * 100}%`,
            }}
          >
            {draft.number}
          </span>
        )}
      </div>
    </figure>
  );
}
function NoteText({
  note,
  after,
  changes,
}: {
  note: NoteChange;
  after: boolean;
  changes: boolean;
}) {
  const lines = after
    ? note.after?.map((line) => ({ text: line.text, changed: line.added }))
    : note.before?.map((line) => ({ text: line.text, changed: line.gone }));
  return (
    <div className="dl-review-prose">
      {lines ? (
        lines.map((line, index) => (
          <p key={index} className={changes && line.changed ? 'changed' : ''}>
            {line.text || '\u00a0'}
          </p>
        ))
      ) : (
        <p>{after ? 'Removed' : 'New note'}</p>
      )}
    </div>
  );
}

/** Says what is loading; after 10 s, how many screens are still being drawn. */
function ReviewLoading({ total, loaded }: { total: number | null; loaded: number }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(timer);
  }, []);
  if (slow && total !== null && loaded < total)
    return (
      <p className="dl-notice" role="status">
        <Icon name="running" className="dl-run" />
        Still drawing {total - loaded} of {counted(total, 'screen')}. The first look at a design
        takes longer.
      </p>
    );
  return (
    <p className="dl-meta" role="status">
      Loading {total === null ? 'the review' : counted(total, 'screen')}…
    </p>
  );
}
