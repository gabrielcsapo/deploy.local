'use client';
import { useEffect, useState } from 'react';
import { Action, Head, Icon, IconButton } from '@/components/ui';
import type { InboxItem, Project } from '../../../../../shared/v2/contracts';
import type { NoteChange } from '../../../../../shared/v2/design';
import { useInbox } from '../data/hooks';
import { useData } from '../projects/data';
import { boardName } from './model';
import { BoardFrame, WidthSwitch, widthsOf } from './Review';
import './review.css';

type Review = {
  branch: string;
  before: string;
  after: string;
  boards: {
    file: string;
    w: number;
    h: number;
    added: boolean;
    lines: string[];
  }[];
  notes: (NoteChange & { page: string | null })[];
};

/** A change in the list: a board by its name, a note by its first line. */
type Picked = { kind: 'board'; file: string } | { kind: 'note'; id: string };

/**
 * A design item from Waiting on you, opened: each changed board Before and After, each rewritten
 * canvas note as its text Before and After with the new lines marked, then the decision.
 */
export function DesignItemReview({ item }: { item: InboxItem }) {
  const projectId = item.projectId ?? item.id.split(':')[1];
  const api = `/api/v2/projects/${encodeURIComponent(projectId)}/design`;
  const review = useData<Review>(`${api}/review?item=${encodeURIComponent(item.id)}`);
  const projects = useData<{ projects: Project[] }>('/api/v2/projects');
  const project = projects.data?.projects.find((entry) => entry.id === projectId);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [more, setMore] = useState(false);
  const [chosenWidth, setChosenWidth] = useState(0);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
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

  const data = review.data;
  const boards = data?.boards ?? [];
  const notes = data?.notes ?? [];
  const current: Picked | null =
    picked ??
    (boards[0]
      ? { kind: 'board', file: boards[0].file }
      : notes[0]
        ? { kind: 'note', id: notes[0].id }
        : null);
  const board = current?.kind === 'board' ? boards.find((b) => b.file === current.file) : null;
  const note = current?.kind === 'note' ? notes.find((n) => n.id === current.id) : null;
  const layoutWidth =
    board && widthsOf(board).includes(chosenWidth) ? chosenWidth : (board?.w ?? 1440);
  const column = stacked ? Math.max(160, width) : (width - 16) / 2;
  const waiting = item.state === 'waiting';
  const lines = board
    ? board.lines
    : note
      ? [
          note.after
            ? `${note.changed} of ${note.total} lines rewritten; the marked lines are new.`
            : 'The note is removed.',
          ...(boards.length ? [] : ['No board changes.']),
        ]
      : [];

  return (
    <>
      <Head
        title={item.title}
        subtitle={[project?.name, data?.branch].filter(Boolean).join(' · ')}
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
        actions={
          <span className="dzr-more">
            <IconButton
              icon="dots"
              label="More"
              aria-haspopup="menu"
              aria-expanded={more}
              onClick={() => setMore(!more)}
            />
            {more && (
              <div className="dl-menu dzr-menu" role="menu" onClick={() => setMore(false)}>
                <a
                  className="dl-menu-item"
                  role="menuitem"
                  href={`/dashboard/design?project=${encodeURIComponent(projectId)}${data ? `&ref=${encodeURIComponent(data.branch)}` : ''}`}
                >
                  Open in Design
                </a>
              </div>
            )}
          </span>
        }
      />
      <div className="dzr-line">
        <span className="dl-meta">
          {item.text.replace(/\.$/, '')}
          {waiting ? ' · waiting for your approval' : ''}
        </span>
      </div>
      {!data ? (
        <div className="dzr-empty">
          {review.error ? 'This review could not be loaded.' : 'Loading the review…'}
        </div>
      ) : (
        <div className="dzr dzr-item">
          <aside className="dzr-boards" aria-label="Changes">
            {boards.map((entry) => (
              <button
                key={entry.file}
                type="button"
                className={board?.file === entry.file ? 'on' : ''}
                aria-current={board?.file === entry.file}
                onClick={() => setPicked({ kind: 'board', file: entry.file })}
              >
                <Icon name="frame" size={13} />
                <span className="dzr-t">{boardName(entry.file)}</span>
                <span className="dzr-kind">{entry.w <= 500 ? 'Phone' : 'Web'}</span>
              </button>
            ))}
            {notes.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={note?.id === entry.id ? 'on' : ''}
                aria-current={note?.id === entry.id}
                onClick={() => setPicked({ kind: 'note', id: entry.id })}
              >
                <Icon name="sticky" size={13} />
                <span className="dzr-t">{entry.title}</span>
                <span className="dzr-kind">Note</span>
              </button>
            ))}
          </aside>
          <div className="dzr-main">
            {board && (
              <div className="dzr-head">
                <b>{boardName(board.file)}</b>
                <span className="dl-meta">design/boards/{board.file}</span>
                <WidthSwitch
                  widths={widthsOf(board)}
                  value={layoutWidth}
                  onChange={setChosenWidth}
                />
              </div>
            )}
            {note && (
              <div className="dzr-head">
                <b>{note.title}</b>
                <span className="dl-meta">
                  design/canvas.json{note.page ? ` · a note on the ${note.page} page` : ''}
                </span>
              </div>
            )}
            <div className="dzr-compare" ref={setStage}>
              {(['Before', 'After'] as const).map((label) => (
                <figure key={label}>
                  {board ? (
                    <BoardFrame
                      src={`${api}/files/${label === 'Before' ? data.before : data.after}/boards/${encodeURIComponent(board.file)}`}
                      width={Math.min(column, layoutWidth)}
                      w={layoutWidth}
                      h={board.h}
                    />
                  ) : note ? (
                    <NoteText note={note} after={label === 'After'} />
                  ) : null}
                  <figcaption>
                    {label} <span>· {label === 'Before' ? 'main' : 'this branch'}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
            {lines.length > 0 && (
              <section className="dzr-what">
                <h3>What changes</h3>
                <ul>
                  {lines.slice(0, 12).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <div className="dzr-bar">
            <ItemDecision item={item} onlyNotes={!boards.length && notes.length > 0} />
          </div>
        </div>
      )}
    </>
  );
}

/** A note's text as it was or is now: lines that went are marked in Before, new ones in After. */
function NoteText({ note, after }: { note: NoteChange; after: boolean }) {
  const lines = after
    ? note.after?.map((line) => ({ text: line.text, marked: line.added }))
    : note.before?.map((line) => ({ text: line.text, marked: line.gone }));
  if (!lines) return <div className="dzr-text empty">{after ? 'Removed' : 'Not on main'}</div>;
  return (
    <div className="dzr-text">
      {lines.map((line, index) => (
        <p key={index} className={line.marked ? (after ? 'in' : 'out') : ''}>
          {line.text}
        </p>
      ))}
    </div>
  );
}

function ItemDecision({ item, onlyNotes }: { item: InboxItem; onlyNotes: boolean }) {
  const { answer } = useInbox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const decide = async (actionId: 'approve' | 'changes', text?: string) => {
    setBusy(true);
    setError('');
    try {
      await answer(item.id, actionId, text);
    } catch {
      setError('Your answer could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  if (item.state !== 'waiting')
    return (
      <div className="dzr-decision">
        <span className="dzr-outcome">
          <Icon name="check" size={14} />
          {item.answer?.actionId === 'approve'
            ? 'Approved. This is now the design on main.'
            : item.state === 'answered'
              ? 'Changes asked.'
              : 'No longer waiting.'}
        </span>
      </div>
    );
  return (
    <div className="dzr-decision">
      {asking ? (
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
          <span className="dzr-explain">
            {onlyNotes
              ? 'Approving puts the note on main.'
              : 'Approving puts these design changes on main.'}
          </span>
        </div>
      )}
      {error && <p className="dzr-error">{error}</p>}
    </div>
  );
}
