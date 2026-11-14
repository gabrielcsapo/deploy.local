export type RepositoryCommit = { oid: string; author: string; date: string; subject: string };
export function repositoryTime(value?: string, now = Date.now()) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return 'Unavailable';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'just now';
  for (const [unit, duration] of [
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ] as const) {
    if (seconds >= duration) {
      const count = Math.floor(seconds / duration);
      return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}
export function sourceLines(content: string) {
  if (!content) return [];
  return content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}
export function fileSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function sourceMarkdown(file: string, content: string) {
  const extension = file.split('.').at(-1)?.toLowerCase() || '';
  const languages: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    json: 'json',
    css: 'css',
    html: 'xml',
    md: 'markdown',
    py: 'python',
    sh: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
  };
  const fence = '`'.repeat(
    Array.from(content.matchAll(/`+/g)).reduce(
      (longest, match) => Math.max(longest, match[0].length + 1),
      3,
    ),
  );
  return `${fence}${languages[extension] || 'text'}\n${sourceLines(content).join('\n')}\n${fence}`;
}

/** Where `find` occurs in `text`, ignoring case, as [start, end) offsets. */
export function matchOffsets(text: string, find: string): [number, number][] {
  const found: [number, number][] = [];
  if (!find) return found;
  const lower = text.toLowerCase();
  const needle = find.toLowerCase();
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length))
    found.push([at, at + needle.length]);
  return found;
}
/**
 * Marks every occurrence of `find` in a rendered source block, without changing its elements: the
 * syntax highlighter splits words across spans, so the marks are ranges over the text, drawn by
 * the browser's highlight registry. Returns a function that removes them.
 */
export function markMatches(block: Element | null, find: string) {
  const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
  if (!block || !find || !registry || typeof Highlight === 'undefined') return undefined;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.nodeValue ?? '';
  }
  const locate = (offset: number, end: boolean) => {
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (nodes[middle].start < offset || (!end && nodes[middle].start === offset)) low = middle;
      else high = middle - 1;
    }
    return [nodes[low].node, offset - nodes[low].start] as const;
  };
  const ranges = matchOffsets(text, find).map(([start, end]) => {
    const range = new Range();
    range.setStart(...locate(start, false));
    range.setEnd(...locate(end, true));
    return range;
  });
  if (!ranges.length) return undefined;
  registry.set('v2-search-match', new Highlight(...ranges));
  return () => {
    registry.delete('v2-search-match');
  };
}
