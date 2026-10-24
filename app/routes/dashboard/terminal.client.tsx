'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal } from '@xterm/xterm';
import { Button, Toggle, WorkspaceIcon, type WorkspaceIconName } from '../../components/ui';
import { useDialogFocus } from '../../components/useDialogFocus';
import { getAuth } from './detail/shared';
import {
  controlInput,
  terminalKeyGroups,
  terminalUnavailable,
  type TerminalStatus,
} from './terminal-state';

async function statusRequest(workerId: string, enabled?: boolean): Promise<TerminalStatus> {
  const auth = getAuth();
  if (!auth) throw new Error('Sign in to use terminals');
  const response = await fetch(
    `/api/workspace/computers/${encodeURIComponent(workerId)}/terminal`,
    {
      method: enabled === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-deploy-username': auth.username,
        'x-deploy-token': auth.token,
      },
      ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to load terminal access');
  return data;
}
// Arrow characters render thin and uneven in monospace; the icon set's chevrons stay matched.
const arrowIcons: Record<string, WorkspaceIconName> = {
  '←': 'chevron-left',
  '↑': 'chevron-up',
  '↓': 'chevron-down',
  '→': 'chevron',
};
export function TerminalAccess({ workerId, name }: { workerId: string; name: string }) {
  const [status, setStatus] = useState<TerminalStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void statusRequest(workerId)
        .then((data) => {
          if (live) setStatus(data);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workerId]);
  return (
    <section
      className="ds-permission"
      id={`terminal-access-${workerId}`}
      aria-label={`Terminal access on ${name}`}
    >
      <div className="ds-permission-head">
        <strong>Terminal access</strong>
        <Toggle
          label={`Terminal access on ${name}`}
          enabled={status?.enabled === true}
          disabled={!status || busy}
          onChange={() => {
            setBusy(true);
            setError('');
            void statusRequest(workerId, !status?.enabled)
              .then(setStatus)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        />
      </div>
      <p className="ds-permission-summary">
        Allow your account to open a shell as this computer’s worker user. Disabling ends open
        sessions.
      </p>
      {status && (
        <p className="ds-permission-summary">
          {terminalUnavailable(status) || 'Enabled for you. Agents cannot open terminals.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Recent terminal sessions</summary>
        {!status?.recent.length ? (
          <p className="ds-permission-summary">No recent sessions.</p>
        ) : (
          <ul className="terminal-history">
            {status.recent
              .filter(
                (entry, index, all) => all.findIndex((other) => other.id === entry.id) === index,
              )
              .map((entry) => (
                <li key={entry.id}>
                  <time dateTime={entry.startedAt}>
                    {new Date(entry.startedAt).toLocaleString()}
                  </time>{' '}
                  · {entry.owner} · {entry.ip || 'Unknown address'}
                  <p>
                    {entry.type === 'terminal.started'
                      ? 'Started'
                      : `${entry.reason} · ${Math.round(entry.durationMs / 1000)} seconds${entry.code === null ? '' : ` · Exit ${entry.code}`}`}
                  </p>
                </li>
              ))}
          </ul>
        )}
      </details>
    </section>
  );
}

export function ComputerTerminal({
  workerId,
  name,
  onClose,
  onEnable,
}: {
  workerId: string;
  name: string;
  onClose: () => void;
  onEnable: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const ctrl = useRef(false);
  const [control, setControl] = useState(false);
  const [state, setState] = useState('Connecting…');
  const [ended, setEnded] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useDialogFocus(true, dialog, onClose);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  const sendInput = (data: string) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    const bytes = new TextEncoder().encode(controlInput(data, ctrl.current));
    ctrl.current = false;
    setControl(false);
    // Large pastes stay within the socket frame limit; never buffer without bound.
    if (socket.current.bufferedAmount + bytes.length > 1024 * 1024) {
      setState('Paste is too large');
      return;
    }
    for (let i = 0; i < bytes.length; i += 16384) socket.current.send(bytes.slice(i, i + 16384));
  };
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const initialize = async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      if (disposed) return;
      let exited = false;
      let ws: WebSocket | undefined;
      setState(attempt ? 'Reconnecting…' : 'Connecting…');
      setEnded(false);
      setDisabled(false);
      const style = getComputedStyle(document.documentElement);
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: style.getPropertyValue('--ds-font-mono'),
        fontSize: parseFloat(style.getPropertyValue('--ds-type-navigation')),
        scrollback: 5000,
        allowProposedApi: false,
        theme: {
          background: style.getPropertyValue('--ds-canvas').trim(),
          foreground: style.getPropertyValue('--ds-ink').trim(),
        },
      });
      terminal.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(host.current!);
      const resize = () => {
        const viewport = window.visualViewport;
        if (dialog.current) {
          dialog.current.style.height = `${viewport?.height ?? window.innerHeight}px`;
          dialog.current.style.top = `${viewport?.offsetTop ?? 0}px`;
        }
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'exec:resize', cols: term.cols, rows: term.rows }));
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host.current!);
      window.visualViewport?.addEventListener('resize', resize);
      window.visualViewport?.addEventListener('scroll', resize);
      resize();
      const data = term.onData(sendInput);
      void statusRequest(workerId)
        .then((status) => {
          if (disposed) return;
          const unavailable = terminalUnavailable(status);
          if (unavailable) {
            setState(unavailable);
            setDisabled(!status.enabled);
            setEnded(true);
            return;
          }
          const url = new URL('/ws/terminal', window.location.href);
          url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          ws = new WebSocket(url);
          ws.binaryType = 'arraybuffer';
          socket.current = ws;
          ws.onopen = () =>
            ws!.send(
              JSON.stringify({ auth: getAuth(), workerId, cols: term.cols, rows: term.rows }),
            );
          ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
              const bytes = new Uint8Array(event.data);
              term.write(bytes, () => {
                if (ws?.readyState === WebSocket.OPEN)
                  ws.send(JSON.stringify({ type: 'exec:ack', bytes: bytes.length }));
              });
              return;
            }
            const msg = JSON.parse(event.data);
            if (msg.type === 'exec:ready') {
              setState('Connected');
              term.focus();
            }
            if (msg.type === 'exec:exit') {
              exited = true;
              setState(
                `Session ended${msg.code === null ? '' : ` (exit ${msg.code})`}${msg.error ? ` · ${msg.error}` : ''}`,
              );
              setEnded(true);
            }
          };
          ws.onclose = () => {
            if (!disposed && !exited) {
              setState('Connection lost. The session has ended.');
              setEnded(true);
            }
          };
          ws.onerror = () => {
            if (!disposed) setState('Unable to connect');
          };
        })
        .catch((error) => {
          if (!disposed) {
            setState(error.message);
            setEnded(true);
          }
        });
      cleanup = () => {
        ws?.close();
        socket.current = null;
        observer.disconnect();
        window.visualViewport?.removeEventListener('resize', resize);
        window.visualViewport?.removeEventListener('scroll', resize);
        data.dispose();
        term.dispose();
      };
    };
    void initialize().catch((error) => {
      if (!disposed) {
        setState(error.message);
        setEnded(true);
      }
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
    // sendInput reads the current socket and modifier from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerId, attempt]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={dialog}
      className="computer-terminal"
      role="dialog"
      aria-modal="true"
      aria-label={`Terminal on ${name}`}
    >
      <header className="terminal-header">
        <div>
          <strong>{name}</strong>
          <p role="status">{state}</p>
        </div>
        <Button
          onClick={() => {
            if (socket.current?.readyState === WebSocket.OPEN)
              socket.current.send(JSON.stringify({ type: 'exec:end' }));
            onClose();
          }}
        >
          {ended ? 'Close' : 'End session'}
        </Button>
      </header>
      {disabled && (
        <Button variant="link" onClick={onEnable}>
          Enable Terminal access in computer settings
        </Button>
      )}
      {ended && !disabled && (
        <Button variant="link" onClick={() => setAttempt((n) => n + 1)}>
          Open a new session
        </Button>
      )}
      <div className="terminal-surface" ref={host} onKeyDown={(event) => event.stopPropagation()} />
      <div className="terminal-keys ui-scroll-strip" role="toolbar" aria-label="Terminal keys">
        <button
          type="button"
          className="terminal-key"
          aria-pressed={control}
          aria-label="Control (applies to the next key)"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            ctrl.current = !ctrl.current;
            setControl(ctrl.current);
            terminal.current?.focus();
          }}
        >
          Ctrl
        </button>
        {terminalKeyGroups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 && <span className="terminal-key-divider" aria-hidden="true" />}
            {group.map(([label, value, name]) => (
              <button
                type="button"
                key={label}
                className="terminal-key"
                aria-label={name}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  sendInput(value);
                  terminal.current?.focus();
                }}
              >
                {arrowIcons[label] ? <WorkspaceIcon name={arrowIcons[label]} /> : label}
              </button>
            ))}
          </Fragment>
        ))}
        <span className="terminal-key-divider" aria-hidden="true" />
        <button
          type="button"
          className="terminal-key"
          aria-label="Copy selection"
          onClick={() => {
            const selection = terminal.current?.getSelection();
            if (selection)
              void navigator.clipboard
                .writeText(selection)
                .catch(() => setState('Select text and use your browser’s Copy action'));
          }}
        >
          <WorkspaceIcon name="copy" />
        </button>
        <button
          type="button"
          className="terminal-key"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            void navigator.clipboard
              .readText()
              .then(sendInput)
              .catch(() => setState('Use your keyboard or browser’s Paste action'));
            terminal.current?.focus();
          }}
        >
          Paste
        </button>
      </div>
    </div>,
    document.body,
  );
}
