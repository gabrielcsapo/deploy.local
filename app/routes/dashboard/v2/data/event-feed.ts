import type { V2Event, V2EventsResponse } from '../../../../../shared/v2/api.ts';

// Even the old task loop retried every second. Back off within that bound so sharing
// the transport never makes recovery slower for a screen that already retried quickly.
const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 1000;

type Subscriber = {
  snapshot(signal: AbortSignal): Promise<boolean | void>;
  events(events: V2Event[], signal: AbortSignal): void | Promise<void>;
  error(reason: unknown, phase: 'connection' | 'snapshot' | 'events'): void;
  reset?(): void;
};
type Active = {
  controller: AbortController;
  boundary?: number;
  queue: V2Event[];
  pagePending: boolean;
  snapshot: boolean;
  busy: boolean;
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * One long poll, with independent serialized snapshot/delivery queues for each subscriber.
 * Register BEFORE asking for latest: pages arriving while latest or the snapshot is in flight
 * are buffered, then filtered against that position. A late join never inherits an old cursor
 * or loses an event to an already-running poll. Snapshots may include newer events; consumers
 * must merge replay idempotently (as they did with eventSnapshotCursor).
 */
export function createEventFeed(request: typeof fetch) {
  const subscribers = new Map<Subscriber, Active>();
  let controller: AbortController | undefined;
  let position: Promise<V2EventsResponse>;

  async function read(after: number | 'latest', signal: AbortSignal) {
    const response = await request(
      `/api/v2/events?after=${after}${after === 'latest' ? '' : '&waitMs=10000'}`,
      { signal },
    );
    if (!response.ok) throw new Error('Live updates unavailable');
    return (await response.json()) as V2EventsResponse;
  }
  function report(
    sub: Subscriber,
    reason: unknown,
    phase: 'connection' | 'snapshot' | 'events' = 'connection',
  ) {
    try {
      void Promise.resolve(sub.error(reason, phase)).catch(() => {});
    } catch {
      // A consumer cannot interrupt delivery to other subscribers.
    }
  }
  function retry(active: Active, action: () => void) {
    if (active.controller.signal.aborted) return;
    active.timer = setTimeout(action, active.retryMs);
    active.retryMs = Math.min(active.retryMs * 2, MAX_RETRY_MS);
  }
  async function pump(sub: Subscriber, active: Active) {
    const signal = active.controller.signal;
    if (signal.aborted || active.busy || active.timer || active.boundary === undefined) return;
    active.busy = true;
    let phase: 'snapshot' | 'events' = 'snapshot';
    try {
      while (!signal.aborted && (active.snapshot || active.pagePending || active.queue.length)) {
        if (active.snapshot) {
          phase = 'snapshot';
          active.snapshot = false;
          if ((await sub.snapshot(signal)) === false) throw new Error('Snapshot unavailable');
          signal.throwIfAborted();
        } else {
          phase = 'events';
          const batch = active.queue.splice(0);
          active.pagePending = false;
          try {
            await sub.events(batch, signal);
          } catch (error) {
            active.queue.unshift(...batch);
            active.pagePending = true;
            throw error;
          }
        }
      }
      active.retryMs = INITIAL_RETRY_MS;
    } catch (error) {
      if (!signal.aborted) {
        active.snapshot = true;
        report(sub, error, phase);
        retry(active, () => {
          active.timer = undefined;
          void pump(sub, active);
        });
      }
    } finally {
      active.busy = false;
    }
  }
  async function initialize(sub: Subscriber, active: Active, latest: Promise<V2EventsResponse>) {
    const signal = active.controller.signal;
    try {
      const { cursor } = await latest;
      signal.throwIfAborted();
      active.boundary = cursor;
      active.queue = active.queue.filter((event) => event.cursor > cursor);
      void pump(sub, active);
    } catch (error) {
      if (!signal.aborted) {
        report(sub, error);
        retry(active, () => {
          active.timer = undefined;
          void initialize(sub, active, read('latest', signal));
        });
      }
    }
  }
  async function run(signal: AbortSignal, latest: Promise<V2EventsResponse>) {
    let cursor: number | undefined;
    let retryMs = INITIAL_RETRY_MS;
    let gap = false;
    while (!signal.aborted) {
      try {
        if (cursor === undefined) cursor = (await latest).cursor;
        signal.throwIfAborted();
        if (gap) {
          gap = false;
          for (const [sub, active] of subscribers) {
            active.snapshot = true;
            void pump(sub, active);
          }
        }
        const page = await read(cursor, signal);
        signal.throwIfAborted();
        cursor = page.cursor;
        for (const [sub, active] of subscribers) {
          active.pagePending = true;
          active.queue.push(
            ...page.events.filter(
              (event) => active.boundary === undefined || event.cursor > active.boundary,
            ),
          );
          void pump(sub, active);
        }
        retryMs = INITIAL_RETRY_MS;
        // Yield on empty pages, including older servers that do not implement long polling.
        await pause(page.events.length ? 0 : 100, signal);
      } catch (error) {
        if (signal.aborted) return;
        gap = true;
        for (const sub of subscribers.keys()) report(sub, error);
        try {
          await pause(retryMs, signal);
        } catch {
          return;
        }
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        if (cursor === undefined) latest = read('latest', signal);
      }
    }
  }
  function start() {
    controller = new AbortController();
    position = read('latest', controller.signal);
    void run(controller.signal, position);
  }
  function activate(sub: Subscriber, latest?: Promise<V2EventsResponse>) {
    const active: Active = {
      controller: new AbortController(),
      queue: [],
      pagePending: false,
      snapshot: true,
      busy: false,
      retryMs: INITIAL_RETRY_MS,
    };
    subscribers.set(sub, active);
    void initialize(sub, active, latest ?? read('latest', active.controller.signal));
  }
  function deactivate(active: Active) {
    active.controller.abort();
    clearTimeout(active.timer);
  }
  return {
    subscribe(options: Subscriber) {
      const sub = { ...options };
      const first = !subscribers.size;
      if (first) start();
      activate(sub, first ? position : undefined);
      return () => {
        const active = subscribers.get(sub);
        if (!active) return;
        deactivate(active);
        subscribers.delete(sub);
        if (!subscribers.size) {
          controller?.abort();
          controller = undefined;
        }
      };
    },
    reset() {
      controller?.abort();
      const entries = [...subscribers];
      subscribers.clear();
      for (const [sub, active] of entries) {
        deactivate(active);
        try {
          sub.reset?.();
        } catch (error) {
          report(sub, error);
        }
      }
      if (!entries.length) return;
      start();
      for (const [sub] of entries) activate(sub, position);
    },
  };
}
export type EventFeed = ReturnType<typeof createEventFeed>;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
