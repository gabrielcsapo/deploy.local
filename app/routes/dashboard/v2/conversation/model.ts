import { formatTime } from '../data/time.ts';
import type { ConversationEvent } from '../../../../../shared/v2/contracts.ts';

/** Stable ids replace streamed work updates without moving their position in the chat. */
export function mergeEvents(current: ConversationEvent[], incoming: ConversationEvent[]) {
  const events = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export function conversationDays(events: ConversationEvent[], now = new Date(), timeZone?: string) {
  const days = new Map<string, ConversationEvent[]>();
  for (const event of mergeEvents([], events)) {
    const day = timeZone
      ? new Date(event.at).toLocaleDateString('en-US', { timeZone })
      : new Date(event.at).toDateString();
    days.set(day, [...(days.get(day) || []), event]);
  }
  return [...days].map(([, items], index) => ({
    day: formatTime(items[0].at, 'day', now, timeZone),
    events: items,
    // A decision must stay visible even when its day is folded.
    pinned: index < days.size - 1 ? items.filter((event) => event.kind === 'decision') : [],
    folded: index < days.size - 1,
  }));
}

export function safeResourceUrl(value: string) {
  return /^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp);base64,)/i.test(value)
    ? value
    : undefined;
}
