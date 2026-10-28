import type { InboxItem } from '../../../../../shared/v2/contracts.ts';
import type { InboxResponse, V2EventsResponse } from '../../../../../shared/v2/api.ts';

export type InboxSnapshot = { items: InboxItem[]; loading: boolean; error: string | null };
const initial: InboxSnapshot = { items: [], loading: true, error: null };

/** One subscription and cursor shared by the sidebar, inbox and conversation decisions. */
export function createInboxStore(request: typeof fetch) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor = 0;
  let retryMs = 1000;
  const publish = (next: InboxSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const upsert = (items: InboxItem[]) => {
    const merged = new Map(snapshot.items.map((item) => [item.id, item]));
    for (const item of items) {
      // Replaying old events must never undo a snapshot or a just-submitted answer.
      if (
        merged.get(item.id)?.state !== 'waiting' &&
        merged.has(item.id) &&
        item.state === 'waiting'
      )
        continue;
      if (merged.get(item.id)?.answer && !item.answer) continue;
      merged.set(item.id, item);
    }
    publish({ items: [...merged.values()], loading: false, error: null });
  };
  async function read<T>(path: string, signal: AbortSignal): Promise<T> {
    const response = await request(path, { signal });
    if (!response.ok) throw new Error('Inbox unavailable');
    return response.json();
  }
  async function refresh(signal: AbortSignal) {
    const pages = await Promise.all(
      ['waiting', 'answered'].map((state) =>
        read<InboxResponse>(`/api/v2/inbox?state=${state}`, signal),
      ),
    );
    if (!signal.aborted) upsert(pages.flatMap((page) => page.items));
  }
  async function poll(signal: AbortSignal, bootstrap = false) {
    try {
      if (bootstrap) await refresh(signal);
      const page = await read<V2EventsResponse>(
        `/api/v2/events?after=${cursor}&waitMs=10000`,
        signal,
      );
      if (signal.aborted) return;
      cursor = page.cursor;
      upsert(page.events.flatMap((event) => (event.type === 'inbox' ? [event.item] : [])));
      retryMs = 1000;
      timer = setTimeout(() => void poll(signal), page.events.length ? 0 : 100);
    } catch {
      if (signal.aborted) return;
      publish({ ...snapshot, loading: false, error: 'Waiting on you is unavailable. Retrying…' });
      timer = setTimeout(() => void poll(signal, bootstrap), retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    }
  }
  function stop() {
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
  }
  function start() {
    controller = new AbortController();
    void poll(controller.signal, true);
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    },
    reset() {
      stop();
      cursor = 0;
      retryMs = 1000;
      publish(initial);
      if (listeners.size) start();
    },
    retry() {
      stop();
      if (listeners.size) start();
    },
    async answer(itemId: string, actionId: string, note?: string) {
      const signal = controller?.signal;
      const response = await request(`/api/v2/inbox/${encodeURIComponent(itemId)}/answer`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionId,
          on: 'web',
          ...(note?.trim() ? { note: note.trim() } : {}),
        }),
      });
      const body = await response.json();
      if ((!response.ok && response.status !== 409) || !body.item)
        throw new Error('Your answer could not be saved. Try again.');
      if (signal?.aborted) return;
      upsert([body.item]);
      return { item: body.item as InboxItem, conflict: response.status === 409 };
    },
  };
}
