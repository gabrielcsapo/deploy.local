'use client';

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useDetailContext } from './shared';
import { useWebSocket, sendWsMessage } from '../../../hooks/useWebSocket';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ANSI colors are kept hardcoded (no theme equivalents).
// background/foreground/cursor/selection are read from CSS vars at runtime.
const ANSI_COLORS = {
  black: '#1a1a2e',
  red: '#ff6b6b',
  green: '#51cf66',
  yellow: '#ffd43b',
  blue: '#74c0fc',
  magenta: '#da77f2',
  cyan: '#66d9e8',
  white: '#e0e0e0',
  brightBlack: '#545474',
  brightRed: '#ff8787',
  brightGreen: '#69db7c',
  brightYellow: '#ffe066',
  brightBlue: '#91d5ff',
  brightMagenta: '#e599f7',
  brightCyan: '#99e9f2',
  brightWhite: '#ffffff',
};

function getTerminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue('--color-bg').trim() || '#1a1a2e';
  const fg = style.getPropertyValue('--color-text').trim() || '#e0e0e0';
  const selection = style.getPropertyValue('--color-bg-active').trim() || '#3a3a5e';
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: selection,
    selectionForeground: '#ffffff',
    ...ANSI_COLORS,
  };
}

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);

  const channels = useMemo(() => [`deployment:${name}`], [name]);

  const handleWsEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === 'exec:output') {
      setHasOutput(true);
      terminalRef.current?.write(event.data.output as string);
    } else if (event.type === 'exec:exit') {
      setEnded(true);
      terminalRef.current?.write('\r\n\x1b[33m--- Session ended ---\x1b[0m\r\n');
    }
  }, []);

  const { connected } = useWebSocket(channels, handleWsEvent);

  // Initialize xterm with dynamic imports to reduce bundle size (~420KB deferred)
  useEffect(() => {
    if (!termRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      const [{ Terminal: XTerminal }, { FitAddon: XFitAddon }, { WebLinksAddon }] =
        await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
        ]);

      if (disposed || !termRef.current) return;

      const term = new XTerminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 13,
        lineHeight: 1.2,
        letterSpacing: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontWeight: '400',
        fontWeightBold: '600',
        scrollback: 10000,
        allowProposedApi: true,
        theme: getTerminalTheme(),
      });

      const fitAddon = new XFitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(termRef.current);

      // Try WebGL for GPU-accelerated rendering, falls back to canvas automatically
      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        if (!disposed) term.loadAddon(new WebglAddon());
      } catch {
        // WebGL not available, canvas renderer is fine
      }

      requestAnimationFrame(() => fitAddon.fit());

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

      term.onData((data) => {
        if (!ended) {
          sendWsMessage({ 'exec:input': data });
        }
      });

      // Send resize events to backend so the PTY can adjust
      term.onResize(({ cols, rows }) => {
        sendWsMessage({ 'exec:resize': { cols, rows } });
      });

      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => fitAddon.fit());
      });
      resizeObserver.observe(termRef.current);
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      sendWsMessage({ 'exec:end': true });
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start exec session once connected — include terminal dimensions
  useEffect(() => {
    if (connected && !started && !ended) {
      const term = terminalRef.current;
      sendWsMessage({
        exec: name,
        cols: term?.cols ?? 80,
        rows: term?.rows ?? 24,
      });
      setStarted(true);
    }
  }, [connected, started, ended, name]);

  const handleReconnect = () => {
    setEnded(false);
    setStarted(false);
    setHasOutput(false);
    terminalRef.current?.clear();
  };

  const showOverlay = !hasOutput && !ended;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
          Terminal
        </h3>
        <div className="flex items-center gap-2">
          {ended && (
            <button onClick={handleReconnect} className="btn btn-sm">
              Reconnect
            </button>
          )}
          {connected && !ended && (
            <span className="flex items-center gap-1.5 text-xs text-success">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Connected
            </span>
          )}
        </div>
      </div>
      <div className="card overflow-hidden bg-bg relative flex-1 min-h-[400px]">
        <div ref={termRef} className="h-full p-2" />
        {showOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg">
            <div className="flex items-center gap-2 text-sm text-text-tertiary">
              <span className="w-2 h-2 rounded-full bg-text-tertiary animate-pulse" />
              Connecting to container...
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
