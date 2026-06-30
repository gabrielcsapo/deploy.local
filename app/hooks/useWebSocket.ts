import { useEffect, useRef, useCallback, useState } from 'react';
import { getAuth } from '../routes/dashboard/detail/shared';

export interface WsEvent {
  type: string;
  deploymentName: string;
  data: Record<string, unknown>;
}

type EventHandler = (event: WsEvent) => void;

// Singleton WebSocket connection shared across components
let globalWs: WebSocket | null = null;
let globalHandlers = new Set<EventHandler>();
let globalSubscriptions = new Map<string, number>(); // channel -> refcount
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;

// Event-driven connection state tracking (replaces per-component 500ms polling)
const stateListeners = new Set<() => void>();
function notifyStateChange() {
  for (const fn of stateListeners) fn();
}

function getWsUrl() {
  const auth = getAuth();
  if (!auth) return null;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?username=${encodeURIComponent(auth.username)}&token=${encodeURIComponent(auth.token)}`;
}

function connect() {
  const url = getWsUrl();
  if (
    !url ||
    globalWs?.readyState === WebSocket.OPEN ||
    globalWs?.readyState === WebSocket.CONNECTING
  )
    return;

  const ws = new WebSocket(url);
  globalWs = ws;

  ws.onopen = () => {
    reconnectDelay = 1000;
    notifyStateChange();
    // Re-subscribe to all channels
    for (const channel of globalSubscriptions.keys()) {
      ws.send(JSON.stringify({ subscribe: channel }));
    }
  };

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as WsEvent;
      // The server coalesces high-frequency request:logged events into one
      // batch message per deployment every 500ms. Unpack here so component
      // handlers keep their simple per-event shape.
      if (event.type === 'request:logged:batch') {
        const entries = (event.data?.entries ?? []) as Array<Record<string, unknown>>;
        for (const entry of entries) {
          const synthetic: WsEvent = {
            type: 'request:logged',
            deploymentName: event.deploymentName,
            data: entry,
          };
          for (const handler of globalHandlers) {
            handler(synthetic);
          }
        }
        return;
      }
      for (const handler of globalHandlers) {
        handler(event);
      }
    } catch {
      // ignore malformed
    }
  };

  ws.onclose = () => {
    globalWs = null;
    notifyStateChange();
    if (globalHandlers.size > 0) {
      // Reconnect with exponential backoff (max 30s)
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    }
  };

  ws.onerror = () => {
    ws.close();
  };
}

function subscribe(channel: string) {
  const count = globalSubscriptions.get(channel) || 0;
  globalSubscriptions.set(channel, count + 1);
  if (count === 0 && globalWs?.readyState === WebSocket.OPEN) {
    globalWs.send(JSON.stringify({ subscribe: channel }));
  }
}

function unsubscribe(channel: string) {
  const count = globalSubscriptions.get(channel) || 0;
  if (count <= 1) {
    globalSubscriptions.delete(channel);
    if (globalWs?.readyState === WebSocket.OPEN) {
      globalWs.send(JSON.stringify({ unsubscribe: channel }));
    }
  } else {
    globalSubscriptions.set(channel, count - 1);
  }
}

function addHandler(handler: EventHandler) {
  globalHandlers.add(handler);
  if (globalHandlers.size === 1) {
    connect();
  }
}

function removeHandler(handler: EventHandler) {
  globalHandlers.delete(handler);
  if (globalHandlers.size === 0 && globalWs) {
    globalWs.close();
    globalWs = null;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }
}

/**
 * Send a raw JSON message through the shared WebSocket.
 */
export function sendWsMessage(msg: Record<string, unknown>) {
  if (globalWs?.readyState === WebSocket.OPEN) {
    globalWs.send(JSON.stringify(msg));
  }
}

/**
 * Subscribe to WebSocket events for given channels.
 * Returns the current connection status.
 */
export function useWebSocket(channels: string[], onEvent: (event: WsEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const stableHandler = useCallback((event: WsEvent) => {
    handlerRef.current(event);
  }, []);

  useEffect(() => {
    addHandler(stableHandler);

    // Event-driven connection state (no polling)
    const onStateChange = () => setConnected(globalWs?.readyState === WebSocket.OPEN);
    stateListeners.add(onStateChange);
    onStateChange(); // Initial check

    return () => {
      removeHandler(stableHandler);
      stateListeners.delete(onStateChange);
    };
  }, [stableHandler]);

  // Manage channel subscriptions
  const channelsKey = channels.join(',');
  useEffect(() => {
    for (const ch of channels) {
      subscribe(ch);
    }
    return () => {
      for (const ch of channels) {
        unsubscribe(ch);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey]);

  return { connected };
}
