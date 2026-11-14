'use client';
import { useEffect, useRef, useState } from 'react';
import { Action, Icon } from '@/components/ui';
import { request, useData } from '../projects/data';
import type { Selection } from './Canvas';
import { boardName } from './model';

export type Comment = {
  id: string;
  board: string;
  layer: string | null;
  text: string;
  author: string;
  agent: { taskId: string; title: string } | null;
  commit: string | null;
  resolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
};

function ago(at: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
}

export function useComments(projectId: string | undefined) {
  const { data, refresh } = useData<{ comments: Comment[] }>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/design/comments` : undefined,
  );
  return { comments: data?.comments ?? [], refresh };
}

/** Comments on the selected board or layer; with nothing selected, every open comment. */
export function CommentsPanel({
  projectId,
  commit,
  selection,
  select,
  comments,
  refresh,
  focus,
  nameFor,
}: {
  projectId: string;
  commit: string | undefined;
  selection: Selection;
  select: (selection: Selection) => void;
  comments: Comment[];
  refresh: () => void;
  focus: number;
  /** A layer's name in Layers, from its board when the board is loaded. */
  nameFor: (board: string, layer: string) => string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);
  const here = comments.filter(
    (comment) =>
      !selection ||
      (comment.board === selection.board &&
        (!selection.layer || comment.layer === selection.layer)),
  );
  const open = here.filter((comment) => !comment.resolved);
  const resolved = here.filter((comment) => comment.resolved);
  const target = selection
    ? selection.layer
      ? nameFor(selection.board, selection.layer)
      : boardName(selection.board)
    : null;
  const path = `/api/projects/${encodeURIComponent(projectId)}/design/comments`;
  const send = async () => {
    if (!selection || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await request(path, {
        method: 'POST',
        body: JSON.stringify({ board: selection.board, layer: selection.layer, text, commit }),
      });
      setText('');
      refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (comment: Comment) => {
    await request(`${path}/${comment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved: !comment.resolved }),
    }).catch((failure) => setError((failure as Error).message));
    refresh();
  };
  const item = (comment: Comment) => (
    <article key={comment.id} className={`dz-comment${comment.resolved ? ' resolved' : ''}`}>
      <header>
        {comment.agent ? (
          <span className="dz-agent-dot">
            <Icon name="spark" size={11} />
          </span>
        ) : (
          <span className="dl-avatar">{comment.author.slice(0, 1).toUpperCase()}</span>
        )}
        <b>{comment.agent ? comment.agent.title.replace(/^Design:\s*/, '') : comment.author}</b>
        <span className="dz-meta">{ago(comment.createdAt)}</span>
        <span className="dl-grow" />
        <button
          type="button"
          className="dz-link"
          onClick={() => resolve(comment)}
          aria-label={comment.resolved ? 'Reopen' : 'Resolve'}
        >
          {comment.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </header>
      <p>{comment.text}</p>
      <button
        type="button"
        className="dz-chip dz-chip-button"
        onClick={() => select({ board: comment.board, layer: comment.layer })}
      >
        {comment.layer
          ? `${boardName(comment.board)} › ${nameFor(comment.board, comment.layer)}`
          : boardName(comment.board)}
      </button>
    </article>
  );
  return (
    <div className="dz-comments">
      <div className="dz-comments-list">
        {open.map(item)}
        {!open.length && (
          <p className="dz-empty-note">
            {target ? `No comments on ${target} yet.` : 'No open comments on this design.'}
          </p>
        )}
        {resolved.length > 0 && (
          <button
            type="button"
            className="dz-link dz-resolved-toggle"
            onClick={() => setShowResolved(!showResolved)}
          >
            <Icon name={showResolved ? 'down' : 'chevron'} size={10} /> Resolved · {resolved.length}
          </button>
        )}
        {showResolved && resolved.map(item)}
      </div>
      <form
        className="dz-comment-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={box}
          value={text}
          rows={2}
          disabled={!selection || busy}
          placeholder={target ? `Comment on ${target}…` : 'Select a board or a layer to comment'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
          }}
        />
        {error && <p className="dz-error">{error}</p>}
        <Action
          type="submit"
          variant="primary"
          disabled={!selection || !text.trim()}
          loading={busy}
        >
          Comment
        </Action>
      </form>
    </div>
  );
}
