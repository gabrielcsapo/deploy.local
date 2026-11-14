'use client';
import { useEffect, useRef, useState } from 'react';
import { Action, Icon } from '@/components/ui';
import { request, useData } from '../projects/data';
import type { Computer } from '../../../../../shared/v2/contracts';
import type { Selection } from './Canvas';
import {
  boardFile,
  boardName,
  describeChange,
  designApi,
  isPhone,
  type Canvas,
  type LayerChange,
} from './model';
import { useDesignArtifact } from './artifact-context';

export type Ask = {
  id: string;
  title: string;
  status: string;
  branch: string;
  board: string;
  layer: string | null;
  ref: string;
  commit: string;
  text?: string;
  askedAt: string;
};
export type Change = { status: string; path: string; layers?: LayerChange[] };
export type OverlayMode = 'mine' | 'overlay' | 'agent';

export function useAsks(
  projectId: string | undefined,
  version: number,
  artifact: string | null = null,
) {
  const { data, refresh } = useData<{ asks: Ask[] }>(
    projectId ? `${designApi(projectId, artifact)}/asks?v=${version}` : undefined,
  );
  return { asks: data?.asks ?? [], refresh };
}

/** Ask an agent about the selection: the request, what goes with it, and where it runs. */
export function AskPopover({
  projectId,
  designRef,
  selection,
  target,
  comments,
  position,
  onClose,
  onAsked,
  component,
}: {
  projectId: string;
  designRef: string;
  /** The board or layer asked about; absent when asking about a component. */
  selection: Selection;
  /** A design-system component from Assets, asked about instead of a layer. */
  component?: { id: string; name: string };
  /** The selection's name in Layers. */
  target: string;
  comments: number;
  position: { left: number; top: number };
  onClose: () => void;
  onAsked: (task: string) => void;
}) {
  const artifact = useDesignArtifact();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // Where the task runs: any free computer, or one that takes tasks and is online.
  const computers = useData<{ computers: Computer[] }>('/api/computers');
  const takers = (computers.data?.computers ?? []).filter(
    (computer) => computer.online && computer.roles.includes('take-tasks') && computer.workerIds[0],
  );
  const [worker, setWorker] = useState('');
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { task } = await request<{ task: { id: string } }>(
        `${designApi(projectId, artifact)}/ask?ref=${encodeURIComponent(designRef)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(component
              ? { component: component.id }
              : selection
                ? { board: selection.board, layer: selection.layer }
                : // A design with nothing on it yet is asked about as a whole.
                  { board: '', layer: null }),
            text,
            workerId: worker || undefined,
          }),
        },
      );
      onAsked(task.id);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <div
      className="dz-ask"
      role="dialog"
      aria-label="Ask an agent"
      style={{ left: position.left, top: position.top }}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
    >
      <div className="dz-ask-h">
        <Icon name="spark" size={14} />
        <span className="dz-desk-only">Ask an agent about {target}</span>
        <span className="dz-phone-only">Ask an agent</span>
        <span className="dz-meta dz-desk-only">⌘K</span>
        <button
          type="button"
          className="dl-icon-btn dz-phone-only dz-ask-close"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="dz-crumb dz-phone-only">
        {component
          ? `${component.name} and every instance`
          : !selection
            ? target
            : selection.layer
              ? `${boardName(selection.board)} › ${target}`
              : boardName(selection.board)}
      </div>
      <textarea
        ref={box}
        value={text}
        rows={3}
        placeholder="What should change?"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
        }}
      />
      <div className="dz-ask-ctx">
        {component ? (
          <span className="dz-desk-only">
            <Icon name="component" size={11} />
            {component.name} and every instance
          </span>
        ) : (
          <span className="dz-desk-only">
            <Icon name="text" size={11} />
            {selection ? boardName(selection.board) : target}
            {selection?.layer ? ` › ${target}` : ''}
          </span>
        )}
        <span>
          <Icon name="tokens" size={11} />
          Design system rules
        </span>
        {comments > 0 && (
          <span>
            <Icon name="comment" size={11} />
            {comments} comment{comments === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {error && <p className="dz-error">{error}</p>}
      <label className="dz-ask-runs dz-phone-only">
        Runs on
        <span>
          {takers.find((computer) => computer.workerIds[0] === worker)?.name ?? 'Any free computer'}
          <Icon name="chevron" size={14} />
        </span>
        <select
          className="dz-pick"
          aria-label="Runs on"
          value={worker}
          onChange={(event) => setWorker(event.target.value)}
        >
          <option value="">Any free computer</option>
          {takers.map((computer) => (
            <option key={computer.id} value={computer.workerIds[0]}>
              {computer.name}
            </option>
          ))}
        </select>
      </label>
      <Action
        variant="primary"
        className="dz-ask-big dz-phone-only"
        disabled={!text.trim()}
        loading={busy}
        onClick={() => void send()}
      >
        Ask
      </Action>
      <div className="dz-ask-f dz-desk-only">
        <label className="dz-ask-pick">
          <Icon name="computer" size={12} />
          {takers.find((computer) => computer.workerIds[0] === worker)?.name ?? 'Any free computer'}
          <Icon name="down" size={10} />
          <select
            className="dz-pick"
            aria-label="Runs on"
            value={worker}
            onChange={(event) => setWorker(event.target.value)}
          >
            <option value="">Any free computer</option>
            {takers.map((computer) => (
              <option key={computer.id} value={computer.workerIds[0]}>
                {computer.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="dz-ask-send"
          aria-label="Ask"
          title="Ask  ⌘↩"
          disabled={!text.trim() || busy}
          onClick={() => void send()}
        >
          <Icon name="send" size={14} />
        </button>
      </div>
      <p className="dz-ask-note">
        Works on its own branch. You watch it here and accept or discard its changes.
      </p>
    </div>
  );
}

/** The bar over the canvas while an agent's design branch is open. */
export function OverlayBar({
  ask,
  mode,
  setMode,
  changes,
  busy,
  onAccept,
  onDiscard,
}: {
  ask: Ask;
  mode: OverlayMode;
  setMode: (mode: OverlayMode) => void;
  changes: number;
  busy: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  const working = !['done', 'failed', 'stopped', 'idle', 'ready'].includes(ask.status);
  return (
    <div className="dz-overlay-bar" role="region" aria-label="Agent’s changes">
      <span className={`dz-live${working ? ' on' : ''}`} aria-hidden="true" />
      <b>{ask.title.replace(/^Design:\s*/, '')}</b>
      <span className="dz-meta">
        {ask.branch} · {changes} change{changes === 1 ? '' : 's'}
      </span>
      <div className="dz-seg3" role="radiogroup" aria-label="Show">
        {(
          [
            ['mine', 'Mine'],
            ['overlay', 'Overlay'],
            ['agent', 'Agent’s'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            className={mode === id ? 'on' : ''}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <Action variant="primary" disabled={!changes} loading={busy} onClick={onAccept}>
        Accept
      </Action>
      <Action variant="secondary" onClick={onDiscard}>
        Discard
      </Action>
    </div>
  );
}

/** The right panel while an agent's branch is open: what was asked, what changed, what it rendered. */
export function AgentPanel({
  projectId,
  ask,
  changes,
  canvas,
  skipped,
  setSkipped,
  busy,
  onAccept,
  onDiscard,
  select,
  nameFor,
}: {
  projectId: string;
  ask: Ask;
  changes: Change[];
  canvas: Canvas | null;
  skipped: Set<string>;
  setSkipped: (next: Set<string>) => void;
  busy: boolean;
  onAccept: (paths?: string[]) => void;
  onDiscard: () => void;
  select: (selection: Selection) => void;
  nameFor: (board: string, layer: string) => string;
}) {
  const artifact = useDesignArtifact();
  const boards = changes
    .map((change) => boardFile(change.path) ?? '')
    .filter((file) => canvas?.boards[file]);
  const kept = changes.filter((change) => !skipped.has(change.path));
  return (
    <>
      <div className="dz-sel">
        <b className="dz-agent-name">
          <span className="dz-agent-dot">
            <Icon name="spark" size={11} />
          </span>
          Agent
        </b>
        <span className="dz-crumb">
          {ask.branch} · {ask.status}
        </span>
      </div>
      <section className="dz-prop">
        <div className="dz-prop-h">
          <span>You asked</span>
        </div>
        <p className="dz-msg">{ask.text ?? ask.title}</p>
      </section>
      <section className="dz-prop">
        <div className="dz-prop-h">
          <span>Its changes</span>
          <span className="dz-meta">{changes.length}</span>
        </div>
        {changes.length ? (
          <div className="dz-list">
            {changes.map((change) => {
              const file = boardFile(change.path) ?? change.path;
              const off = skipped.has(change.path);
              return (
                <div key={change.path} className={`dz-change${off ? ' off' : ''}`}>
                  <span className="dz-dot agent" />
                  <button
                    type="button"
                    className="dz-change-name"
                    onClick={() => canvas?.boards[file] && select({ board: file, layer: null })}
                  >
                    <span className="dz-t">
                      {canvas?.boards[file]
                        ? boardName(file)
                        : change.path.replace(/^design\//, '')}
                    </span>
                    <span className="dz-meta">
                      {change.layers?.length
                        ? `${change.layers.length} layer${change.layers.length === 1 ? '' : 's'}`
                        : change.status}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="dz-act"
                    aria-label={`Accept ${change.path}`}
                    disabled={busy}
                    onClick={() => onAccept([change.path])}
                  >
                    <Icon name="check" size={12} />
                  </button>
                  <button
                    type="button"
                    className="dz-act"
                    aria-label={off ? `Keep ${change.path}` : `Leave out ${change.path}`}
                    aria-pressed={off}
                    onClick={() => {
                      const next = new Set(skipped);
                      if (off) next.delete(change.path);
                      else next.add(change.path);
                      setSkipped(next);
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                  {change.layers?.length ? (
                    <ul className="dz-layer-changes">
                      {change.layers.slice(0, 6).map((layer) => (
                        <li key={layer.layer}>
                          <button
                            type="button"
                            onClick={() =>
                              select({
                                board: file,
                                layer: layer.change === 'removed' ? null : layer.layer,
                              })
                            }
                          >
                            {describeChange(layer, nameFor(file, layer.layer))}
                          </button>
                        </li>
                      ))}
                      {change.layers.length > 6 && (
                        <li className="dz-meta">and {change.layers.length - 6} more</li>
                      )}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <span className="dz-meta">
            Nothing committed yet. Its changes show here as it commits.
          </span>
        )}
      </section>
      {boards.length > 0 && (
        <section className="dz-prop">
          <div className="dz-prop-h">
            <span>Rendered</span>
          </div>
          <div className="dz-renders">
            {boards.slice(0, 2).flatMap((file) =>
              (isPhone(canvas!.boards[file]) ? [canvas!.boards[file].w] : [1440, 700]).map(
                (width) => (
                  <a
                    key={`${file}-${width}`}
                    href={`${designApi(projectId, artifact)}/render?task=${encodeURIComponent(ask.id)}&board=${encodeURIComponent(file)}&width=${width}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      alt={`${boardName(file)} at ${width}`}
                      loading="lazy"
                      src={`${designApi(projectId, artifact)}/render?task=${encodeURIComponent(ask.id)}&board=${encodeURIComponent(file)}&width=${width}`}
                    />
                    <span className="dz-meta">
                      {boardName(file)} · {width}
                    </span>
                  </a>
                ),
              ),
            )}
          </div>
        </section>
      )}
      <div className="dz-agent-f">
        <Action
          variant="primary"
          disabled={!kept.length}
          loading={busy}
          onClick={() =>
            onAccept(kept.length === changes.length ? undefined : kept.map((change) => change.path))
          }
        >
          {kept.length === changes.length ? 'Accept all' : `Accept ${kept.length}`}
        </Action>
        <Action variant="secondary" onClick={onDiscard}>
          Discard
        </Action>
        <a className="dl-btn quiet" href={`/dashboard/tasks/${encodeURIComponent(ask.id)}`}>
          Open task
        </a>
      </div>
    </>
  );
}
