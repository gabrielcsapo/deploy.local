import { plainExcerpt, type TranscriptTurn } from './turn-minimap';

type Row = Record<string, any>;

/** Index a snapshot once so typing and each message row do not rescan the history. */
export function indexTranscript(messages: Row[], activity: Row[]) {
  const visible: Row[] = [];
  const turns: TranscriptTurn[] = [];
  const firstAssistant = new Map<string | undefined, string>();
  const progress = new Map<string | undefined, Row[]>();
  const activityByRun = new Map(activity.map((turn) => [turn.id, turn]));
  for (const message of messages) {
    if (message.isProgress) {
      const rows = progress.get(message.runId) ?? [];
      rows.push(message);
      progress.set(message.runId, rows);
    } else {
      visible.push(message);
      if (message.role === 'user')
        turns.push({
          id: message.id,
          excerpt: String(message.content ?? '')
            .split('\n')[0]
            .slice(0, 60),
          prompt: plainExcerpt(message.content, 120),
          reply: '',
        });
      else if (message.role === 'assistant' && turns.length && !turns[turns.length - 1].reply)
        turns[turns.length - 1].reply = plainExcerpt(message.content, 220);
      if (message.role === 'assistant' && !firstAssistant.has(message.runId))
        firstAssistant.set(message.runId, message.id);
    }
  }
  return {
    visible,
    turns,
    firstAssistant,
    progress,
    activityByRun,
    trailingActivity: activity.filter((turn) => !firstAssistant.has(turn.id)),
  };
}
