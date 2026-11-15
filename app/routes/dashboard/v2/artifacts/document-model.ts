import type { DocumentBlock } from '../../../../../shared/v2/artifacts';
import { changedBlocks, documentBlocks, documentBody } from '../../../../../shared/v2/artifacts';

/** A document as the page reads it from the server. */
export type DocumentPage = {
  projectId: string;
  project: string;
  artifact: string;
  title: string;
  /** The markdown on the branch shown, or on main. */
  text: string;
  /** The markdown on main; null while the document is only on its branch. */
  main: string | null;
  /** The branch being edited; null on main. */
  branch: string | null;
  commit: string | null;
  edits: number;
  changedAt: string | null;
  review: { id: string; branch: string; state?: string } | null;
};

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A block's inline markdown as HTML: bold, italic, code and links. Everything else is text. */
export function inlineHtml(markdown: string) {
  const codes: string[] = [];
  let html = escape(markdown).replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE000`;
  });
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) =>
      /^(https?:|mailto:|\/|#)/.test(href.replace(/&amp;/g, '&'))
        ? `<a href="${href}">${text}</a>`
        : text,
    );
  return html.replace(/\uE000(\d+)\uE000/g, (_, at: string) => `<code>${codes[Number(at)]}</code>`);
}

type Node = {
  nodeType: number;
  textContent: string | null;
  nodeName: string;
  childNodes: ArrayLike<Node>;
  getAttribute?: (name: string) => string | null;
};

/** Inline markdown for an edited element's contents: the inverse of inlineHtml. */
export function inlineMarkdown(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += (child.textContent ?? '').replace(/ /g, ' ');
      continue;
    }
    if (child.nodeType !== 1) continue;
    const inner = inlineMarkdown(child);
    const name = child.nodeName.toLowerCase();
    if (!inner.trim() && name !== 'br') {
      out += inner;
      continue;
    }
    if (name === 'strong' || name === 'b') out += `**${inner}**`;
    else if (name === 'em' || name === 'i') out += `*${inner}*`;
    else if (name === 'code') out += `\`${child.textContent ?? ''}\``;
    else if (name === 'a') out += `[${inner}](${child.getAttribute?.('href') ?? ''})`;
    else if (name === 'br') out += ' ';
    else out += inner;
  }
  return out.replace(/\s+/g, ' ');
}

/** The blocks an edited page holds, read from its elements in order. */
export function readBlocks(root: Node): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const text = (node: Node) => inlineMarkdown(node).trim();
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) {
      const loose = (child.textContent ?? '').trim();
      if (loose) blocks.push({ kind: 'paragraph', text: loose });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const name = child.nodeName.toLowerCase();
    if (name === 'ul' || name === 'ol')
      for (const item of Array.from(child.childNodes)) {
        if (item.nodeType !== 1) continue;
        blocks.push({ kind: name === 'ul' ? 'bullet' : 'number', text: text(item) });
      }
    else if (name === 'h2' || name === 'h3')
      blocks.push({ kind: 'heading', level: name === 'h2' ? 2 : 3, text: text(child) });
    else if (name === 'pre')
      blocks.push({ kind: 'code', text: (child.textContent ?? '').replace(/\n$/, '') });
    else {
      const value = text(child);
      // An empty line the cursor left behind is not a block; the page keeps one to type in.
      if (value) blocks.push({ kind: 'paragraph', text: value });
    }
  }
  return blocks;
}

/** How many blocks differ from main, in words for the page's line. */
export function changedLine(count: number) {
  return `${count} block${count === 1 ? '' : 's'} changed on this branch`;
}

/**
 * A document's line under its title. On main: "deploy.local · Document · on main · changed 3 days
 * ago". On a branch: how many blocks it changed. Not on main at all: "not on main yet".
 */
export function documentLine(
  project: string,
  where: 'main' | 'branch' | 'new',
  when = '',
  changed = 0,
) {
  const place =
    where === 'main'
      ? ['on main', when ? `changed ${when}` : null]
      : where === 'new'
        ? ['not on main yet']
        : [changed ? changedLine(changed) : null];
  return [project, 'Document', ...place].filter(Boolean).join(' · ');
}

/**
 * What a review shows on one side: After is the proposal with a dot on each block main lacks;
 * Before is main with a dot on each block the proposal changes or removes. A document not on main
 * has no Before and no dots, since every block is new.
 */
export function reviewMarks(main: string | null, proposed: string, side: 'before' | 'after') {
  const after = documentBlocks(documentBody(proposed));
  if (main === null)
    return {
      isNew: true,
      side: 'after' as const,
      blocks: after,
      marked: after.map(() => false),
      count: after.length,
      progress: 'new document',
    };
  const before = documentBlocks(documentBody(main));
  const changed = changedBlocks(before, after);
  const count = changed.filter(Boolean).length;
  return {
    isNew: false,
    side,
    blocks: side === 'after' ? after : before,
    marked: side === 'after' ? changed : changedBlocks(after, before),
    count,
    progress: `${count} block${count === 1 ? '' : 's'} changed`,
  };
}

/**
 * Which blocks being edited differ from main, for their dots. A document not on main yet is new
 * throughout, so no block is marked: its line says not on main yet instead.
 */
export function editedBlocks(
  main: string | null,
  mainBlocks: DocumentBlock[],
  blocks: DocumentBlock[],
) {
  return main === null ? blocks.map(() => false) : changedBlocks(mainBlocks, blocks);
}
