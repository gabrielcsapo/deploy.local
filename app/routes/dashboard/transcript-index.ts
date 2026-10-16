type Row = Record<string, any>;

/** Index a snapshot once so typing and each message row do not rescan the history. */
export function indexTranscript(messages: Row[], activity: Row[]) {
  const visible: Row[] = [];
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
      if (message.role === 'assistant' && !firstAssistant.has(message.runId))
        firstAssistant.set(message.runId, message.id);
    }
  }
  return {
    visible,
    firstAssistant,
    progress,
    activityByRun,
    trailingActivity: activity.filter((turn) => !firstAssistant.has(turn.id)),
  };
}
