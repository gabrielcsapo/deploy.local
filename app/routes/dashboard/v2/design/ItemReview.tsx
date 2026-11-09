'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Action } from '@/components/ui';
import type {
  DesignReview,
  DesignReviewPin,
  DesignReviewRow,
  InboxItem,
} from '../../../../../shared/v2/contracts';
import { useInbox } from '../data/hooks';
import { request } from '../projects/data';
import { conflictCount, conflictLine, missingSummary } from './review-model';
import { ReviewStage, type ReviewDraft } from './ReviewStage';
import './review.css';

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
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
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
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(''),
    [screenIndex, setScreenIndex] = useState(0);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [popover, setPopover] = useState<'send' | 'approve' | null>(null);
  const [feedback, setFeedback] = useState(''),
    [menu, setMenu] = useState(false);
  const [clock, setClock] = useState(Date.now()),
    [readyFile, setReadyFile] = useState('');
  const version = useRef(0);
  const load = useCallback(async () => {
    const read = ++version.current;
    try {
      const value = await request<DesignReview>(
        `${api}/review?item=${encodeURIComponent(item.id)}`,
      );
      if (read === version.current) {
        setData(value);
        setError('');
      }
    } catch (failure) {
      if (read === version.current)
        setError((failure as Error).message || 'This review could not be loaded.');
    }
  }, [api, item.id]);
  const invalidate = useCallback(() => {
    version.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidate;
  }, [load, invalidate]);
  const pending = data?.landing?.state === 'pending';
  useEffect(() => {
    const timer = setInterval(
      () => {
        setClock(Date.now());
        if (pending || document.visibilityState === 'visible') void load();
      },
      pending ? 1000 : 15000,
    );
    return () => clearInterval(timer);
  }, [pending, load]);
  const rows: DesignReviewRow[] =
    data?.changes ??
    data?.boards.map((board) => ({
      id: board.file,
      title: board.title,
      screens: [board.file],
      status: board.status,
      added: [],
      removed: [],
      variations: 0,
      nothingElse: false,
      seen: board.seen,
    })) ??
    [];
  const row = rows.find((entry) => entry.id === selected) ?? rows[0];
  const board = data?.boards.find(
    (entry) => entry.file === row?.screens[Math.min(screenIndex, row.screens.length - 1)],
  );
  const open = data?.pins.filter((pin) => !pin.resolved) ?? [];
  const unsent = open.length + (draft && !draft.id ? 1 : 0);
  const waiting = data?.item.state === 'waiting';
  const approved = data?.item.answer?.actionId === 'approve';
  const sent = data?.item.answer?.actionId === 'changes';
  const changedRows =
    data && data.round > 1
      ? rows.filter((entry) =>
          entry.screens.some(
            (file) => data.boards.find((b) => b.file === file)?.changedSinceReview,
          ),
        )
      : rows;
  const progress = `${changedRows.filter((entry) => entry.seen).length} of ${changedRows.length} looked at`;
  const choose = (entry: DesignReviewRow) => {
    setSelected(entry.id);
    setScreenIndex(0);
    setDraft(null);
    setMenu(false);
    setReadyFile('');
  };
  const step = useCallback(
    (delta: number) => {
      setScreenIndex((index) =>
        Math.max(0, Math.min((row?.screens.length ?? 1) - 1, index + delta)),
      );
      setDraft(null);
    },
    [row?.screens.length],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (popover) setPopover(null);
        else if (draft) setDraft(null);
        else if (menu) setMenu(false);
        else window.location.assign('/dashboard/design?view=review');
        return;
      }
      if (
        (event.target as HTMLElement)?.closest?.(
          'input,textarea,select,[contenteditable], [role="slider"]',
        )
      )
        return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [popover, draft, menu, step]);
  const ready = useCallback((file: string) => setReadyFile(file), []);
  useEffect(() => {
    if (!row || row.seen || readyFile !== board?.file || !data || !waiting) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      void request(`${api}/review/seen`, {
        method: 'POST',
        body: JSON.stringify({ item: item.id, boards: row.screens, revision: data.after }),
      })
        .then(() =>
          setData(
            (current) =>
              current && {
                ...current,
                changes: current.changes?.map((entry) =>
                  entry.id === row.id ? { ...entry, seen: true } : entry,
                ),
                boards: current.boards.map((entry) =>
                  row.screens.includes(entry.file) ? { ...entry, seen: true } : entry,
                ),
              },
          ),
        )
        .catch(() => setError('Your place could not be saved. Try again.'));
    }, 1000);
    return () => clearTimeout(timer);
  }, [api, item.id, data, row, readyFile, board?.file, waiting]);
  const saveNote = async () => {
    if (!draft?.text.trim()) return;
    version.current++;
    setBusy(true);
    try {
      const value = await request<{ pins: DesignReviewPin[] }>(`${api}/review/pins`, {
        method: draft.id ? 'PATCH' : 'POST',
        body: JSON.stringify({
          item: item.id,
          ...draft,
          ...(draft.id ? { drawing: undefined } : {}),
        }),
      });
      setData((current) => current && { ...current, pins: value.pins });
      setDraft(null);
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (actionId: 'approve' | 'changes' | 'update') => {
    version.current++;
    setBusy(true);
    try {
      await request(`/api/v2/inbox/${encodeURIComponent(item.id)}/answer`, {
        method: 'POST',
        body: JSON.stringify({
          actionId,
          on: 'web',
          ...(actionId === 'approve' ? { delay: true } : {}),
          ...(feedback.trim() ? { note: feedback.trim() } : {}),
        }),
      });
      setPopover(null);
      setFeedback('');
      setDraft(null);
      inbox.retry();
      await load();
    } catch (failure) {
      setError((failure as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    setBusy(true);
    try {
      await request(`${api}/review/undo`, {
        method: 'POST',
        body: JSON.stringify({ item: item.id }),
      });
      inbox.retry();
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !data;
  const decisions = pending ? (
    <>
      <span className="dl-rv-status">
        Approved · goes to main in{' '}
        {Math.max(0, Math.ceil((Date.parse(data!.landing!.at) - clock) / 1000))} s
      </span>
      <Action disabled={busy} onClick={() => void undo()}>
        Undo
      </Action>
    </>
  ) : !waiting && data ? (
    <span className="dl-rv-status">
      {approved
        ? 'Approved · on main'
        : sent
          ? `${count(open.length, 'note')} sent to ${data.proposer.name}`
          : 'Asked to update'}
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
  ) : (
    <>
      <Action
        variant={unsent ? 'secondary' : 'primary'}
        disabled={disabled}
        onClick={() => (unsent ? setPopover('approve') : void decide('approve'))}
      >
        Approve
      </Action>
      <Action
        variant={unsent ? 'primary' : 'secondary'}
        disabled={disabled}
        onClick={() => setPopover('send')}
      >
        {unsent ? `Send ${count(unsent, 'note')}` : 'Ask for changes'}
      </Action>
    </>
  );
  const rowView = (entry: DesignReviewRow) => {
    const active = entry.id === row?.id;
    const notes = open.filter((pin) => entry.screens.includes(pin.board)).length;
    const meta =
      entry.status === 'looksSame'
        ? `${entry.screens.length} · looks the same`
        : entry.screens.length > 1
          ? count(entry.screens.length, 'screen')
          : entry.status === 'new'
            ? 'New'
            : entry.status === 'removed'
              ? 'Removed'
              : entry.status === 'pixelsOnly'
                ? ''
                : 'Changed';
    return (
      <div className={`dl-rv-row${active ? ' on' : ''}`} key={entry.id}>
        <button
          className="dl-rv-row-top"
          onClick={() => choose(entry)}
          aria-current={active ? 'true' : undefined}
        >
          <i className={`dl-rv-tick${entry.seen ? ' done' : ''}`} />
          <b>{entry.title}</b>
          <span>
            {meta}
            {notes ? ` · ${count(notes, 'note')}` : ''}
          </span>
        </button>
        {active && (
          <>
            {entry.status === 'pixelsOnly' ? (
              <p className="dl-rv-detail">Looks different; no element changed</p>
            ) : (
              (entry.added.length > 0 || entry.removed.length > 0) && (
                <p className="dl-rv-detail">
                  {entry.added.length > 0 && (
                    <>
                      Added <ins>{entry.added.join(', ')}</ins>.{' '}
                    </>
                  )}
                  {entry.removed.length > 0 && (
                    <>
                      Removed <del>{entry.removed.join(', ')}</del>.
                    </>
                  )}
                </p>
              )
            )}
            {(entry.nothingElse || entry.variations > 0) && (
              <p className="dl-rv-detail quiet">
                {entry.nothingElse &&
                  `Nothing else changed on ${entry.screens.length === 1 ? 'this screen' : 'these screens'}. `}
                {entry.variations > 0 &&
                  `On ${entry.variations} of them the label it replaces is different.`}
              </p>
            )}
            {entry.screens.length > 1 && (
              <span className="dl-rv-step">
                <span>
                  {board?.title} · {screenIndex + 1} of {entry.screens.length}
                </span>
                <button
                  aria-label="Previous screen"
                  disabled={screenIndex === 0}
                  onClick={() => step(-1)}
                >
                  ‹
                </button>
                <button
                  aria-label="Next screen"
                  disabled={screenIndex >= entry.screens.length - 1}
                  onClick={() => step(1)}
                >
                  ›
                </button>
              </span>
            )}
          </>
        )}
      </div>
    );
  };
  return (
    <div className={`dl-rv${embedded ? ' dl-rv-embedded' : ' dl-rv-focus'}`}>
      <div className="dl-rv-top">
        <a className="dl-btn quiet" href="/dashboard/design?view=review">
          ‹ To review
        </a>
        <strong>{data?.title ?? item.title}</strong>
        <span className="dl-rv-grow" />
        <span className="dl-rv-actions dl-rv-wide">{decisions}</span>
      </div>
      {error && (
        <div className="dl-rv-notice" role="alert">
          {error} <Action onClick={() => void load()}>Retry</Action>
        </div>
      )}
      {popover && (
        <form
          className="dl-rv-pop"
          role="dialog"
          aria-label={popover === 'approve' ? 'Approve with unsent notes' : 'Send notes'}
          onSubmit={(event) => {
            event.preventDefault();
            if (popover === 'send') void decide('changes');
          }}
        >
          {popover === 'approve' ? (
            <>
              <h2>
                {count(unsent, 'note')} {unsent === 1 ? 'hasn’t' : 'haven’t'} been sent
              </h2>
              <p>
                Approving puts this on main and drops your {unsent === 1 ? 'note' : 'notes'}. You
                can undo for 30 seconds.
              </p>
              <div className="actions">
                <Action disabled={busy} onClick={() => void decide('approve')}>
                  Approve anyway
                </Action>
                <Action variant="primary" onClick={() => setPopover('send')}>
                  Send {unsent === 1 ? 'note' : 'notes'}
                </Action>
              </div>
            </>
          ) : (
            <>
              <h2>
                {unsent
                  ? `Send ${count(unsent, 'note')} to ${data?.proposer.name}`
                  : 'Ask for changes'}
              </h2>
              <p>Each note goes with its screen. {data?.proposer.name} will propose again here.</p>
              <textarea
                autoFocus
                aria-label="What should change?"
                placeholder="Anything else?"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                required={!open.length}
              />
              <div className="actions">
                <Action onClick={() => setPopover(null)}>Cancel</Action>
                <Action
                  type="submit"
                  variant="primary"
                  disabled={busy || (!open.length && !feedback.trim()) || Boolean(draft)}
                >
                  Send
                </Action>
              </div>
              {draft && <p>Save your note on the design before sending.</p>}
            </>
          )}
        </form>
      )}
      <div className="dl-rv-bar">
        <button className="dl-rv-pick" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <b>{row?.title ?? 'Changes'}</b>{' '}
          <span>
            · {rows.indexOf(row!) + 1} of {rows.length} changes ⌄
          </span>
        </button>
        <span className="dl-rv-grow" />
        {row && (
          <>
            <span>
              {screenIndex + 1} of {row.screens.length}
            </span>
            <button
              aria-label="Previous screen"
              disabled={screenIndex === 0}
              onClick={() => step(-1)}
            >
              ‹
            </button>
            <button
              aria-label="Next screen"
              disabled={screenIndex >= row.screens.length - 1}
              onClick={() => step(1)}
            >
              ›
            </button>
          </>
        )}
      </div>
      {menu && (
        <div className="dl-rv-picker">
          {rows.map(rowView)}
          {data && data.round > 1 && (
            <section>
              <h2>Your notes</h2>
              {data.pins.map((pin) => (
                <p key={pin.id}>
                  {pin.text} · {pin.resolved ? 'Addressed' : 'Open'}
                </p>
              ))}
            </section>
          )}
        </div>
      )}
      <div className="dl-rv-body">
        <aside className="dl-rv-rail">
          <div className="dl-rv-about">
            <p>{data?.summary ?? (data ? missingSummary(data.proposer) : '')}</p>
            {data && (
              <p className="by">
                {data.proposer.name} · {ago(data.createdAt)} · {count(data.boards.length, 'screen')}
              </p>
            )}
          </div>
          {data?.stale && (
            <div className="dl-rv-notice">
              <strong>{conflictCount(data.conflicts)}</strong>
              {conflictLine(
                data.conflicts,
                (file) => data.boards.find((b) => b.file === file)?.title ?? file,
                data.proposer,
              )}
            </div>
          )}
          {data && data.round > 1 && (
            <section className="dl-rv-section">
              <h2 className="dl-rv-label">
                <span>Your notes</span>
                <span>
                  {data.pins.filter((pin) => pin.resolved).length} of {data.pins.length} addressed
                </span>
              </h2>
              {data.pins.map((pin) => (
                <button
                  className="dl-rv-row"
                  key={pin.id}
                  onClick={() => {
                    const target = rows.find((entry) => entry.screens.includes(pin.board));
                    if (target) {
                      choose(target);
                      setScreenIndex(target.screens.indexOf(pin.board));
                    }
                  }}
                >
                  <span className="dl-rv-row-top">
                    <span className="dl-rv-num">{pin.number}</span>
                    <b>{pin.text}</b>
                    <span>{pin.resolved ? 'Addressed' : 'Open'}</span>
                  </span>
                  {pin.reply && (
                    <p className="dl-rv-detail quiet">
                      {data.proposer.name}: {pin.reply}
                    </p>
                  )}
                </button>
              ))}
            </section>
          )}
          <section className="dl-rv-section">
            <h2 className="dl-rv-label">
              <span>{data && data.round > 1 ? 'Changed since your review' : 'Changes'}</span>
              <span>{progress}</span>
            </h2>
            {data ? (
              changedRows.map(rowView)
            ) : (
              <p className="dl-rv-detail quiet">Loading the review…</p>
            )}
          </section>
          {data && data.round > 1 && (
            <details className="dl-rv-section">
              <summary className="dl-rv-label">
                Unchanged · {count(rows.length - changedRows.length, 'change')} you already saw
              </summary>
              {rows.filter((entry) => !changedRows.includes(entry)).map(rowView)}
            </details>
          )}
          {Boolean(data?.notes.length) && (
            <details className="dl-rv-section">
              <summary className="dl-rv-label">Canvas notes · {data!.notes.length} updated</summary>
              {data!.notes.map((note) => (
                <div className="dl-rv-row" key={note.id}>
                  <b>{note.title}</b>
                  {note.after?.map((line, index) => (
                    <p key={index}>{line.text}</p>
                  ))}
                </div>
              ))}
            </details>
          )}
          <div className="dl-rv-foot">
            {approved
              ? `${data?.proposer.name} starts building once this is on main.`
              : sent
                ? `${data?.proposer.name} will propose again here. Your notes stay on the screens until then.`
                : data && data.round > 1
                  ? 'Old is your last review.'
                  : ''}
          </div>
        </aside>
        {board ? (
          <ReviewStage
            key={`${board.file}:${board.after}`}
            api={api}
            board={board}
            pins={approved ? [] : (data?.pins.filter((pin) => pin.board === board.file) ?? [])}
            draft={draft?.board === board.file ? draft : null}
            setDraft={setDraft}
            save={() => void saveNote()}
            busy={busy}
            editable={Boolean(waiting && !data?.stale)}
            ready={ready}
          />
        ) : (
          <div className="dl-rv-stage">
            <div className="dl-rv-skeleton dl-skel" role="status">
              {data ? '' : 'Loading the design…'}
            </div>
          </div>
        )}
      </div>
      <div className="dl-rv-bottom">
        <em>{progress}</em>
        {decisions}
      </div>
    </div>
  );
}
