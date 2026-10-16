type Row = Record<string, any>;
export type ActivityItem = {
  id: string;
  kind: string;
  title: string;
  status: string;
  detail: string;
  output: string;
  source: string | null;
  exitCode: number | null;
  background: boolean;
};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const pretty = (value: unknown) =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const basename = (value: string) => value.split('/').pop() || value;

/** Fold lifecycle events into one inspectable action; streamed assistant text is not activity. */
export function projectActivity(events: Row[], runs: Row[], messages: Row[]) {
  const byRun = new Map<string, Map<string, Row>>();
  const messageRuns = new Map<string, string>();
  const lastToolAt = new Map<string, string>();
  for (const event of events) {
    if (!event.runId) continue;
    if (event.type === 'message' && event.payload?.id)
      messageRuns.set(event.payload.id, event.runId);
    const item = event.payload?.item;
    if (
      !item?.id ||
      ![
        'command_execution',
        'tool_call',
        'tool_result',
        'mcp_tool_call',
        'file_change',
        'web_search',
      ].includes(item.type)
    )
      continue;
    if (event.createdAt) lastToolAt.set(event.runId, event.createdAt);
    const items = byRun.get(event.runId) ?? new Map<string, Row>();
    byRun.set(event.runId, items);
    const previous = items.get(item.id) ?? {};
    items.set(item.id, {
      ...previous,
      ...item,
      type: item.type === 'tool_result' ? previous.type || 'tool_call' : item.type,
      finished: event.type === 'item.completed',
      cursor: previous.cursor ?? event.cursor,
    });
  }
  const activity = runs.map((run) => {
    const items: ActivityItem[] = [...(byRun.get(run.id)?.values() ?? [])].map((item) => {
      const args = item.arguments ?? {};
      const name = text(item.name || item.tool);
      const command = text(item.command || args.command || args.cmd);
      const source = text(args.file_path || args.path || args.url || item.url) || null;
      const kind =
        item.type === 'command_execution' || /^(Bash|exec_command|shell|run_command)$/.test(name)
          ? 'command'
          : /^(Read|read_file|read)$/i.test(name)
            ? 'read'
            : item.type === 'file_change' || /^(Write|Edit|apply_patch|write_file)$/i.test(name)
              ? 'edit'
              : item.type === 'web_search' || /search|fetch|browse/i.test(name)
                ? 'search'
                : 'tool';
      const failed = Boolean(
        item.error ||
        item.isError ||
        item.status === 'failed' ||
        (item.exit_code != null && item.exit_code !== 0),
      );
      const running = !item.finished && ['queued', 'starting', 'running'].includes(run.status);
      const status = failed
        ? 'failed'
        : item.finished
          ? 'completed'
          : running
            ? 'running'
            : 'unknown';
      const title =
        kind === 'command'
          ? running
            ? 'Running command'
            : 'Ran command'
          : kind === 'read'
            ? (running ? 'Reading ' : 'Read ') + (source ? basename(source) : 'a file')
            : kind === 'edit'
              ? running
                ? 'Editing files'
                : 'Edited files'
              : kind === 'search'
                ? running
                  ? 'Searching'
                  : 'Searched'
                : (running ? 'Using ' : 'Used ') +
                  (name.replace(/^mcp__/, '').replaceAll('_', ' ') || 'a tool');
      return {
        id: run.id + ':' + item.id,
        kind,
        title: args.run_in_background === true ? 'Started background command' : title,
        status,
        detail: (
          command ||
          (kind === 'read' ? source : '') ||
          text(args.query) ||
          pretty(item.changes || args)
        ).slice(0, 6000),
        output: pretty(item.aggregated_output ?? item.output ?? item.result ?? item.error).slice(
          -12000,
        ),
        source,
        exitCode: item.exit_code ?? null,
        background: args.run_in_background === true,
      };
    });
    const counts = (kind: string) => items.filter((i) => i.kind === kind).length;
    const parts = [
      counts('read') && `Read ${counts('read')} ${counts('read') === 1 ? 'file' : 'files'}`,
      counts('command') &&
        `ran ${counts('command')} ${counts('command') === 1 ? 'command' : 'commands'}`,
      counts('edit') && 'edited files',
      counts('search') && 'searched',
      counts('tool') && `used ${counts('tool')} ${counts('tool') === 1 ? 'tool' : 'tools'}`,
    ].filter(Boolean);
    const summary = parts.join(', ');
    return {
      id: run.id,
      status: run.status,
      summary:
        (summary ? summary[0].toUpperCase() + summary.slice(1) : '') ||
        (['queued', 'starting', 'running'].includes(run.status) ? 'Working' : 'Activity'),
      items,
    };
  });
  const annotated = messages.map((message) => {
    const runId =
      message.runId ||
      messageRuns.get(message.id) ||
      runs.find((r) => message.id.startsWith(r.id + ':'))?.id ||
      null;
    return {
      ...message,
      runId,
      isProgress:
        message.role === 'assistant' &&
        Boolean(runId && message.createdAt < (lastToolAt.get(runId) || '')),
    };
  });
  return { activity, messages: annotated };
}
