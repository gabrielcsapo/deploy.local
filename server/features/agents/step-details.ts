import type { StepDetail, StepDiffRow } from '../../../shared/v2/contracts.ts';
/** A call as its events carry it; the same shape work-steps reads. */
type ToolItem = { name?: unknown; arguments?: unknown; output?: unknown; isError?: unknown };

/** `mcp__deploy__deploy_application` reads as `deploy_application`. */
const toolName = (name: unknown) =>
  typeof name === 'string' ? name.replace(/^mcp__.+?__/, '') : '';

/**
 * What a step did, for when a person opens it: the command and the end of its output, the
 * file and its diff, or what a search found. Built from the step's own stored events only
 * when it is opened, so a long task's page stays small.
 */

const OUTPUT_LINES = 40;
const LINE_CHARS = 400;
const DIFF_ROWS = 200;
const FOUND_LINES = 50;
/** Above this many lines a side, an edit is shown as removed then added, without matching. */
const DIFF_MATCH_LIMIT = 600;
const CONTEXT = 3;

function args(item: ToolItem): Record<string, unknown> {
  return item.arguments && typeof item.arguments === 'object'
    ? (item.arguments as Record<string, unknown>)
    : {};
}

/** A tool result's text, whether it came as a string or as content blocks. */
export function outputText(value: unknown): string {
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

const clip = (line: string) =>
  line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line;

/** The last lines of some output, without trailing blank lines. */
function tail(text: string, count = OUTPUT_LINES) {
  const trimmed = text.replace(/\s+$/, '');
  // No output is no lines, not one empty line.
  const lines = trimmed ? trimmed.split('\n') : [];
  return { lines: lines.slice(-count).map(clip), more: Math.max(0, lines.length - count) };
}

function split(text: unknown) {
  if (typeof text !== 'string' || text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

/** A file in the task's own folder reads as its path in the repository: web/server.mjs. */
export function repositoryPath(path: string) {
  return path.replace(
    /^.*\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i,
    '',
  );
}

/** Lines added and removed by an edit, matched line by line. */
export function diffRows(before: string[], after: string[], start = 1): StepDiffRow[] {
  const rows: StepDiffRow[] = [];
  if (before.length > DIFF_MATCH_LIMIT || after.length > DIFF_MATCH_LIMIT) {
    before.forEach((text, index) => rows.push({ kind: 'del', old: start + index, text }));
    after.forEach((text, index) => rows.push({ kind: 'add', new: start + index, text }));
    return rows;
  }
  // Longest common subsequence, then walk it to rows.
  const n = before.length,
    m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      rows.push({ kind: 'same', old: start + i, new: start + j, text: before[i] });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] > lcs[i + 1][j])) {
      rows.push({ kind: 'add', new: start + j, text: after[j] });
      j++;
    } else {
      rows.push({ kind: 'del', old: start + i, text: before[i] });
      i++;
    }
  }
  return rows;
}

/** Changed rows with a few lines of context around them; long runs of unchanged lines fold. */
function withContext(rows: StepDiffRow[]): StepDiffRow[] {
  const keep = rows.map(() => false);
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(rows.length - 1, index + CONTEXT); k++)
      keep[k] = true;
  });
  const out: StepDiffRow[] = [];
  rows.forEach((row, index) => {
    if (keep[index]) out.push({ ...row, text: clip(row.text) });
    else if (keep[index - 1] || (index === 0 && rows.length > 1))
      out.push({ kind: 'hunk', text: '⋯' });
  });
  return out.at(-1)?.kind === 'hunk' ? out.slice(0, -1) : out;
}

/**
 * Where an edit landed in its file. Claude's Edit result shows a numbered snippet of the file
 * ("  38→text" or "  38\ttext"); the first line of the new text is found in it. Without one, the
 * diff has no line numbers rather than made-up ones.
 */
function editStart(item: ToolItem, after: string[]): number | undefined {
  const first = after.find((line) => line.trim());
  if (!first) return;
  for (const line of outputText(item.output).split('\n')) {
    const numbered = line.match(/^\s*(\d+)(?:→|\t)(.*)$/);
    if (numbered && numbered[2] === first) return Number(numbered[1]) - after.indexOf(first);
  }
}

const unnumbered = (row: StepDiffRow): StepDiffRow => ({ kind: row.kind, text: row.text });

/** The edits a call made, as before and after lines. */
function edits(item: ToolItem): { before: string[]; after: string[] }[] {
  const input = args(item);
  switch (toolName(item.name)) {
    case 'Write':
      return [{ before: [], after: split(input.content) }];
    case 'Edit':
      return [{ before: split(input.old_string), after: split(input.new_string) }];
    case 'MultiEdit':
      return Array.isArray(input.edits)
        ? input.edits.map((edit: any) => ({
            before: split(edit?.old_string),
            after: split(edit?.new_string),
          }))
        : [];
    default:
      return [];
  }
}

/** Lines an edit added and removed, for the row: "+5 −0". */
export function editCounts(item: ToolItem): { added: number; removed: number } | undefined {
  const all = edits(item);
  if (!all.length) return;
  let added = 0,
    removed = 0;
  for (const { before, after } of all)
    for (const row of diffRows(before, after)) {
      if (row.kind === 'add') added++;
      if (row.kind === 'del') removed++;
    }
  return { added, removed };
}

/** What a search found, for the row: "3 files", "12 matches". */
export function searchFound(item: ToolItem): string | undefined {
  const text = outputText(item.output).trim();
  if (!text) return;
  const found = text.match(/^Found (\d+) (files?|matches|lines?)/i);
  if (found) return `${found[1]} ${found[2].toLowerCase()}`;
  if (/^No (files|matches) found/i.test(text)) return 'Nothing found';
  const count = text.split('\n').filter((line) => line.trim()).length;
  return toolName(item.name) === 'Glob'
    ? `${count} ${count === 1 ? 'file' : 'files'}`
    : `${count} ${count === 1 ? 'line' : 'lines'}`;
}

/** Whether opening this step has anything to show. */
export function stepOpens(item: ToolItem, done: boolean): boolean {
  const name = toolName(item.name);
  // A running command opens to the command; its output arrives when it finishes.
  if (!done) return name === 'Bash' && typeof args(item).command === 'string';
  if (['Bash', 'Grep', 'Glob'].includes(name)) return true;
  if (['Edit', 'MultiEdit', 'Write'].includes(name)) return edits(item).length > 0;
  return item.isError === true && outputText(item.output).trim() !== '';
}

/** A codex command item: its command and output. */
function commandDetail(item: Record<string, any>): StepDetail {
  const output = tail(String(item.aggregated_output ?? item.output ?? ''));
  return {
    command: typeof item.command === 'string' ? item.command : undefined,
    output: output.lines,
    ...(output.more ? { more: output.more } : {}),
    ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
  };
}

/** Everything opening one step shows. */
export function stepDetail(item: ToolItem & Record<string, any>): StepDetail {
  if (item.type === 'command_execution') return commandDetail(item);
  const name = toolName(item.name);
  const input = args(item);
  const text = outputText(item.output);
  if (name === 'Bash') {
    const output = tail(text);
    return {
      command: typeof input.command === 'string' ? input.command : undefined,
      output: output.lines,
      ...(output.more ? { more: output.more } : {}),
    };
  }
  if (['Edit', 'MultiEdit', 'Write'].includes(name)) {
    const path = repositoryPath(String(input.file_path || input.notebook_path || ''));
    const all = edits(item);
    const rows = all.flatMap(({ before, after }, index) => {
      // A new file starts at line 1; an edit starts where its result says, if it says.
      const start = name === 'Write' ? 1 : all.length === 1 ? editStart(item, after) : undefined;
      const diff = withContext(diffRows(before, after, start ?? 1));
      return [
        ...(index ? [{ kind: 'hunk' as const, text: '⋯' }] : []),
        ...(start === undefined ? diff.map(unnumbered) : diff),
      ];
    });
    return {
      path,
      diff: rows.slice(0, DIFF_ROWS),
      ...(rows.length > DIFF_ROWS ? { more: rows.length - DIFF_ROWS } : {}),
      // An edit that failed says why instead of a diff that never landed.
      ...(item.isError === true ? { output: tail(text).lines } : {}),
    };
  }
  if (name === 'Grep' || name === 'Glob') {
    const lines = text.replace(/\s+$/, '').split('\n').filter(Boolean);
    return {
      command:
        [input.pattern, input.path || input.glob].filter(Boolean).join('  in  ') || undefined,
      found: lines.slice(0, FOUND_LINES).map(clip),
      ...(lines.length > FOUND_LINES ? { more: lines.length - FOUND_LINES } : {}),
    };
  }
  return { output: tail(text).lines };
}
