import type { InboxItem } from '../../../../../shared/v2/contracts.ts';
import type { InboxResponse } from '../../../../../shared/v2/api.ts';

import { createEventFeed, type EventFeed } from './event-feed.ts';

export type InboxSnapshot = { items: InboxItem[]; loading: boolean; error: string | null };
const initial: InboxSnapshot = { items: [], loading: true, error: null };

/** One subscription and cursor shared by the sidebar, inbox and conversation decisions. */
export function createInboxStore(
  request: typeof fetch,
  feed: EventFeed = createEventFeed(request),
) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
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
  function stop() {
    controller?.abort();
    controller = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  }
  function start() {
    controller = new AbortController();
    unsubscribe = feed.subscribe({
      snapshot: refresh,
      events(events) {
        if (events.some((event) => event.type === 'agent') && typeof window !== 'undefined')
          window.dispatchEvent(new Event('deploy:agents-changed'));
        upsert(events.flatMap((event) => (event.type === 'inbox' ? [event.item] : [])));
      },
      error() {
        publish({ ...snapshot, loading: false, error: 'Waiting on you is unavailable. Retrying…' });
      },
      reset() {
        controller?.abort();
        controller = new AbortController();
        publish(initial);
      },
    });
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
