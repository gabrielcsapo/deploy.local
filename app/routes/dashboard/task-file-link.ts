export interface TaskFileReference {
  path: string;
  line?: number;
}

export interface TaskFileContext {
  id: string;
  workspacePath?: string | null;
  remoteWorkspacePath?: string | null;
}

/**
 * Agents link files as absolute worker paths, often with a line (`/…/tasks/<id>/web/a.mjs:12`).
 * Map any link inside the task workspace to its repository-relative path; external links,
 * anchors and paths outside the workspace return null and keep their normal behaviour.
 */
export function taskFileReference(
  href: string | null | undefined,
  task: TaskFileContext,
): TaskFileReference | null {
  let value = (href || '').trim();
  if (!value || value.startsWith('#') || value.startsWith('?') || value.startsWith('//'))
    return null;
  if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\/(?:localhost)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  try {
    value = decodeURI(value);
  } catch {
    /* Keep the link text as written. */
  }
  let line: number | undefined;
  const anchor = value.match(/#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/);
  const suffix = anchor ? null : value.match(/:(\d+)(?::\d+)?(?:-\d+)?$/);
  if (anchor || suffix) {
    line = Number((anchor || suffix)![1]);
    value = value.slice(0, (anchor || suffix)!.index);
  }
  value = value.replace(/[?#].*$/, '');
  let relative: string | null = null;
  if (value.startsWith('/')) {
    for (const root of [task.workspacePath, task.remoteWorkspacePath]) {
      const prefix = root ? root.replace(/\/+$/, '') + '/' : '';
      if (prefix && value.startsWith(prefix)) {
        relative = value.slice(prefix.length);
        break;
      }
    }
    // Workers keep each task in `<worker root>/tasks/<taskId>`; the task id is unique.
    const marker = `/tasks/${task.id}/`;
    if (relative === null && value.includes(marker))
      relative = value.slice(value.indexOf(marker) + marker.length);
  } else relative = value;
  if (relative === null) return null;
  relative = relative.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  const parts = relative.split('/');
  if (!relative || parts.some((part) => !part || part === '.' || part === '..')) return null;
  return line && line > 0 ? { path: relative, line } : { path: relative };
}

// Paths the dashboard itself serves; any other absolute path is on some computer's disk.
const appRoute = /^\/(?:dashboard|api|docs|discover|changelog)(?:[/?#]|$)/;

/**
 * A link to a file on a computer's disk (`file://…` or an absolute path that is not a dashboard
 * route). Browsers cannot open these, so links that are not inside the task render as code.
 */
export function isLocalFilePath(href: string | null | undefined): boolean {
  const value = (href || '').trim();
  if (/^file:\/\//i.test(value)) return true;
  return value.startsWith('/') && !value.startsWith('//') && !appRoute.test(value);
}

/** An attachment is matched to a path by name; only media has a viewer to open. */
export interface MessageAttachment {
  id: string;
  name: string;
  kind?: string;
}

export const viewableAttachment = (attachment: MessageAttachment | null | undefined) =>
  attachment && ['image', 'video'].includes(attachment.kind || '') ? attachment : null;

const fileName = (path: string) => {
  let value = path.replace(/^file:\/\/(?:localhost)?/i, '').replace(/[?#].*$/, '');
  try {
    value = decodeURI(value);
  } catch {
    /* Keep the path as written. */
  }
  return (
    value
      .replace(/:\d+(?::\d+)?$/, '')
      .split('/')
      .at(-1) || ''
  );
};

/**
 * A file the agent attached to this task, matched by name. Job artifacts and attachments are
 * copied off their computer, so the agent names them by a path only that computer has; the
 * dashboard can still open the copy it holds.
 */
export function attachmentForPath(
  path: string | null | undefined,
  attachments: MessageAttachment[] | undefined,
): MessageAttachment | null {
  const name = fileName(path || '');
  if (!name || !attachments?.length) return null;
  return attachments.find((attachment) => attachment.name === name) || null;
}

/** Where the dashboard serves an attachment the agent produced. */
export const attachmentURL = (id: string) => `/api/workspace/attachments/${encodeURIComponent(id)}`;

// Code spans, Markdown links/images and autolinks keep their text exactly as written.
const protectedSpan = /(`+)[\s\S]*?\1|!?\[[^\]\n]*\]\([^)\n]*\)|<[^\s<>]*>/g;
// A bare absolute path, with an optional `:12` or `#L12` location. Paths containing spaces or
// Markdown punctuation are left alone: there is no way to tell where they end in prose. The
// lookbehind keeps the path inside a URL (`https://host/a/b`) from matching on its own.
const barePath =
  /(?<![\w:/@.~%+-])(?:file:\/\/(?:localhost)?)?\/(?:[\w.@~%+-]+\/)+[\w.@~%+-]*(?:[:#]L?\d+(?:[-:]L?\d+)?)?/g;

/**
 * Agents name files by their absolute path on the task computer, and often as bare text rather
 * than a Markdown link. The dashboard cannot open another computer's path, so each one is
 * rewritten before the Markdown is parsed: a path inside the task workspace becomes a link the
 * task opens, a path naming media the agent attached shows that attachment, and anything else
 * becomes inline code instead of text that looks openable but is not.
 */
export function rewriteMessagePaths(
  content: string,
  context: { task?: TaskFileContext; attachments?: MessageAttachment[] },
): string {
  if (!content.includes('/')) return content;
  let fence = '';
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/^ {0,3}/, '');
      if (fence) {
        if (trimmed.startsWith(fence)) fence = '';
        return line;
      }
      if (/^(?:```|~~~)/.test(trimmed)) {
        fence = trimmed.slice(0, 3);
        return line;
      }
      let rewritten = '',
        cursor = 0;
      for (const span of line.matchAll(protectedSpan)) {
        rewritten += rewriteBarePaths(line.slice(cursor, span.index), context) + span[0];
        cursor = span.index + span[0].length;
      }
      return rewritten + rewriteBarePaths(line.slice(cursor), context);
    })
    .join('\n');
}

function rewriteBarePaths(
  text: string,
  context: { task?: TaskFileContext; attachments?: MessageAttachment[] },
) {
  if (!text.includes('/')) return text;
  let rewritten = '',
    cursor = 0;
  for (const match of text.matchAll(barePath)) {
    // Sentence punctuation that happens to end a path stays outside the rewrite.
    const trailing = match[0].match(/[.,;:]+$/)?.[0] ?? '';
    const path = match[0].slice(0, match[0].length - trailing.length);
    rewritten += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const reference = context.task ? taskFileReference(path, context.task) : null;
    const attachment = reference
      ? null
      : viewableAttachment(attachmentForPath(path, context.attachments));
    rewritten += !isLocalFilePath(path)
      ? path
      : reference
        ? `[${path}](<${path}>)`
        : attachment
          ? `![${attachment.name}](${attachmentURL(attachment.id)})`
          : `\`${path}\``;
    rewritten += trailing;
  }
  return rewritten + text.slice(cursor);
}
