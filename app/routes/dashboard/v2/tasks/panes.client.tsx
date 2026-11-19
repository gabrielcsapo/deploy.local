'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Banner, Icon, IconButton, Skeleton } from '@/components/ui';
import { authenticatedFetch } from '../data/hooks';
import { requestJson, workspaceCommand, type parsePatch } from './api';
import {
  browserAddress,
  browserController,
  commandPending,
  elapsed,
  keyAction,
  latestFrame,
  pagePoint,
  queueAction,
  stepRunning,
  sessionLive,
  taskBrowser,
  type BrowserAction,
  type ControlSession,
  type ControlSnapshot,
  type ControlState,
} from './browser';

/** The head every pane beside the chat shares: a title, a short note, its actions and Close. */
export function PaneHead({
  icon,
  title,
  meta,
  children,
  onClose,
}: {
  icon?: 'globe';
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="dl-pane-head">
      <span className="dl-pane-title">
        {icon && <Icon name={icon} size={14} />}
        <span className="dl-pane-name">{title}</span>
        {meta && <span className="dl-meta">{meta}</span>}
      </span>
      {children}
      <IconButton icon="close" label={`Close ${title.toLowerCase()}`} onClick={onClose} />
    </div>
  );
}

type Files = ReturnType<typeof parsePatch>;
export function PaneFiles({ files }: { files: Files }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(files[0] ? [files[0].file] : []));
  return (
    <div className="dl-pane-diffs">
      {files.map((file) => {
        const shown = open.has(file.file);
        return (
          <section className="dl-group dl-pane-diff" key={file.file} aria-label={file.file}>
            <button
              type="button"
              className="dl-pane-diff-head"
              aria-expanded={shown}
              onClick={() => {
                const next = new Set(open);
                if (shown) next.delete(file.file);
                else next.add(file.file);
                setOpen(next);
              }}
            >
              <Icon name={shown ? 'down' : 'chevron'} size={14} />
              <span className="dl-pane-path">{file.file}</span>
              <span className="dl-end">
                {!!file.added && <span className="dl-add">+{file.added}</span>}{' '}
                {!!file.removed && <span className="dl-del">−{file.removed}</span>}
              </span>
            </button>
            {shown && (
              <div
                className="dl-lines"
                role="region"
                aria-label={`Changes to ${file.file}`}
                tabIndex={0}
              >
                {file.lines.map((line, index) => (
                  <div className={`dl-line ${line.kind || ''}`} key={index}>
                    <span className="dl-n" aria-label="Old line">
                      {line.old}
                    </span>
                    <span className="dl-n" aria-label="New line">
                      {line.new}
                    </span>
                    <code>
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                      {line.text}
                    </code>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** A collapsed description that opens in place. */
export function PaneDescription({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (open) return <div className="dl-pane-description">{children}</div>;
  return (
    <button type="button" className="dl-pane-row" onClick={() => setOpen(true)}>
      <span className="dl-t">
        <span>Description</span>
        {summary && <span>{summary}</span>}
      </span>
      <Icon name="chevron" size={14} />
    </button>
  );
}

let fallbackClient = '';
/** This browser's identity as a controller: a person takes over and gives back from here. */
function clientId() {
  if (typeof window === 'undefined') return '';
  const key = 'deploy-control-client';
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const value = crypto.randomUUID();
    localStorage.setItem(key, value);
    return value;
  } catch {
    fallbackClient ||= crypto.randomUUID();
    return fallbackClient;
  }
}

/** The task's control sessions, read often while the browser pane is open, rarely otherwise. */
export function useTaskBrowser(taskId: string, watching: boolean) {
  const [state, setState] = useState<ControlState | null>(null);
  const load = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    load.current = () =>
      void requestJson<ControlState>(
        authenticatedFetch,
        `/api/tasks/${encodeURIComponent(taskId)}/controls`,
        { signal: controller.signal },
      )
        .then((next) => !controller.signal.aborted && setState(next))
        .catch(() => {});
    load.current();
    const timer = setInterval(() => load.current(), watching ? 1500 : 8000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [taskId, watching]);
  const session = taskBrowser(state);
  const refresh = useCallback(() => load.current(), []);
  return { state, session, inUse: sessionLive(session), refresh };
}

export function BrowserPane({
  taskId,
  computer,
  agent = 'The agent',
  browser,
  onClose,
}: {
  taskId: string;
  computer?: string;
  agent?: string;
  browser: ReturnType<typeof useTaskBrowser>;
  onClose: () => void;
}) {
  const { state, session, refresh } = browser;
  const [me] = useState(clientId);
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const picture = useRef<HTMLDivElement>(null);
  const frame = latestFrame(state, session?.id);
  const who = browserController(session, me);
  const yours = who === 'you';
  const [queue, setQueue] = useState<BrowserAction[]>([]);
  const [sent, setSent] = useState<string>();
  const [sending, setSending] = useState(false);
  const busy = sending || stepRunning(state, sent) || commandPending(state, session?.id);
  const base = `/tasks/${encodeURIComponent(taskId)}/controls`;
  const sessionId = session?.id;

  // A new picture exists only after a step finishes, so read it once per finished step.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    requestJson<ControlSnapshot | null>(
      authenticatedFetch,
      `/api${base}/${encodeURIComponent(sessionId)}?frame=${encodeURIComponent(frame || '')}`,
      { signal: controller.signal },
    )
      .then((next) => !controller.signal.aborted && next && setSnapshot(next))
      .catch(() => {});
    return () => controller.abort();
  }, [base, sessionId, frame]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const command = useCallback(
    async (action: string, body: Record<string, unknown> = {}) => {
      if (!session) return;
      setError('');
      try {
        return await workspaceCommand<{ id?: string }>(authenticatedFetch, `${base}/${action}`, {
          sessionId: session.id,
          generation: session.generation,
          clientId: me,
          ...body,
        });
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : 'The browser didn’t respond. Try again.',
        );
      } finally {
        refresh();
      }
    },
    [session, base, me, refresh],
  );

  const send = (input: BrowserAction) => {
    if (yours) setQueue((current) => queueAction(current, input));
  };
  // Steps queued while this window had the browser are dropped once it is given back.
  if (!yours && queue.length) setQueue([]);
  // One step at a time: the next waits until the worker has finished the last one.
  useEffect(() => {
    if (!yours || busy || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setSending(true);
    void command('input', { action: next })
      .then((entry) => setSent(entry?.id))
      .finally(() => setSending(false));
  }, [yours, busy, queue, command]);
  // Read sooner while a step this window sent is running, so the next one follows quickly.
  useEffect(() => {
    if (!sent || !stepRunning(state, sent)) return;
    const timer = setTimeout(refresh, 400);
    return () => clearTimeout(timer);
  }, [sent, state, refresh]);

  const image =
    snapshot?.image && `data:${snapshot.mimeType || 'image/jpeg'};base64,${snapshot.image}`;
  const title = snapshot?.title || session?.targetLabel || 'Task browser';
  const host = snapshot?.url ? safeHost(snapshot.url) : '';
  const on = computer ? ` on ${computer}` : '';

  return (
    <aside className="dl-task-pane dl-pane-browser" aria-label="Browser">
      <PaneHead icon="globe" title={title} meta={host} onClose={onClose} />
      <form
        className="dl-browser-bar"
        onSubmit={(event) => {
          event.preventDefault();
          const url = browserAddress(address);
          if (!url) return setError('Enter a web address that starts with http or https.');
          setEditing(false);
          send({ type: 'navigate', url });
        }}
      >
        <IconButton
          icon="arrowBack"
          label="Back"
          aria-disabled={!yours || busy}
          onClick={() => send({ type: 'back' })}
        />
        <IconButton
          icon="arrow"
          label="Forward"
          aria-disabled={!yours || busy}
          onClick={() => send({ type: 'forward' })}
        />
        <IconButton
          icon="reload"
          label="Reload"
          aria-disabled={!yours || busy}
          onClick={() => send({ type: 'inspect' })}
        />
        <label className={`dl-browser-url ${yours ? 'on' : ''}`}>
          <Icon name="lock" size={14} />
          <span className="dl-sr">Address</span>
          <input
            type="text"
            value={editing ? address : snapshot?.url || ''}
            readOnly={!yours}
            spellCheck={false}
            onFocus={() => {
              if (!yours) return;
              setAddress(snapshot?.url || '');
              setEditing(true);
            }}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
      </form>
      <div className="dl-browser-stage">
        {error && (
          <div className="dl-browser-error">
            <Banner kind="danger" title={error} />
          </div>
        )}
        <div
          ref={picture}
          className={`dl-browser-view ${yours ? 'yours' : ''} ${busy ? 'busy' : ''}`}
          role={yours ? 'application' : 'img'}
          aria-label={
            yours ? `${title}. Click and type to use the page.` : `${title} in the task browser`
          }
          tabIndex={yours ? 0 : -1}
          onClick={(event) => {
            if (!yours || !snapshot) return;
            picture.current?.focus();
            const box = event.currentTarget.querySelector('img')?.getBoundingClientRect();
            if (!box) return;
            if (
              event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom
            )
              return;
            send({
              type: 'click',
              ...pagePoint(box, event.clientX, event.clientY, snapshot.width, snapshot.height),
            });
          }}
          onKeyDown={(event) => {
            if (!yours) return;
            const input = keyAction(event);
            if (!input) return;
            event.preventDefault();
            send(input);
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text').slice(0, 8000);
            if (!yours || !text) return;
            event.preventDefault();
            send({ type: 'text', text });
          }}
          onWheel={(event) => {
            if (!yours) return;
            send({
              type: 'scroll',
              x: Math.round(event.deltaX),
              y: Math.round(event.deltaY),
            });
          }}
        >
          {image ? (
            <img src={image} alt="" draggable={false} />
          ) : session ? (
            <Skeleton rows={4} label="Loading the browser" />
          ) : (
            <p className="dl-meta dl-browser-empty">
              When the agent opens the task browser, you can watch it here.
            </p>
          )}
          {sessionLive(session) && (
            <div className="dl-browser-control">
              <ControlBar
                who={who}
                agent={agent}
                session={session!}
                now={now}
                onTake={() => void command('takeover')}
                onGive={() => void command('release')}
                onStop={() => void command('stop')}
              />
            </div>
          )}
        </div>
        <p className="dl-browser-foot">
          {who === 'you'
            ? `Click and type on the page. ${agent} waits until you give it back.`
            : session && !sessionLive(session)
              ? `The browser closed${session.reason ? `: ${session.reason}` : ''}. This is its last picture.`
              : `A clean browser${on}, with no saved sign-ins · Updated after each step`}
        </p>
      </div>
    </aside>
  );
}

function ControlBar({
  who,
  agent,
  session,
  now,
  onTake,
  onGive,
  onStop,
}: {
  who: ReturnType<typeof browserController>;
  agent: string;
  session: ControlSession;
  now: number;
  onTake: () => void;
  onGive: () => void;
  onStop: () => void;
}) {
  if (who === 'you')
    return (
      <div className="dl-control">
        <span className="dl-browser-who">You have the browser · {agent} is waiting</span>
        <button type="button" className="stop" onClick={onGive}>
          Give back
        </button>
      </div>
    );
  if (who === 'taking' || who === 'returning')
    return (
      <div className="dl-control">
        <span className="dl-browser-who">
          {who === 'taking' ? 'Taking over…' : 'Giving it back…'}
        </span>
      </div>
    );
  if (who === 'elsewhere')
    return (
      <div className="dl-control">
        <span className="dl-browser-who">You have the browser in another window</span>
        <button type="button" className="stop" onClick={onStop}>
          Stop
        </button>
      </div>
    );
  return (
    <div className="dl-control">
      <span className="dl-rec" />
      <span className="dl-browser-who">{agent} is using the browser</span>
      <span className="dl-c">{elapsed(session.createdAt, now)}</span>
      <button type="button" onClick={onTake}>
        Take over
      </button>
      <button type="button" className="stop" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
