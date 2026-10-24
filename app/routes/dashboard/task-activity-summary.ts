type Row = Record<string, any>;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const activeJob = (job: Row) => ['running', 'queued'].includes(job.status);
export const jobStatus = (job: Row): string =>
  ({
    succeeded: 'Passed',
    failed: 'Failed',
    running: 'Running',
    queued: 'Queued',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    timed_out: 'Failed',
  })[job.status as string] ?? 'Unavailable';
export const failedJob = (job: Row) => ['failed', 'timed_out'].includes(job.status);
export const normaliseCommand = (command: string) => command.trim().replace(/\s+/g, ' ');
/** A check is its label, or its command summary, on one computer. Summaries ignore shell
 * plumbing (`| tee`, `&& cat`, `if !`, `timeout`), so a retry with a tweaked command folds into
 * the same check while genuinely different checks keep different titles. */
export function checkIdentity(job: Row): string {
  return JSON.stringify([
    job.workerId ?? null,
    job.name?.trim()
      ? ['label', job.name.trim()]
      : ['command', commandTitle(job.command ?? job.id ?? '')],
  ]);
}
const newest = (a: Row, b: Row) =>
  String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
  String(b.id ?? '').localeCompare(String(a.id ?? ''));
export function latestChecks<T extends Row>(jobs: T[]) {
  const groups = new Map<string, T[]>();
  for (const job of [...jobs].sort(newest)) {
    const key = checkIdentity(job);
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return [...groups].map(([key, attempts]) => ({
    key,
    latest: attempts[0]!,
    earlier: attempts.slice(1),
    failures: attempts.slice(1).filter(failedJob).length,
  }));
}
export function orderedJobs<T extends Row>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => Number(activeJob(b)) - Number(activeJob(a)) || newest(a, b));
}
export function activitySections(
  jobs: Row[],
  runs: Row[] = [],
  messages: Row[] = [],
  allAttempts: Row[] = jobs,
) {
  const now = orderedJobs(jobs.filter(activeJob));
  const attention = latestChecks(jobs)
    .map((c) => c.latest)
    .filter((j) => failedJob(j) || (j.status === 'queued' && j.waitingReason));
  const groups = new Map<string, Row[]>();
  for (const job of [...jobs].sort(newest))
    groups.set(job.runId ?? '', [...(groups.get(job.runId ?? '') ?? []), job]);
  const orderedRuns = [...runs].sort((a, b) => -newest(a, b));
  const turns = [...groups]
    .map(([runId, attempts]) => {
      const run = runs.find((r) => r.id === runId);
      const message =
        messages.find((m) => m.role === 'user' && m.runId === runId) ??
        (run
          ? [...messages].reverse().find((m) => m.role === 'user' && m.createdAt <= run.createdAt)
          : undefined);
      const number = orderedRuns.findIndex((r) => r.id === runId) + 1;
      return {
        runId,
        number,
        jobCount: allAttempts.filter((job) => (job.runId ?? '') === runId).length,
        title: runId
          ? `Turn${number ? ` ${number}` : ''}${message ? ` · ${endTruncate(message.content.split('\n')[0], 80)}` : ''}`
          : 'Other',
        jobs: [...attempts].reverse(),
        allPassed: latestChecks(attempts).every((c) => c.latest.status === 'succeeded'),
        createdAt: run?.createdAt ?? attempts[0]?.createdAt ?? '',
      };
    })
    .sort((a, b) => (!a.runId ? 1 : !b.runId ? -1 : newest(a, b)));
  return { now, attention, turns };
}
export const endTruncate = (text: string, limit = 80) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
export function middleTruncate(text: string, limit = 64): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-(limit - half - 1))}`;
}
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'esac',
  '!',
  '{',
  '}',
  '(',
  ')',
]);
const WRAPPERS = new Set([
  'timeout',
  'env',
  'nohup',
  'dbus-run-session',
  'xvfb-run',
  'exec',
  'command',
  'time',
]);
// Helpers that shape output or the environment rather than being the thing checked.
const PLUMBING = new Set([
  'cd',
  'set',
  'echo',
  'printf',
  'grep',
  'head',
  'tail',
  'test',
  '[',
  '[[',
  'true',
  'false',
  ':',
  'sleep',
  'break',
  'continue',
  'tee',
  'cat',
  'ls',
  'exit',
  'return',
  'base64',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'sed',
  'awk',
  'xargs',
  'rm',
  'mkdir',
  'touch',
  'mktemp',
  'export',
  'unset',
  'wait',
  'kill',
  'trap',
  'read',
  'jq',
  'pwd',
  'date',
  'which',
  'type',
  'stat',
  'file',
]);
/** Display-only shell summary. Never evaluate or rewrite the command used for execution. */
export function commandTitle(command: string): string {
  const clean = command
    .replace(/\b[A-Za-z_]\w*=\$\([^)]*\)\s*;?/g, '')
    .replace(
      /(?:^|[;&])\s*(?:cd\s+[^;&]+|set\s+-[eu]+|(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^;\s]+))\s*(?:&&|;)?/g,
      '',
    );
  const programs: string[] = [];
  for (const part of clean.split(/&&|;|\|\|?|\n/)) {
    const tokens = part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    // Loops and case arms say nothing about what ran; their bodies are separate parts.
    if (['for', 'case', 'select'].includes(tokens[0] ?? '')) continue;
    while (SHELL_KEYWORDS.has(tokens[0] ?? '')) tokens.shift();
    // Wrappers run another program: summarise that one instead.
    while (WRAPPERS.has(tokens[0]?.split('/').pop() ?? '')) {
      tokens.shift();
      while (tokens.length && /^-|^\d+[smhd]?$|^--$|=/.test(tokens[0]!)) tokens.shift();
    }
    const program = tokens[0]?.split('/').pop();
    // Variables (`"$b" --flag`) hide which program ran; skip rather than show shell syntax.
    if (!program || PLUMBING.has(program) || program.includes('=') || /^["']?\$/.test(program))
      continue;
    // Version probes (`node --version`) only record the toolchain.
    if (tokens.length === 2 && /^-{1,2}(version|v)$/.test(tokens[1]!)) continue;
    let title = program;
    if (['curl', 'firefox', 'chromium'].includes(program)) {
      const host = part.match(/https?:\/\/([^/\s'";]+)/)?.[1];
      if (host) title += ` → ${host}`;
    } else if (['git', 'swift', 'npm', 'pnpm', 'yarn', 'cargo', 'go'].includes(program)) {
      const action = tokens
        .slice(1)
        .find((t) => !t.startsWith('-') && !t.includes('=') && !t.startsWith("'"));
      if (
        program === 'git' &&
        ['status', 'add'].includes(action ?? '') &&
        /\bgit\b.*\b(commit|push)\b/.test(clean)
      )
        continue;
      if (action) title += ` ${action}`;
    } else if (program === 'xcodebuild' && part.includes('-version') && /\bswift\s/.test(clean))
      continue;
    if (!programs.includes(title)) programs.push(title);
  }
  return middleTruncate(
    programs.join(' + ').replace('git commit + git push', 'git commit + push') ||
      normaliseCommand(command),
  );
}
export const jobTitle = (job: Row) => job.name?.trim() || commandTitle(job.command ?? '');
export function jobDuration(job: Row, now = Date.now()): string {
  const start = Date.parse(job.status === 'queued' ? job.createdAt : job.startedAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : activeJob(job) ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${job.status === 'queued' ? 'Queued ' : ''}${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}`;
}
export function relativeTime(value: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  return seconds < 60
    ? 'just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
}
export function activitySources(activity: Row[] = []): string[] {
  return [
    ...new Set<string>(
      activity.flatMap((turn) =>
        (turn.items ?? [])
          .filter(
            (item: Row) =>
              item.source &&
              item.source !== '.' &&
              !item.source.endsWith('/') &&
              !['directory', 'list', 'list_directory'].includes(item.kind) &&
              (/^https?:\/\//.test(item.source) ||
                /\.[^/]+$/.test(item.source) ||
                ['read', 'file'].includes(item.kind)),
          )
          .map((item: Row) => item.source.replace(/^\.\//, '')),
      ),
    ),
  ];
}
export function activitySummary(jobs: Row[] = [], activity: Row[] = []) {
  const checks = latestChecks(jobs);
  const running = checks.filter((c) => activeJob(c.latest)).length;
  const failing = checks.filter((c) => failedJob(c.latest)).length;
  const passed = checks.filter((c) => c.latest.status === 'succeeded').length;
  const computers = new Set(jobs.map((j) => j.workerId).filter(Boolean)).size;
  const sources = activitySources(activity).length;
  const parts = [
    failing ? `${failing} failing` : '',
    running ? `${running} running` : '',
    jobs.length
      ? `${count(jobs.length, 'job')}${computers ? ` on ${count(computers, 'computer')}` : ''}`
      : '',
    !jobs.length && sources ? `Read ${count(sources, 'file')}` : '',
  ].filter(Boolean);
  return {
    visible: jobs.length > 0 || sources > 0,
    running,
    failing,
    passed,
    computers,
    label: `Activity: ${parts.join(', ')}`,
    text: parts.join(' · '),
  };
}

/** A terminal run's updatedAt is its recorded completion; never use the last tool's time. */
export function runDuration(run?: Row, now = Date.now()): string {
  if (!run) return '';
  const start = Date.parse(run.createdAt);
  // An 'unknown' run stopped being observed when its computer restarted (its updatedAt).
  const end = ['queued', 'starting', 'running'].includes(run.status)
    ? now
    : Date.parse(run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.floor((end - start) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
