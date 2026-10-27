/**
 * How a recorded check is named where a reviewer reads it.
 *
 * An agent writes a verification command for one shell on one computer: it enters the task's own
 * directory, merges stderr into stdout, pipes a bounded tail so the agent can read the end of the
 * output, labels sections with `echo`, and strings several checks together with `&&`. None of
 * that says what was checked, and the directory it enters names a worker's private layout, which
 * means nothing to a reviewer and should never leave the computer that ran it.
 *
 * So a headline keeps the commands and drops the plumbing, with every path shown the way a task
 * view shows one (`taskSourceLabel`, `scrubWorkspacePaths`): repository-relative inside the task
 * workspace, the file name alone elsewhere on a worker's disk. The full command stays available
 * beside the headline — a tooltip or disclosure on the web, an accessibility value on native —
 * so nothing is hidden, only moved out of the line a reviewer reads first.
 *
 * This is not `commandTitle` (see `task-activity-summary.ts`), which names the programs a job
 * ran ("pnpm test", "curl → app.local") so a transcript row stays one line. A check is read by
 * what it checked, so its arguments — the test files, the name pattern — are the point.
 */

/** The task whose workspace a command's paths are read against. */
export interface CheckLabelContext {
  /** The task id: workers keep each task in `<worker root>/tasks/<id>`. */
  id?: string | null;
  workspacePath?: string | null;
  remoteWorkspacePath?: string | null;
}

/** Directories a worker owns. Any other absolute path (`/usr/bin/node`) is the same everywhere. */
const workerRoot = /^\/(?:Users|home|private|tmp|var)\//;

/** A word that is quoted from end to end, so unquoting it cannot split an argument. */
const quotedWord = /^(['"])([\s\S]*)\1$/;

const unquote = (word: string) => word.match(quotedWord)?.[2] ?? word;

/**
 * Where a path sits relative to the task workspace: `''` for the workspace root itself, the
 * repository-relative path for anything inside it, and `null` for a path that is genuinely
 * somewhere else.
 */
export function workspaceRelativePath(
  value: string,
  context: CheckLabelContext = {},
): string | null {
  const path = unquote(value)
    .replace(/^file:\/\/(?:localhost)?/i, '')
    .replace(/\/+$/, '');
  if (!path.startsWith('/')) return null;
  for (const root of [context.workspacePath, context.remoteWorkspacePath]) {
    const base = root?.replace(/\/+$/, '');
    if (base && (path === base || path.startsWith(base + '/')))
      return path.slice(base.length).replace(/^\//, '');
  }
  // A command can name the workspace of a task whose roots this surface was not given.
  const marker = context.id ? `/tasks/${context.id}` : '';
  const at = marker ? path.indexOf(marker) : -1;
  if (at >= 0 && (path.length === at + marker.length || path[at + marker.length] === '/'))
    return path.slice(at + marker.length).replace(/^\//, '');
  return null;
}

/** How a path a command names is shown: repository-relative in the task workspace, the file name
 * alone elsewhere in a worker's own directories, and unchanged anywhere else. */
export function checkPathText(value: string, context: CheckLabelContext = {}): string {
  const path = value.replace(/^file:\/\/(?:localhost)?/i, '');
  if (!path.startsWith('/')) return value;
  const relative = workspaceRelativePath(path, context);
  if (relative !== null) return relative || '.';
  return workerRoot.test(path) ? path.split('/').at(-1) || path : path;
}

/** A word can carry a path as a flag's value (`--project=/Users/me/app`), quoted or not. */
function checkWordPaths(word: string, context: CheckLabelContext): string {
  const quote = word.match(quotedWord)?.[1] ?? '';
  const bare = quote ? word.slice(1, -1) : word;
  const flag = bare.match(/^(--?[\w.-]+=)([\s\S]*)$/);
  const inner = unquote(flag ? flag[2] : bare);
  const cleaned = checkPathText(inner, context);
  if (cleaned === inner) return word;
  const text = (flag ? flag[1] : '') + cleaned;
  return /\s/.test(text) ? `"${text}"` : text;
}

/**
 * Split a command into its `&&`-separated segments and their words, keeping a quoted word whole
 * so no label ever cuts a quoted argument in half, and keeping `|` as a word of its own so a
 * pipeline's stages can be read.
 */
export function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  const endWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      word += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      word += char;
      continue;
    }
    if (char === '&' && command[index + 1] === '&') {
      endSegment();
      index++;
      continue;
    }
    if (char === '|') {
      endWord();
      words.push(command[index + 1] === '|' ? '||' : '|');
      if (command[index + 1] === '|') index++;
      continue;
    }
    if (/\s/.test(char)) {
      endWord();
      continue;
    }
    word += char;
  }
  endSegment();
  return segments;
}

/** `tail`, `head` and a line count: a bounded read of the output, and nothing a check did. */
function outputTail(words: string[]): boolean {
  if (!/^(?:tail|head)$/.test(words[0] ?? '')) return false;
  const rest = words.slice(1);
  if (rest.length === 1) return /^-n?\d+$/.test(rest[0]);
  if (rest.length === 2) return rest[0] === '-n' && /^\d+$/.test(rest[1]);
  return rest.length === 0;
}

/** Flags that only install a module loader before the runner starts, never what it checked. */
const loaderFlag = /^--(?:import|loader|experimental-loader)(?:=|$)/;

/** `node --import tsx --test a.test.ts` checks `a.test.ts`; the loader is how it was started. */
function withoutLoaderFlags(words: string[]): string[] {
  const kept: string[] = [];
  let loading = false;
  for (const word of words) {
    // A loader flag written with a space takes the module it loads with it.
    if (loading && !word.startsWith('-')) {
      loading = false;
      continue;
    }
    loading = loaderFlag.test(word) && !word.includes('=');
    if (!loaderFlag.test(word)) kept.push(word);
  }
  return kept;
}

/** A headline for one `&&` segment: its words, with plumbing and worker paths gone. */
function segmentLabel(words: string[], context: CheckLabelContext): string | null {
  const pipe = words.indexOf('|');
  // Only a bounded tail is dropped; any other pipeline is shown as it was written.
  const stages = pipe >= 0 && outputTail(words.slice(pipe + 1)) ? words.slice(0, pipe) : words;
  if (!stages.length) return null;
  const tool = unquote(stages[0]).split('/').at(-1);
  // `set -o pipefail` and a quoted `echo "=== LINT ==="` separator label a run; neither checks.
  if (tool === 'set' || tool === 'echo') return null;
  if (tool === 'cd' && stages.length === 2) {
    const relative = workspaceRelativePath(stages[1], context);
    // Entering the task workspace says where every check in the task ran. A directory inside it
    // narrows what ran, so it is kept, as the repository path a reviewer recognises; a directory
    // on some worker's disk that this surface cannot place says nothing either way.
    if (relative) return `cd ${relative}`;
    return relative === '' || unquote(stages[1]).startsWith('/') ? null : `cd ${stages[1]}`;
  }
  const kept = /^(?:node|tsx)$/.test(tool ?? '') ? withoutLoaderFlags(stages) : stages;
  return kept.map((word) => checkWordPaths(word, context)).join(' ');
}

/** How long a headline may get before it is cut; the full command is kept beside it. */
const labelChars = 300;

/**
 * The headline for a recorded command: the checks it ran, joined by `·`, with the shell plumbing
 * dropped and every worker path shown as a task view shows it. Pass the command already scrubbed
 * for credentials (`scrubCheckText`); this never puts back anything that was redacted.
 */
export function checkCommandLabel(
  command: string | null | undefined,
  context: CheckLabelContext = {},
): string {
  const text = String(command ?? '').replace(/(^|\s)2>&1(?=\s|$)/g, '$1');
  const labels = commandSegments(text)
    .map((words) => segmentLabel(words, context))
    .filter((label): label is string => !!label);
  // A command that was nothing but plumbing still has to read as something.
  return (labels.length ? labels.join(' · ') : text.replace(/\s+/g, ' ').trim()).slice(
    0,
    labelChars,
  );
}

/**
 * The full command, with only its worker paths rewritten. This is what a surface keeps beside the
 * headline, so a reviewer can read exactly what ran without a worker's directory layout in it.
 */
export function checkCommandText(
  command: string | null | undefined,
  context: CheckLabelContext = {},
): string {
  return commandSegments(String(command ?? ''))
    .map((words) => words.map((word) => checkWordPaths(word, context)).join(' '))
    .join(' && ');
}
