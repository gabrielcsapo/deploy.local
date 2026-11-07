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
  const versions = new Map<string, number>();
  const boundaries = new Map<string, number>();
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
  const publish = (next: InboxSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const upsert = (
    items: InboxItem[],
    position?: { cursor: number; at?: string },
    notify = true,
  ) => {
    if (!items.length && !snapshot.loading && !snapshot.error) return;
    const merged = new Map(snapshot.items.map((item) => [item.id, item]));
    for (const item of items) {
      const previous = merged.get(item.id);
      if (
        position &&
        position.cursor <=
          Math.max(
            versions.get(item.id) ?? 0,
            boundaries.get(item.state) ??
              Math.min(boundaries.get('waiting') ?? 0, boundaries.get('answered') ?? 0),
          )
      )
        continue;
      // Older coordinators have no snapshot position. Preserve resolved decisions there;
      // a newly created incarnation can still use the same identity.
      if (!position || (!boundaries.size && !versions.has(item.id))) {
        if (
          previous &&
          previous.state !== 'waiting' &&
          item.state === 'waiting' &&
          item.createdAt <= previous.createdAt
        )
          continue;
      }
      // A POST can finish ahead of the event feed. Its timestamp protects the answer
      // until the ordered feed catches up, while permitting a later reopening.
      if (
        previous?.answer &&
        !item.answer &&
        (!position ||
          (position.at !== undefined &&
            Date.parse(position.at) <= Date.parse(previous.answer.at))) &&
        item.createdAt <= previous.createdAt
      )
        continue;
      if (position) versions.set(item.id, position.cursor);
      merged.set(item.id, item);
    }
    const next = [...merged.values()];
    if (
      !snapshot.loading &&
      !snapshot.error &&
      next.length === snapshot.items.length &&
      next.every((item, index) => item === snapshot.items[index])
    )
      return;
    const result = { items: next, loading: false, error: null };
    if (notify) publish(result);
    else snapshot = result;
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
    if (signal.aborted) return;
    // Keep per-item positions as well as absence boundaries: waiting and answered
    // can cross while the two requests are in flight.
    for (const page of [...pages].sort((a, b) => (a.cursor ?? 0) - (b.cursor ?? 0))) {
      upsert(page.items, page.cursor === undefined ? undefined : { cursor: page.cursor });
    }
    const waiting = pages[0];
    if (waiting.cursor !== undefined) {
      const present = new Set(waiting.items.map((item) => item.id));
      const items = snapshot.items.filter(
        (item) =>
          item.state !== 'waiting' ||
          present.has(item.id) ||
          (versions.get(item.id) ?? 0) > waiting.cursor!,
      );
      if (items.length !== snapshot.items.length) publish({ ...snapshot, items });
    }
    for (const [index, state] of ['waiting', 'answered'].entries()) {
      const page = pages[index];
      if (page.cursor !== undefined) boundaries.set(state, page.cursor);
    }
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
        const before = snapshot;
        for (const event of events) if (event.type === 'inbox') upsert([event.item], event, false);
        if (snapshot !== before) publish(snapshot);
      },
      error() {
        publish({ ...snapshot, loading: false, error: 'Waiting on you is unavailable. Retrying…' });
      },
      reset() {
        controller?.abort();
        controller = new AbortController();
        versions.clear();
        boundaries.clear();
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
      versions.clear();
      boundaries.clear();
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
