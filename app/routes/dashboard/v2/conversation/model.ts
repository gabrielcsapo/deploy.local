import { formatTime } from '../data/time.ts';
import type { ConversationEvent, WorkStep } from '../../../../../shared/v2/contracts.ts';

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

type Worklog = Extract<ConversationEvent, { kind: 'worklog' }>;
type Reply = Extract<ConversationEvent, { kind: 'reply' }>;

/**
 * One turn's work reads as one log, "Worked for 14m", instead of a row per step. What the agent
 * says while it works ("Checking the verify path") becomes a note in that log; what it says after
 * its last step stays a reply. A log that is still running says so.
 */
export function workLogs(events: ConversationEvent[]): ConversationEvent[] {
  const result: ConversationEvent[] = [];
  let turn: (Worklog | Reply)[] = [];
  const flush = () => {
    const last = turn.findLastIndex((event) => event.kind === 'worklog');
    if (last < 0) {
      result.push(...turn);
      turn = [];
      return;
    }
    const work = turn.slice(0, last + 1);
    const logs = work.filter((event): event is Worklog => event.kind === 'worklog');
    if (work.length === 1) result.push(work[0]);
    else {
      const live = logs.some((event) => event.live);
      const steps = work.flatMap((event): WorkStep[] =>
        event.kind === 'worklog'
          ? // Each step keeps its own state: the log being live must not spin the steps that are done.
            event.steps.map((step) => ({ ...step, live: step.live ?? event.live }))
          : [{ icon: 'pulse', glyph: 'note', text: event.paragraphs.join(' '), live: false }],
      );
      result.push({
        kind: 'worklog',
        id: logs[0].id,
        at: work[0].at,
        live,
        steps,
        summary: `${live ? 'Working for' : 'Worked for'} ${took(work[0].at, work.at(-1)!.at)}`,
      });
    }
    result.push(...turn.slice(last + 1));
    turn = [];
  };
  for (const event of events) {
    if (event.kind === 'worklog' || event.kind === 'reply') turn.push(event);
    else {
      flush();
      result.push(event);
    }
  }
  flush();
  return result;
}
