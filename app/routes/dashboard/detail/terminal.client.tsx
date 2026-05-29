'use client';

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useDetailContext } from './shared';
import { useWebSocket, sendWsMessage } from '../../../hooks/useWebSocket';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { CopyIcon, RotateIcon, SearchIcon } from '../../../components/dashboard/icons';

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

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export default function Component() {
  const { deployment } = useDetailContext();
  const name = deployment.name;
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const channels = useMemo(() => [`deployment:${name}`], [name]);

  const handleWsEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === 'exec:output') {
      setHasOutput(true);
      terminalRef.current?.write(event.data.output as string);
    } else if (event.type === 'exec:exit') {
      setEnded(true);
      const error = event.data.error as string | undefined;
      const code = event.data.code as number | null | undefined;
      const detail = error
        ? `error: ${error}`
        : typeof code === 'number'
          ? `exit ${code}`
          : 'closed';
      terminalRef.current?.write(`\r\n\x1b[33m--- Session ended (${detail}) ---\x1b[0m\r\n`);
    }
  }, []);

  const { connected } = useWebSocket(channels, handleWsEvent);

  useEffect(() => {
    if (!termRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let mouseDownCleanup: (() => void) | null = null;

    (async () => {
      const [
        { Terminal: XTerminal },
        { FitAddon: XFitAddon },
        { WebLinksAddon },
        { SearchAddon: XSearchAddon },
        { Unicode11Addon },
        { ClipboardAddon },
      ] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-search'),
        import('@xterm/addon-unicode11'),
        import('@xterm/addon-clipboard'),
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
        // Option-as-Meta lets word-jumping (Option+B/F) and other readline
        // bindings work the way users expect on macOS.
        macOptionIsMeta: true,
        // Double-click selects words; right-click extends the selection rather
        // than popping the browser context menu mid-paste.
        rightClickSelectsWord: true,
        theme: getTerminalTheme(),
      });

      const fitAddon = new XFitAddon();
      const searchAddon = new XSearchAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon());
      // OSC 52: lets the remote shell copy to the host clipboard (e.g. `tmux`
      // buffers, `vim` yank-to-clipboard) without any extra plumbing.
      term.loadAddon(new ClipboardAddon());
      // Render emoji and CJK with the wider grapheme widths from Unicode 11.
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = '11';

      // Browser shortcut layer. Return `false` to swallow the event so the
      // shell doesn't also see the keystroke; return `true` to forward.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const modKey = IS_MAC ? event.metaKey : event.ctrlKey;
        if (!modKey || event.altKey) return true;
        const key = event.key.toLowerCase();

        // Copy when there is a selection; otherwise let Ctrl+C reach the shell
        // so it can interrupt the foreground process.
        if (key === 'c' && term.hasSelection()) {
          const sel = term.getSelection();
          if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
          return false;
        }
        if (key === 'v') {
          navigator.clipboard
            ?.readText()
            .then((text) => text && sendWsMessage({ 'exec:input': text }))
            .catch(() => {});
          return false;
        }
        if (key === 'k') {
          term.clear();
          return false;
        }
        if (key === 'f') {
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
          return false;
        }
        if (key === '=' || key === '+' || key === '-') {
          // Let the browser zoom — xterm will re-fit via the ResizeObserver.
          return true;
        }
        return true;
      });

      term.open(termRef.current);

      try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        if (!disposed) term.loadAddon(new WebglAddon());
      } catch {
        /* canvas renderer is fine */
      }

      requestAnimationFrame(() => fitAddon.fit());

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      term.onData((data) => {
        if (!ended) {
          sendWsMessage({ 'exec:input': data });
        }
      });

      term.onResize(({ cols, rows }) => {
        sendWsMessage({ 'exec:resize': { cols, rows } });
      });

      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => fitAddon.fit());
      });
      resizeObserver.observe(termRef.current);

      // Middle-click paste (X11 convention) — handy when running the dashboard
      // on Linux, harmless elsewhere.
      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        navigator.clipboard
          ?.readText()
          .then((text) => text && sendWsMessage({ 'exec:input': text }))
          .catch(() => {});
      };
      termRef.current.addEventListener('mousedown', onMouseDown);
      mouseDownCleanup = () => termRef.current?.removeEventListener('mousedown', onMouseDown);
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      mouseDownCleanup?.();
      sendWsMessage({ 'exec:end': true });
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleClear = () => terminalRef.current?.clear();

  const handleCopy = async () => {
    const sel = terminalRef.current?.getSelection() ?? '';
    if (sel) await navigator.clipboard?.writeText(sel).catch(() => {});
  };

  const findNext = useCallback((query: string, opts?: { back?: boolean }) => {
    if (!query || !searchAddonRef.current) return;
    if (opts?.back) searchAddonRef.current.findPrevious(query);
    else searchAddonRef.current.findNext(query);
  }, []);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  };

  const showOverlay = !hasOutput && !ended;

  return (
    <section className="flex flex-col flex-1 min-h-0 card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <h3 className="eyebrow font-semibold">Terminal</h3>
          {connected && !ended && (
            <span className="flex items-center gap-1.5 text-[11px] text-success">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Connected
            </span>
          )}
          {ended && <span className="text-[11px] text-warning">Session ended</span>}
        </div>
        <div className="flex items-center gap-1">
          <ToolbarButton
            onClick={() => {
              setSearchOpen((v) => !v);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            aria-label="Search"
            title={`Search (${IS_MAC ? '⌘' : 'Ctrl+'}F)`}
          >
            <SearchIcon />
          </ToolbarButton>
          <ToolbarButton onClick={handleCopy} aria-label="Copy selection" title="Copy selection">
            <CopyIcon />
          </ToolbarButton>
          <ToolbarButton
            onClick={handleClear}
            aria-label="Clear"
            title={`Clear (${IS_MAC ? '⌘' : 'Ctrl+'}K)`}
          >
            <span className="text-[10px]">CLR</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={handleReconnect}
            aria-label="Reconnect"
            title={ended ? 'Start new session' : 'Restart session'}
          >
            <RotateIcon />
          </ToolbarButton>
        </div>
      </div>
      {searchOpen && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-elevated">
          <SearchIcon className="w-3.5 h-3.5 text-text-tertiary" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                findNext(searchQuery, { back: e.shiftKey });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Find in terminal"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-text-tertiary"
          />
          <span className="text-[10px] text-text-tertiary">↵ next · ⇧↵ prev · esc close</span>
          <button
            type="button"
            onClick={closeSearch}
            className="text-text-tertiary hover:text-text text-xs px-1"
            aria-label="Close search"
          >
            ✕
          </button>
        </div>
      )}
      <div className="relative flex-1 min-h-0 bg-bg">
        <div ref={termRef} className="absolute inset-0 p-2" />
        {showOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg pointer-events-none">
            <div className="flex items-center gap-2 text-sm text-text-tertiary">
              <span className="w-2 h-2 rounded-full bg-text-tertiary animate-pulse" />
              Connecting to container…
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ToolbarButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] rounded-md text-text-tertiary hover:text-text hover:bg-bg-hover transition-colors"
    >
      {children}
    </button>
  );
}
