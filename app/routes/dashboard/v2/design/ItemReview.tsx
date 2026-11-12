'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Skeleton, Action } from '@/components/ui';
import type {
  DesignReview,
  DesignReviewPin,
  DesignReviewRow,
  InboxItem,
} from '../../../../../shared/v2/contracts';
import { useInbox } from '../data/hooks';
import { request } from '../projects/data';
import {
  approvalRecord,
  buildLine,
  resolutionProgress,
  missingSummary,
  reviewHref,
  reviewStep,
} from './review-model';
import { ReviewStage, type ReviewDraft } from './ReviewStage';
import { reviewPhrases } from '../../../../../shared/v2/design-review';
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
const approvedCheck = (
  <svg
    className="dl-ok"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.75"
    role="img"
    aria-label="Approved"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12l3 3 5-6" />
  </svg>
);
/** "Just now" within a minute, then the time today, then the date. */
const decidedAt = (at: string) => {
  const then = new Date(at);
  if (Date.now() - then.getTime() < 60_000) return 'Just now';
  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return then.toDateString() === new Date().toDateString()
    ? `Today ${time}`
    : `${then.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
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
  const [continued, setContinued] = useState(false);
  const evidence = useRef<{ revision: string; changes: DesignReviewRow[] } | null>(null);
  const version = useRef(0);
  const load = useCallback(async () => {
    const read = ++version.current;
    try {
      const value = await request<DesignReview>(
        `${api}/review?item=${encodeURIComponent(item.id)}${continued ? '&evidence=all' : ''}`,
      );
      if (read === version.current) {
        const cached = evidence.current;
        if (cached?.revision === `${value.main}:${value.after}`)
          value.changes = cached.changes.map((entry) => ({
            ...entry,
            seen: entry.screens.every(
              (file) => value.boards.find((board) => board.file === file)?.seen,
            ),
          }));
        setData(value);
        setError('');
      }
    } catch (failure) {
      if (read === version.current)
        setError((failure as Error).message || 'This review could not be loaded.');
    }
  }, [api, item.id, continued]);
  const invalidate = useCallback(() => {
    version.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidate;
  }, [load, invalidate]);
  const evidenceRevision = data?.resolutions?.length ? `${data.main}:${data.after}` : '';
  useEffect(() => {
    if (!evidenceRevision || evidence.current?.revision === evidenceRevision) return;
    let cancelled = false;
    // This request draws the ordinary changes independently; the conflict already works.
    void request<DesignReview>(`${api}/review?item=${encodeURIComponent(item.id)}&evidence=all`)
      .then((fresh) => {
        if (cancelled || !fresh.changes || `${fresh.main}:${fresh.after}` !== evidenceRevision)
          return;
        evidence.current = { revision: evidenceRevision, changes: fresh.changes };
        setData((current) =>
          current && `${current.main}:${current.after}` === evidenceRevision
            ? {
                ...current,
                changes: fresh.changes!.map((entry) => ({
                  ...entry,
                  seen: entry.screens.every(
                    (file) => current.boards.find((board) => board.file === file)?.seen,
                  ),
                })),
              }
            : current,
        );
      })
      .catch(() => {
        /* Continue review retries through the normal error path. */
      });
    return () => {
      cancelled = true;
    };
  }, [api, item.id, evidenceRevision]);
  const pending = data?.landing?.state === 'pending';
  // Keep the quick refresh through the moment after landing, until the build has started.
  const settling = pending || Boolean(data?.landing?.buildDue && !data.landing.build);
  useEffect(() => {
    const timer = setInterval(
      () => {
        setClock(Date.now());
        if (settling || document.visibilityState === 'visible') void load();
      },
      settling ? 1000 : 15000,
    );
    return () => clearInterval(timer);
  }, [settling, load]);
  const normalRows: DesignReviewRow[] =
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
  const resolutions = data?.resolutions ?? [];
  const resolutionState = resolutionProgress(resolutions);
  const conflictRows: DesignReviewRow[] = resolutions.map((entry) => ({
    id: `conflict:${entry.file}`,
    title:
      data?.boards.find((board) => board.file === entry.file)?.title ??
      data?.notes.find((note) => `note:${note.id}` === entry.file)?.title ??
      entry.file,
    screens: [entry.file],
    status: 'changed',
    added: [],
    removed: [],
    variations: 0,
    nothingElse: false,
    seen: entry.kind === 'kept-both' || Boolean(entry.choice),
  }));
  const rows = [...conflictRows, ...normalRows];
  const row =
    rows.find((entry) => entry.id === selected) ??
    conflictRows.find((entry) => !entry.seen) ??
    rows[0];
  const resolution = row?.id.startsWith('conflict:')
    ? resolutions.find((entry) => entry.file === row.screens[0])
    : undefined;
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
      ? normalRows.filter((entry) =>
          entry.screens.some(
            (file) => data.boards.find((b) => b.file === file)?.changedSinceReview,
          ),
        )
      : normalRows;
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
  // The key handler reads where the review is now without re-binding on every render.
  const place = useRef({ rows, id: row?.id ?? '', screen: screenIndex });
  place.current = { rows, id: row?.id ?? '', screen: screenIndex };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        window.location.assign('/dashboard/design?view=review');
        return;
      }
      if (
        (event.target as HTMLElement)?.closest?.(
          'input,textarea,select,[contenteditable], [role="slider"]',
        )
      )
        return;
      if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown'
      ) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        const now = place.current;
        const to = reviewStep(now.rows, { id: now.id, screen: now.screen }, event.key);
        if (to.id !== now.id) {
          setSelected(to.id);
          setMenu(false);
          setReadyFile('');
        }
        setScreenIndex(to.screen);
        setDraft(null);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const ready = useCallback((file: string) => setReadyFile(file), []);
  useEffect(() => {
    if (
      row?.id.startsWith('conflict:') ||
      !row ||
      row.seen ||
      readyFile !== board?.file ||
      !data ||
      !waiting
    )
      return;
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
      if (actionId === 'changes' && draft) {
        const saved = await request<{ pins: DesignReviewPin[] }>(`${api}/review/pins`, {
          method: draft.id ? 'PATCH' : 'POST',
          body: JSON.stringify({
            item: item.id,
            ...draft,
            ...(draft.id ? { drawing: undefined } : {}),
          }),
        });
        setData((current) => current && { ...current, pins: saved.pins });
        setDraft(null);
      }
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
      await load();
      setError((failure as Error).message);
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
  const saveChoice = async (file: string, choice: 'main' | 'proposal' | null) => {
    if (!data) return;
    setSelected(`conflict:${file}`);
    setScreenIndex(0);
    version.current++;
    setBusy(true);
    try {
      await request(`${api}/review/choice`, {
        method: 'POST',
        body: JSON.stringify({
          item: item.id,
          file,
          choice,
          main: data.main,
          proposal: data.after,
        }),
      });
      if (!choice) setContinued(false);
      await load();
    } catch (failure) {
      await load();
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || !data;
  const nextReview = inbox.items.find(
    (entry) => entry.state === 'waiting' && entry.id.startsWith('design:') && entry.id !== item.id,
  );
  const record = data ? approvalRecord(data, clock, decidedAt) : null;
  const building = data && approved ? buildLine(data) : null;
  const decisions = !data ? (
    <Action variant="secondary" disabled>
      Approve
    </Action>
  ) : pending ? (
    <>
      <span className="dl-rv-status done">{approvedCheck}Approved</span>
      <span className="dl-rv-status">
        On main in {Math.max(0, Math.ceil((Date.parse(data!.landing!.at) - clock) / 1000))} s
      </span>
      <Action disabled={busy} onClick={() => void undo()}>
        Undo
      </Action>
    </>
  ) : approved && data ? (
    <>
      <span className="dl-rv-status done">{approvedCheck}Approved</span>
      <span className="dl-rv-status">On main</span>
      <a
        className="dl-btn primary"
        href={nextReview ? reviewHref(nextReview.id) : '/dashboard/design?view=review'}
      >
        {nextReview ? 'Next review' : 'Done'}
      </a>
    </>
  ) : !waiting && data ? (
    <>
      <span className="dl-rv-status">
        {approved
          ? 'Approved · on main'
          : sent
            ? `${count(open.length, 'note')} sent to ${data.proposer.name} · ${data.item.answer ? ago(data.item.answer.at).replace(/^now$/, 'just now') : 'just now'}`
            : 'Asked to update'}
      </span>
      {(sent || data.item.answer?.actionId === 'update') && (data.item.taskId ?? item.taskId) && (
        <a
          className="dl-btn secondary"
          href={`/dashboard/tasks/${encodeURIComponent(data.item.taskId ?? item.taskId!)}`}
        >
          Open the task
        </a>
      )}
    </>
  ) : resolutions.length > 0 && (!continued || !resolutionState.canContinue) ? (
    <>
      <span className="dl-rv-status">{resolutionState.label}</span>
      <Action variant="quiet" disabled={disabled} onClick={() => void decide('update')}>
        {data.proposer.name === 'You' ? 'Ask to update' : `Ask ${data.proposer.name} to update`}
      </Action>
      <Action
        variant="primary"
        disabled={disabled || !resolutionState.canContinue}
        onClick={() => {
          setContinued(true);
          if (normalRows[0]) choose(normalRows[0]);
        }}
      >
        Continue review
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
        {open.length ? `Send ${count(open.length, 'note')}` : 'Ask for changes'}
      </Action>
    </>
  );
  const rowView = (entry: DesignReviewRow) => {
    const active = entry.id === row?.id;
    const conflict = resolutions.find((part) => entry.id === `conflict:${part.file}`);
    if (conflict)
      return (
        <div className={`dl-rv-row${active ? ' on' : ''}`} key={entry.id}>
          <button
            className="dl-rv-row-top"
            onClick={() => choose(entry)}
            aria-current={active ? 'true' : undefined}
          >
            <i className={`dl-rv-tick${entry.seen ? ' done' : ''}`} />
            <b>{entry.title}</b>
            <span>{conflict.kind === 'kept-both' ? 'Kept both' : 'Same part'}</span>
          </button>
          <p className={`dl-rv-detail${conflict.kind === 'kept-both' ? ' quiet' : ''}`}>
            {conflict.detail}
          </p>
          {conflict.kind === 'same-part' && (
            <>
              <p className="dl-rv-detail quiet">
                Main: <ins>{conflict.mainChanged}</ins>
                <br />
                This proposal: <ins>{conflict.proposalChanged}</ins>
              </p>
              <span className="dl-rv-choice">
                <Action
                  variant="secondary"
                  disabled={busy || !waiting}
                  aria-pressed={conflict.choice === 'main'}
                  onClick={() =>
                    void saveChoice(conflict.file, conflict.choice === 'main' ? null : 'main')
                  }
                >
                  Keep main’s
                </Action>
                <Action
                  variant="primary"
                  disabled={busy || !waiting}
                  aria-pressed={conflict.choice === 'proposal'}
                  onClick={() =>
                    void saveChoice(
                      conflict.file,
                      conflict.choice === 'proposal' ? null : 'proposal',
                    )
                  }
                >
                  Keep this proposal’s
                </Action>
                {conflict.choice && waiting && (
                  <Action disabled={busy} onClick={() => void saveChoice(conflict.file, null)}>
                    Undo
                  </Action>
                )}
              </span>
            </>
          )}
        </div>
      );
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
            {entry.changeWords ? (
              <p className="dl-rv-detail dl-rv-words">{entry.changeWords}</p>
            ) : entry.status === 'pixelsOnly' ? (
              <p className="dl-rv-detail">Looks different; no element changed</p>
            ) : (
              (entry.added.length > 0 ||
                entry.removed.length > 0 ||
                entry.addedIcon ||
                entry.removedIcon) && (
                <p className="dl-rv-detail dl-rv-words">
                  {(entry.added.length > 0 || entry.addedIcon) && (
                    <>
                      Added <ins>{reviewPhrases(entry.added, entry.addedIcon)}</ins>.{' '}
                    </>
                  )}
                  {(entry.removed.length > 0 || entry.removedIcon) && (
                    <>
                      Removed <del>{reviewPhrases(entry.removed, entry.removedIcon)}</del>.
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
                placeholder={unsent ? 'Anything else? (optional)' : 'What should change?'}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                required={!unsent}
              />
              <div className="actions">
                <Action onClick={() => setPopover(null)}>Cancel</Action>
                <Action
                  type="submit"
                  variant="primary"
                  disabled={
                    busy || (!unsent && !feedback.trim()) || Boolean(draft && !draft.text.trim())
                  }
                >
                  Send
                </Action>
              </div>
            </>
          )}
        </form>
      )}
      <div className="dl-rv-bar">
        <button className="dl-rv-pick" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <b>
            {resolution
              ? row?.title
              : data && data.round > 1
                ? 'Your notes'
                : (row?.title ?? 'Changes')}
          </b>{' '}
          {data && (
            <span>
              {resolution
                ? `· conflict ${conflictRows.findIndex((entry) => entry.id === row?.id) + 1} of ${conflictRows.length} ⌄`
                : data.round > 1
                  ? `· ${data.pins.filter((pin) => pin.resolved).length} of ${data.pins.length} addressed ⌄`
                  : `· ${row ? rows.indexOf(row) + 1 : 0} of ${rows.length} changes ⌄`}
            </span>
          )}
        </button>
        <span className="dl-rv-grow" />
        {resolution ? (
          <span>{resolutionState.label}</span>
        ) : (
          row &&
          data?.round === 1 && (
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
          )
        )}
      </div>
      {menu && (
        <div className="dl-rv-picker">
          {rows.map(rowView)}
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
          {data && data.round > 1 && (
            <section>
              <h2>Your notes</h2>
              {data.pins.map((pin) => (
                <button
                  className="dl-rv-row"
                  key={pin.id}
                  onClick={() => {
                    const target = rows.find((entry) => entry.screens.includes(pin.board));
                    if (target) {
                      choose(target);
                      setScreenIndex(target.screens.indexOf(pin.board));
                      setDraft({ ...pin });
                    }
                  }}
                >
                  {pin.text} · {pin.resolved ? 'Addressed' : 'Open'}
                </button>
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
          {record && (
            <div className="dl-rv-record">
              <b>{approvedCheck}You approved this</b>
              <span>{record.text}</span>
            </div>
          )}
          {resolutions.length > 0 && (
            <>
              <div className="dl-rv-notice">
                <strong>
                  Main changed {resolutions.length} of these{' '}
                  {resolutions.every((entry) => !entry.file.startsWith('note:'))
                    ? 'screens'
                    : 'screens and notes'}{' '}
                  too
                </strong>
                Choose what to keep on each. Nothing reaches main until you approve.
              </div>
              <section className="dl-rv-section">
                <h2 className="dl-rv-label">
                  <span>Changed on main too</span>
                  <span>{resolutionState.label}</span>
                </h2>
                {conflictRows.map(rowView)}
              </section>
            </>
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
                      setDraft({ ...pin });
                    }
                  }}
                >
                  <span className="dl-rv-row-top">
                    <span className="dl-rv-num">{pin.number}</span>
                    <b>{pin.text}</b>
                  </span>
                  <p className={`dl-rv-detail${pin.resolved ? ' dl-rv-addressed' : ' quiet'}`}>
                    {pin.resolved ? 'Addressed' : 'Open'}
                  </p>
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
            <h2 className="dl-rv-label" hidden={!data}>
              <span>{data && data.round > 1 ? 'Changed since your review' : 'Changes'}</span>
              <span>
                {resolutions.length && !continued ? `${changedRows.length} · after this` : progress}
              </span>
            </h2>
            {data ? (
              (!resolutions.length || continued) && changedRows.map(rowView)
            ) : (
              <Skeleton rows={3} label="Loading the review" />
            )}
          </section>
          {data && data.round > 1 && (
            <section className="dl-rv-section">
              <h2 className="dl-rv-label">Unchanged</h2>
              <details>
                <summary className="dl-rv-row dl-rv-row-top">
                  <i className="dl-rv-tick done" />
                  <b>{count(rows.length - changedRows.length, 'change')} you already saw</b>
                </summary>
                {rows.filter((entry) => !changedRows.includes(entry)).map(rowView)}
              </details>
            </section>
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
            {resolutions.length > 0 && waiting && !continued ? (
              `${data?.proposer.name === 'You' ? 'Ask to update' : `Ask ${data?.proposer.name} to update`} hands ${resolutions.length === 2 ? 'both screens' : 'these screens'} back instead.`
            ) : building ? (
              <>
                {building.text}
                {building.taskId && (
                  <>
                    {' '}
                    <a
                      className="dl-link"
                      href={`/dashboard/tasks/${encodeURIComponent(building.taskId)}`}
                    >
                      Open the task
                    </a>
                  </>
                )}
              </>
            ) : sent ? (
              `${data?.proposer.name} will propose again here. Your notes stay on the screens until then.`
            ) : data && data.round > 1 ? (
              'Old is your last review.'
            ) : (
              ''
            )}
          </div>
        </aside>
        {board ? (
          <ReviewStage
            key={`${row?.id}:${board.file}:${board.after}:${resolution ? data?.main : ''}`}
            api={api}
            board={
              resolution
                ? {
                    ...board,
                    before: data!.main,
                    added: resolution.mainExists === false,
                    removed: resolution.proposalExists === false,
                  }
                : { ...board, resolution: undefined }
            }
            pins={
              approved
                ? []
                : (data?.pins.filter(
                    (pin) => pin.board === board.file && (!pin.resolved || draft?.id === pin.id),
                  ) ?? [])
            }
            draft={draft?.board === board.file ? draft : null}
            setDraft={setDraft}
            save={() => void saveNote()}
            busy={busy}
            editable={Boolean(waiting)}
            ready={ready}
          />
        ) : (
          <div className="dl-rv-stage">
            {resolution ? (
              <div className="dl-rv-detail" role="status">
                <b>Main</b>
                <p>{resolution.mainChanged}</p>
                <b>This proposal</b>
                <p>{resolution.proposalChanged}</p>
              </div>
            ) : (
              <Skeleton block label="Loading the design" />
            )}
          </div>
        )}
      </div>
      <div className="dl-rv-bottom">
        <em>
          {record && data?.item.answer
            ? `You approved this ${decidedAt(data.item.answer.at)
                .replace(/^Just now$/, 'just now')
                .replace(/^Today /, 'at ')}.${building && !pending ? ` ${building.text}` : ''}`
            : data
              ? progress
              : ''}
        </em>
        {decisions}
      </div>
    </div>
  );
}
