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

function took(from: string, to: string) {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The steps an agent takes between messages read as one work log, "Worked for 14m", instead of
 * a row each. A log that is still running says so.
 */
export function workLogs(events: ConversationEvent[]): ConversationEvent[] {
  const result: ConversationEvent[] = [];
  let run: Extract<ConversationEvent, { kind: 'worklog' }>[] = [];
  const flush = () => {
    if (run.length === 1) result.push(run[0]);
    else if (run.length > 1) {
      const live = run.some((event) => event.live);
      const steps = run.flatMap((event) =>
        event.steps.map((step) => ({ ...step, live: step.live ?? event.live })),
      );
      result.push({
        kind: 'worklog',
        id: run[0].id,
        at: run[0].at,
        live,
        steps,
        summary: `${live ? 'Working for' : 'Worked for'} ${took(run[0].at, run.at(-1)!.at)}`,
      });
    }
    run = [];
  };
  for (const event of events) {
    if (event.kind === 'worklog') run.push(event);
    else {
      flush();
      result.push(event);
    }
  }
  flush();
  return result;
}
