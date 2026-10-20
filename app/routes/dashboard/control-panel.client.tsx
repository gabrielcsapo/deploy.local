'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { endedControlReason } from './control-session';
import { WorkspaceIcon } from './workspace-icon';
type Row = Record<string, any>;
export function ControlPanel({
  taskId,
  workers,
  api,
  onClose,
  onReveal,
  visible,
}: {
  visible: boolean;
  onClose: () => void;
  onReveal: () => void;
  taskId: string;
  workers: Row[];
  api: (path: string, body?: Row) => Promise<any>;
}) {
  const [clientId] = useState(() => crypto.randomUUID());
  // `loading` is only on the placeholder; any state from the server replaces it.
  const [state, setState] = useState<Row>({
    sessions: [],
    targets: [],
    commands: [],
    loading: true,
  });
  const [sessionId, setSessionId] = useState('');
  const [snapshot, setSnapshot] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const restart = useRef<{ id: string; reason: string; inspected: boolean } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const viewerRef = useRef<HTMLElement>(null);
  const dragged = useRef(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const move = (x: number, y: number) => {
    const rect = viewerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(
        8,
        Math.min(y, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8),
      ),
    });
  };
  useEffect(() => {
    if (!expanded) return;
    const collapse = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', collapse);
    return () => document.removeEventListener('keydown', collapse);
  }, [expanded]);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const revealKey = useRef('');
  const apiRef = useRef(api);
  apiRef.current = api;
  const snapshotCommand = useRef('');
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  useEffect(() => {
    restart.current = null;
    setRestarting(false);
    setBusy(false);
    setError('');
    setRefreshError('');
    setState({ sessions: [], targets: [], commands: [], loading: true });
    setSnapshot(null);
    snapshotCommand.current = '';
  }, [taskId]);
  const session = state.sessions.at(-1);
  const request = state.requests?.find((r: Row) => r.status === 'pending');
  const own = session?.controlOwner === 'user:' + clientId;
  const pending = state.commands.some(
    (c: Row) => c.sessionId === session?.id && ['queued', 'running'].includes(c.status),
  );
  const ended = ['stopped', 'suspended'].includes(session?.status);
  const unavailable = !state.targets.some(
    (target: Row) =>
      target.workerId === session?.workerId && target.id === session?.targetId && target.available,
  );
  const canInput = own && session?.status === 'active' && !session?.viewOnly && !busy && !pending;
  useEffect(() => {
    let disposed = false,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await apiRef.current(`/tasks/${taskId}/controls`);
        if (disposed) return;
        setState(next);
        setRefreshError('');
        const chosen = next.sessions.at(-1);
        const incoming =
          next.requests?.find((r: Row) => r.status === 'pending')?.id ||
          (chosen && !['stopped', 'suspended'].includes(chosen.status) ? chosen.id : '');
        if (incoming && incoming !== revealKey.current) {
          revealKey.current = incoming;
          onRevealRef.current();
        }
        if (restart.current && chosen && restart.current.id === chosen.id) {
          if (['stopped', 'suspended'].includes(chosen.status)) {
            setError(endedControlReason(chosen));
            restart.current = null;
            setRestarting(false);
            setBusy(false);
          } else if (chosen.status === 'active' && !restart.current.inspected) {
            restart.current.inspected = true;
            try {
              await apiRef.current(`/tasks/${taskId}/controls/input`, {
                clientId,
                operationId: crypto.randomUUID(),
                sessionId: chosen.id,
                generation: chosen.generation,
                action: { type: 'inspect' },
              });
            } catch (failure: any) {
              if (disposed) return;
              setError(failure.message);
              setBusy(false);
            }
          }
        }
        if (disposed) return;
        const completed = next.commands
          .filter((c: Row) => c.sessionId === chosen?.id && c.status === 'succeeded')
          .at(-1);
        const key = `${chosen?.id}:${completed?.id}`;
        if (key !== snapshotCommand.current) {
          const image = chosen
            ? await apiRef.current(`/tasks/${taskId}/controls/${chosen.id}`)
            : null;
          if (!disposed) {
            if (image?.image || !restart.current) {
              setSnapshot(image);
              snapshotCommand.current = key;
            }
            if (completed && !image?.image && restart.current?.id === chosen?.id) {
              setError('The session opened, but no frame was captured');
              setBusy(false);
            }
            if (image?.image && completed && restart.current?.id === chosen?.id) {
              restart.current = null;
              setRestarting(false);
              setBusy(false);
              setError('');
            }
          }
        }
      } catch (e: any) {
        if (!disposed) {
          setRefreshError(e.message);
          if (restart.current) setBusy(false);
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [taskId, sessionId, clientId]);
  async function act(action: string, values: Row = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await api(`/tasks/${taskId}/controls/${action}`, {
        clientId,
        operationId: crypto.randomUUID(),
        sessionId: session?.id,
        generation: session?.generation,
        ...values,
      });
      if (action === 'approve') {
        setSessionId(result.id);
        setSnapshot(null);
      }
      setState(await api(`/tasks/${taskId}/controls`));
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function startAgain() {
    if (unavailable || busy) return;
    if (restart.current?.id) {
      restart.current.inspected = false;
      setBusy(true);
      setError('');
      return;
    }
    if (!ended) return;
    setBusy(true);
    setError('');
    restart.current = { id: '', reason: endedControlReason(session), inspected: false };
    setRestarting(true);
    try {
      const opened = await api(`/tasks/${taskId}/controls/open`, {
        clientId,
        operationId: crypto.randomUUID(),
        workerId: session.workerId,
        targetId: session.targetId,
      });
      if (taskIdRef.current !== taskId || !restart.current) return;
      restart.current.id = opened.id;
      setSessionId(opened.id);
    } catch (failure: any) {
      if (taskIdRef.current !== taskId) return;
      setError(failure.message);
      restart.current = null;
      setRestarting(false);
      setBusy(false);
    }
  }
  const input = (action: Row) => act('input', { action });
  const active = session?.status === 'active';
  // Linux desktops are captured through ScreenCast only: nobody can click or type there.
  const viewOnly = session?.viewOnly === true;
  const status = active
    ? own
      ? viewOnly
        ? 'Viewing · view-only'
        : 'You have control'
      : session.controlOwner === 'agent'
        ? viewOnly
          ? 'Agent is viewing'
          : 'Agent is controlling'
        : viewOnly
          ? 'Someone else is viewing'
          : 'Another client has control'
    : ended
      ? 'Ended'
      : session?.status === 'opening'
        ? 'Starting…'
        : session?.status === 'transferring'
          ? 'Reconnecting…'
          : session?.status || 'No session';
  return (
    <section
      ref={viewerRef}
      style={{
        display: visible ? undefined : 'none',
        ...(!expanded && position
          ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }
          : {}),
      }}
      className={`pw-control-panel pw-control-viewer pw-floating-viewer ${snapshot?.image ? 'pw-window-only' : ''} ${request ? 'pw-window-options' : ''} ${expanded ? 'is-expanded' : ''}`}
      aria-label="Browser and computer control"
    >
      <header className="pw-viewer-header">
        <div
          className="pw-viewer-drag"
          role="button"
          tabIndex={0}
          aria-label="Move computer view"
          title="Drag to move · arrow keys to reposition"
          onKeyDown={(e) => {
            const direction = {
              ArrowLeft: [-24, 0],
              ArrowRight: [24, 0],
              ArrowUp: [0, -24],
              ArrowDown: [0, 24],
            }[e.key];
            if (!direction || expanded) return;
            e.preventDefault();
            const r = viewerRef.current!.getBoundingClientRect();
            move(r.left + direction[0], r.top + direction[1]);
          }}
          onPointerDown={(e) => {
            if (expanded || e.button !== 0) return;
            const r = viewerRef.current!.getBoundingClientRect();
            drag.current = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) move(d.left + e.clientX - d.x, d.top + e.clientY - d.y);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <WorkspaceIcon name="computer" />
          <div className="pw-viewer-title">
            <strong>{session?.targetLabel || 'Computer use'}</strong>
            <span
              title={
                session
                  ? workers.find((w) => w.id === session.workerId)?.name || session.workerId
                  : undefined
              }
            >
              {session
                ? workers.find((w) => w.id === session.workerId)?.name || session.workerId
                : 'A browser or window for this task'}
            </span>
          </div>
        </div>
        <button
          className="pw-viewer-icon"
          aria-label={expanded ? 'Collapse controlled view' : 'Expand controlled view'}
          aria-expanded={expanded}
          title={expanded ? 'Collapse view' : 'Expand view'}
          onClick={() => setExpanded(!expanded)}
        >
          <WorkspaceIcon name={expanded ? 'collapse' : 'expand'} />
        </button>
        <button
          className="pw-viewer-icon"
          aria-label="Hide computer view"
          title="Hide view (session keeps running)"
          onClick={onClose}
        >
          <WorkspaceIcon name="close" />
        </button>
      </header>
      {request && (
        <div className="pw-control-permission">
          <WorkspaceIcon name="computer" />
          <strong>Allow agent control?</strong>
          <span>{request.targetLabel}</span>
          <p>
            On {workers.find((w) => w.id === request.workerId)?.name || request.workerId} · up to 30
            minutes
          </p>
          <p>
            Share this {request.kind === 'browser' ? 'browser' : 'window'} and allow clicks, typing,
            and scrolling. You can stop at any time.
          </p>
          <div>
            <Button
              variant="link"
              disabled={busy}
              onClick={() => void act('deny', { requestId: request.id })}
            >
              Not now
            </Button>
            <button
              className="pw-viewer-primary"
              disabled={busy}
              onClick={() => void act('approve', { requestId: request.id })}
            >
              Allow
            </button>
          </div>
        </div>
      )}
      {!session && !request && !state.loading && (
        <div className="pw-control-empty">
          <WorkspaceIcon name="computer" />
          <strong>Ask the agent to use a window</strong>
          <span>The agent finds and opens the window through tools.</span>
        </div>
      )}
      {session && !request && (
        <>
          <div
            className={`pw-viewer-stage ${ended || restarting ? 'pw-viewer-ended' : ''}`}
            onPointerDown={(e) => {
              if (ended || restarting || own || expanded || e.button !== 0) return;
              dragged.current = false;
              const r = viewerRef.current!.getBoundingClientRect();
              drag.current = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d && !own) {
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) dragged.current = true;
                move(d.left + e.clientX - d.x, d.top + e.clientY - d.y);
              }
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            {snapshot?.image ? (
              <button
                className="pw-control-image"
                aria-label={
                  ended || restarting
                    ? 'Last frame from the ended session'
                    : viewOnly
                      ? `${session.targetLabel} (view-only)`
                      : 'Click controlled view'
                }
                disabled={ended || restarting}
                aria-disabled={!canInput}
                onClick={(e) => {
                  if (!canInput || e.detail === 0 || dragged.current) return;
                  const rect = e.currentTarget.querySelector('img')!.getBoundingClientRect();
                  if (
                    e.clientX < rect.left ||
                    e.clientX > rect.right ||
                    e.clientY < rect.top ||
                    e.clientY > rect.bottom
                  )
                    return;
                  const bounds = snapshot.inputBounds || {
                    x: 0,
                    y: 0,
                    width: snapshot.width,
                    height: snapshot.height,
                  };
                  void input({
                    type: 'click',
                    x: bounds.x + ((e.clientX - rect.left) / rect.width) * bounds.width,
                    y: bounds.y + ((e.clientY - rect.top) / rect.height) * bounds.height,
                  });
                }}
              >
                <img
                  alt={
                    ended || restarting
                      ? 'Last frame from the ended session'
                      : snapshot.title || 'Controlled view'
                  }
                  draggable={false}
                  src={`data:image/jpeg;base64,${snapshot.image}`}
                />
              </button>
            ) : ended || restarting ? (
              <div className="pw-control-empty" />
            ) : (
              <div className="pw-control-empty">
                <WorkspaceIcon name="computer" />
                <span>
                  {active ? (own ? 'Ready to view' : 'Waiting for a capture') : 'No capture yet'}
                </span>
              </div>
            )}
            {(ended || restarting) && (
              <div className="pw-control-ended-overlay">
                <p role="status">{restart.current?.reason || endedControlReason(session)}</p>
                <Button
                  variant="primary"
                  disabled={busy || unavailable}
                  aria-busy={busy}
                  onClick={() => void startAgain()}
                >
                  {busy ? 'Starting…' : 'Start again'}
                </Button>
                {unavailable && (
                  <p role="status">{session.targetLabel} isn't available right now</p>
                )}
                {(error || refreshError) && (
                  <p className="pw-viewer-error" role="alert">
                    {error || refreshError}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="pw-viewer-toolbar">
            <span className="pw-viewer-state" role="status">
              <i className={active ? 'active' : ''} />
              {status}
            </span>
            <div className="pw-viewer-actions">
              {active && !restarting && viewOnly && own && (
                <Button
                  variant="link"
                  disabled={busy || pending}
                  onClick={() => void input({ type: 'inspect' })}
                >
                  Refresh
                </Button>
              )}
              {active && !restarting && !viewOnly && (
                <Button
                  variant="link"
                  disabled={busy}
                  onClick={() => void act(own ? 'release' : 'takeover')}
                >
                  {own ? 'Return to agent' : 'Take control'}
                </Button>
              )}
              {!ended && !restarting && (
                <Button
                  variant="link"
                  aria-label="Stop control session"
                  title="Stop session"
                  disabled={busy}
                  onClick={() => void act('stop')}
                >
                  Stop
                </Button>
              )}
            </div>
          </div>
        </>
      )}
      {!ended && !restarting && (error || refreshError) && (
        <p className="pw-viewer-error" role="alert">
          {error || refreshError}
        </p>
      )}
    </section>
  );
}
