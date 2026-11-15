import type { DocumentBlock } from '../../../../../shared/v2/artifacts';

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
  review: { id: string; branch: string } | null;
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
