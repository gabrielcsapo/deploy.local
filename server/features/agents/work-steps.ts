import type { WorkStep } from '../../../shared/v2/contracts.ts';

/**
 * Turns an agent's tool calls and jobs into steps a person can read: what was done, how it went,
 * and where to look. Raw tool names never reach the page.
 */

/** Plumbing that says nothing about the work: the job a step polls already has its own step. */
const HIDDEN_TOOLS = new Set([
  'ToolSearch',
  'TodoWrite',
  'deploy_run_job',
  'deploy_get_job',
  'deploy_read_artifact',
  'deploy_list_computers',
  'deploy_design',
]);

export type ToolItem = {
  /** When the call began, so a finished step can say how long it took. */
  startedAt?: unknown;
  name?: unknown;
  arguments?: unknown;
  output?: unknown;
  isError?: unknown;
};

/** `mcp__deploy__deploy_application` reads as `deploy_application`. */
export function toolName(name: unknown) {
  return typeof name === 'string' ? name.replace(/^mcp__.+?__/, '') : '';
}

export function hiddenTool(name: unknown) {
  return HIDDEN_TOOLS.has(toolName(name));
}

function args(item: ToolItem): Record<string, unknown> {
  return item.arguments && typeof item.arguments === 'object'
    ? (item.arguments as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && typeof (part as any).text === 'string'
            ? (part as any).text
            : '',
      )
      .join('\n');
  return '';
}

function basename(path: unknown) {
  return typeof path === 'string' ? path.split('/').filter(Boolean).at(-1) || path : '';
}

function words(name: string) {
  const plain = name.replace(/^deploy_/, '').replaceAll('_', ' ');
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

const short = (value: string, limit = 80) =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

/** The app a deploy names, or the first label of the address it answered at. */
function appName(item: ToolItem, result?: Record<string, unknown>) {
  const named = args(item).name;
  if (typeof named === 'string' && named) return named;
  const url = typeof result?.url === 'string' ? result.url : '';
  try {
    return url ? new URL(url).hostname.split('.')[0] : 'app';
  } catch {
    return 'app';
  }
}

function json(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lines every deploy log has, which say nothing about why this one failed. The reason is shown
 * above the tail, so it is left out of the tail too.
 */
const BOILERPLATE = [
  /^Deployment stopped\./,
  /deployment failed:/i,
  /^Source artifact accepted by the coordinator$/,
  /^Triggered by .+ via task /,
];

/** A deploy log line without its timestamp. */
const logLine = (line: string) => line.replace(/^\[[^\]]+\]\s*/, '').trimEnd();

/** The short reason shown beside a failed deploy, from the platform's own message. */
export function deployFailure(log: string): { outcome: string; reason?: string } {
  const lines = log.split('\n').map(logLine).filter(Boolean);
  const failure = lines.find((line) => /deployment failed:/i.test(line));
  const reason = failure?.replace(/^.*?deployment failed:\s*/i, '') || lines.at(-1);
  const known: [RegExp, string][] = [
    [/health gate|health check/i, 'health check'],
    [/no published port/i, 'no published port'],
    [/not based on the current desired revision/i, 'deploy.yaml is out of date'],
    [/timed out waiting/i, 'still deploying after 10 minutes'],
    [/required value|configuration-required/i, 'needs configuration'],
    [/build/i, 'build'],
  ];
  const label = reason && known.find(([pattern]) => pattern.test(reason))?.[1];
  return { outcome: label ? `Failed: ${label}` : 'Failed', reason };
}

function deployStep(item: ToolItem, done: boolean): WorkStep {
  const output = text(item.output);
  const result = json(output);
  const name = appName(item, result);
  if (!done) return { icon: 'pulse', glyph: 'deploy', text: `Deploying ${name}`, live: true };
  const logs = { label: 'View logs', href: `/dashboard/${encodeURIComponent(name)}/build` };
  if (result?.status === 'running' && typeof result.url === 'string') {
    let host = result.url;
    try {
      host = new URL(result.url).host;
    } catch {}
    return {
      icon: 'pulse',
      glyph: 'deploy',
      text: `Deployed ${name}`,
      // Nothing changed since the last deploy, so the running release answered for it.
      outcome: `${result.unchanged === true ? 'Already live' : 'Live'} at ${host}`,
      outcomeHref: result.url,
      links: [logs],
    };
  }
  const log = typeof result?.logTail === 'string' ? result.logTail : output;
  const { outcome, reason } = deployFailure(log);
  // The reason is shown above the tail; the tail is what led to it, if the log says.
  const tail = log
    .split('\n')
    .map(logLine)
    .filter((line) => line && !BOILERPLATE.some((pattern) => pattern.test(line)))
    .slice(-3);
  // A timeout is not a failure the platform saw: the deploy may still finish.
  const waiting = /timed out waiting/i.test(log);
  return {
    icon: 'pulse',
    glyph: 'deploy',
    text: `Deployed ${name}`,
    outcome: waiting ? 'Still deploying after 10 minutes' : outcome,
    tone: waiting ? 'warn' : 'fail',
    reason,
    ...(tail.length ? { tail } : {}),
    links: [logs],
  };
}

/** One readable step for a tool call, or undefined for plumbing that has no step. */
export function toolStep(item: ToolItem, done: boolean, endedAt?: string): WorkStep | undefined {
  const name = toolName(item.name);
  if (!name || HIDDEN_TOOLS.has(name)) return;
  if (name === 'deploy_application') {
    const step = deployStep(item, done);
    const seconds = Math.round(
      (Date.parse(endedAt ?? '') - Date.parse(String(item.startedAt ?? ''))) / 1000,
    );
    return done && seconds >= 0 ? { ...step, seconds } : step;
  }
  const input = args(item);
  const failed = done && item.isError === true;
  const result = (step: WorkStep): WorkStep => ({
    ...step,
    ...(done ? {} : { live: true }),
    ...(failed ? { outcome: 'Failed', tone: 'fail' as const } : {}),
  });
  switch (name) {
    case 'Bash':
      return result({
        icon: 'terminal',
        text: short(String(input.description || input.command || 'Ran a command')),
      });
    case 'Read':
      return result({ icon: 'file', text: `Read ${basename(input.file_path)}` });
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return result({
        icon: 'edit',
        text: `${name === 'Write' ? 'Wrote' : 'Edited'} ${basename(input.file_path || input.notebook_path)}`,
      });
    case 'Grep':
    case 'Glob':
      return result({ icon: 'search', text: short(`Searched for ${input.pattern ?? ''}`) });
    case 'WebSearch':
      return result({ icon: 'search', text: short(`Searched the web for ${input.query ?? ''}`) });
    case 'WebFetch':
      return result({ icon: 'search', text: short(`Read ${input.url ?? 'a page'}`) });
    case 'deploy_checkpoint':
      return result({ icon: 'file', text: 'Saved a checkpoint' });
    case 'deploy_commit': {
      const commit = json(text(item.output));
      return result({
        icon: 'edit',
        text:
          typeof commit?.commit === 'string'
            ? `Committed ${commit.commit.slice(0, 8)} to ${commit.branch ?? 'its branch'}`
            : 'Committed',
      });
    }
    case 'deploy_create_repository':
      return result({ icon: 'file', text: `Created the ${input.name ?? ''} repository`.trim() });
    case 'deploy_ask_user':
      return result({ icon: 'pulse', text: 'Asked you a question' });
    default:
      return result({ icon: 'pulse', text: words(name) });
  }
}

/** A job the agent ran on a computer, as one step with its outcome. */
export function jobStep(
  job: Record<string, any> | undefined,
  type: string,
  payload: Record<string, any>,
  options: { computer?: string; taskId?: string } = {},
): WorkStep {
  const label = job?.name || job?.label || payload.name || job?.command || payload.command || 'Job';
  const state = type.slice(4);
  const exit = payload.exitCode ?? job?.exitCode;
  const where = options.computer ? ` on ${options.computer}` : '';
  const started = Date.parse(job?.startedAt || job?.createdAt || payload.createdAt || '');
  const ended = Date.parse(job?.finishedAt || job?.updatedAt || '');
  const seconds =
    ['succeeded', 'failed', 'cancelled', 'unknown'].includes(state) && started && ended > started
      ? Math.round((ended - started) / 1000)
      : undefined;
  const links = options.taskId
    ? [{ label: 'Output', href: `/dashboard/tasks/${encodeURIComponent(options.taskId)}/checks` }]
    : undefined;
  const base: WorkStep = {
    icon: 'terminal',
    text: short(String(label)),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(links ? { links } : {}),
  };
  if (state === 'queued') return { ...base, outcome: 'Waiting for a computer', live: true };
  if (state === 'running' || state === 'progress') return { ...base, live: true };
  if (state === 'succeeded') return { ...base, outcome: `Passed${where}` };
  if (state === 'failed')
    return {
      ...base,
      outcome: `Failed${where}${typeof exit === 'number' ? ` (exit ${exit})` : ''}`,
      tone: 'fail',
      ...(typeof payload.error === 'string' && payload.error ? { reason: payload.error } : {}),
    };
  if (state === 'cancelled') return { ...base, outcome: 'Cancelled', tone: 'warn' };
  return { ...base, outcome: 'Interrupted', tone: 'warn' };
}
