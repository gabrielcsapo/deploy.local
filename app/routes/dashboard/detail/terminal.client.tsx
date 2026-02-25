'use client';

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useDetailContext } from './shared';
import { useWebSocket, sendWsMessage } from '../../../hooks/useWebSocket';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

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

  const handleWsEvent = useCallback(
    (event: { type: string; data: Record<string, unknown> }) => {
      if (event.type === 'exec:output') {
        setHasOutput(true);
        terminalRef.current?.write(event.data.output as string);
      } else if (event.type === 'exec:exit') {
        setEnded(true);
        terminalRef.current?.write('\r\n\x1b[33m--- Session ended ---\x1b[0m\r\n');
      }
    },
    [],
  );

  const { connected } = useWebSocket(channels, handleWsEvent);

  // Initialize xterm
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#3a3a5e',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    requestAnimationFrame(() => fitAddon.fit());

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      if (!ended) {
        sendWsMessage({ 'exec:input': data });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit());
    });
    resizeObserver.observe(termRef.current);

    return () => {
      resizeObserver.disconnect();
      sendWsMessage({ 'exec:end': true });
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start exec session once connected
  useEffect(() => {
    if (connected && !started && !ended) {
      sendWsMessage({ exec: name });
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
    <div>
      <div className="flex items-center justify-between mb-3">
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
      <div className="card overflow-hidden bg-[#1a1a2e] relative">
        <div ref={termRef} className="h-[500px] p-2" />
        {showOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a2e]">
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
