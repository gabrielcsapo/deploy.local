import { projectPath, projectSegment } from '../projects/routing.ts';

/** What the search API answers with; see `server/v2/search.ts`. */
export type SearchName = {
  kind: 'project' | 'app' | 'task' | 'agent' | 'computer' | 'pull' | 'issue';
  id: string;
  title: string;
  projectId?: string;
  project?: string;
  appKind?: 'web' | 'worker';
  status?: string;
  agent?: string;
  number?: number;
  at?: string;
};
export type SearchMessage = {
  id: string;
  taskId?: string;
  agentId?: string;
  title: string;
  who: string;
  fromYou: boolean;
  at: string;
  snippet: string;
};
export type FileMatch = { path: string; name: string; directory: string };
export type SearchResponse = {
  query: string;
  names: SearchName[];
  messages: { total: number; items: SearchMessage[] };
  files?: { total: number; items: FileMatch[]; ref: string };
};
export type CodeItem = {
  projectId: string;
  project: string;
  ref: string;
  path: string;
  line: number;
  text: string;
};
export type SearchCodeResponse = {
  query: string;
  lines: number;
  files: number;
  projects: number;
  truncated: boolean;
  ref?: string;
  items: CodeItem[];
};
/** Where a search starts: everywhere, or inside one project (and the branch its Code tab shows). */
export type SearchScope = { id: string; name: string; ref?: string };
export type SearchKind = 'code' | 'messages';

/** Text needs this many characters before code and messages are searched. */
export const TEXT_MIN = 3;

export const searchEvent = 'deploy:search';
/** Open the one search box, optionally inside a project. */
export function openSearch(scope?: SearchScope | null) {
  window.dispatchEvent(new CustomEvent(searchEvent, { detail: { scope: scope ?? undefined } }));
}

/** `text` cut at every match of `query`, ignoring case; odd entries are the matches. */
export function matchParts(text: string, query: string): string[] {
  if (!query) return [text];
  const parts: string[] = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    parts.push(text.slice(from, at), text.slice(at, at + needle.length));
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

export const codeHref = (
  item: Pick<CodeItem, 'projectId' | 'ref' | 'path'>,
  line?: number,
  find?: string,
) => {
  const query = new URLSearchParams({ ref: item.ref, file: item.path });
  if (line) query.set('line', String(line));
  if (find) query.set('find', find);
  return `${projectPath(item.projectId)}/code?${query}`;
};

export function nameHref(name: SearchName) {
  switch (name.kind) {
    case 'project':
      return projectPath(name.id);
    case 'app':
      return `${projectPath(name.projectId!)}/apps/${projectSegment(name.title)}`;
    case 'task':
      return `/dashboard/tasks/${encodeURIComponent(name.id)}`;
    case 'agent':
      return `/dashboard/agents/${encodeURIComponent(name.id)}`;
    case 'computer':
      return '/dashboard/computers';
    case 'pull':
      return `${projectPath(name.projectId!)}/pulls/${projectSegment(name.id)}`;
    case 'issue':
      // Ideas have no page of their own; they are rows in the project's Work tab.
      return `${projectPath(name.projectId!)}/work`;
  }
}

export const messageHref = (message: SearchMessage) =>
  message.taskId
    ? `/dashboard/tasks/${encodeURIComponent(message.taskId)}?message=${encodeURIComponent(message.id)}`
    : `/dashboard/agents/${encodeURIComponent(message.agentId!)}?message=${encodeURIComponent(message.id)}`;

/** "12 lines in 5 files", with a plus when the search stopped early. */
export function codeCount(code: Pick<SearchCodeResponse, 'lines' | 'files' | 'truncated'>) {
  const more = code.truncated ? '+' : '';
  return `${code.lines}${more} ${code.lines === 1 ? 'line' : 'lines'} in ${code.files}${more} ${code.files === 1 ? 'file' : 'files'}`;
}

/** Code results grouped by file, in the order they arrived. */
export function byFile(items: CodeItem[]) {
  const groups: { key: string; project: string; path: string; items: CodeItem[] }[] = [];
  for (const item of items) {
    const key = `${item.projectId}\0${item.path}`;
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, project: item.project, path: item.path, items: [item] });
  }
  return groups;
}
