/** Artifacts: designs and documents kept in a project's repository. */
export type ArtifactKind = 'design' | 'document';

export type ArtifactSummary = {
  projectId: string;
  project: string;
  /** The folder's name under artifacts/; null for the App design in design/. */
  artifact: string | null;
  kind: ArtifactKind;
  name: string;
  /** A design's boards. */
  boards?: number;
  /** When its newest work changed, on main or on its branch. */
  updatedAt: string | null;
  /** Set while it exists only on its own branch. */
  branch: string | null;
  /** Only while its newest work is not on main: waiting for review, or not proposed yet. */
  state: 'review' | 'unproposed' | null;
};

/**
 * The document a design review is of, by its folder name, or null when it reviews a design. A
 * document is an artifacts/<name> folder whose proposal changes its document.md.
 */
export function reviewedDocument(
  context: { folder?: unknown; paths?: unknown } | null | undefined,
) {
  const folder = typeof context?.folder === 'string' ? context.folder : '';
  if (!folder.startsWith('artifacts/') || !Array.isArray(context?.paths)) return null;
  return context.paths.includes(`${folder}/document.md`) ? folder.slice('artifacts/'.length) : null;
}

/** The approve action's words: a document is approved as a document. */
export const approveLabel = (document: string | null | undefined) =>
  document ? 'Approve document' : 'Approve design';

/** The folder name for a new artifact: "Onboarding flow" is artifacts/onboarding-flow. */
export function artifactSlug(name: string) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** A document's title: its first `# ` line. */
export function documentTitle(markdown: string) {
  return /^#\s+(.+)$/m.exec(markdown)?.[1].trim() ?? '';
}

/** A document's text without its title line, which the page shows as the heading. */
export function documentBody(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((line) => /^#\s+/.test(line));
  return (at >= 0 ? lines.slice(at + 1) : lines).join('\n').replace(/^\n+/, '');
}

/**
 * The blocks of a document's body, as the page shows and edits them: a paragraph, a heading, a
 * list (each item its own block), or a code block. Blank lines separate paragraphs.
 */
export type DocumentBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'code'; text: string };

export function documentBlocks(body: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      for (index++; index < lines.length && !/^```/.test(lines[index]); index++)
        code.push(lines[index]);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length as 2 | 3, text: heading[2].trim() });
    } else if (bullet) {
      flush();
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
    } else if (number) {
      flush();
      blocks.push({ kind: 'number', text: number[1].trim() });
    } else if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** Markdown for blocks, the inverse of documentBlocks. */
export function blocksMarkdown(title: string, blocks: DocumentBlock[]) {
  const out: string[] = [`# ${title.trim()}`, ''];
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    const sameList =
      previous &&
      previous.kind === block.kind &&
      (block.kind === 'bullet' || block.kind === 'number');
    if (index > 0 && !sameList) out.push('');
    if (block.kind === 'heading') out.push(`${'#'.repeat(block.level)} ${block.text}`);
    else if (block.kind === 'bullet') out.push(`- ${block.text}`);
    else if (block.kind === 'number') {
      let n = 1;
      for (let at = index - 1; at >= 0 && blocks[at].kind === 'number'; at--) n++;
      out.push(`${n}. ${block.text}`);
    } else if (block.kind === 'code') out.push('```', block.text, '```');
    else out.push(block.text);
  });
  return `${out.join('\n').trimEnd()}\n`;
}

/** Which of `after`'s blocks are not in `before`, by position-independent match. */
export function changedBlocks(before: DocumentBlock[], after: DocumentBlock[]) {
  const pool = new Map<string, number>();
  for (const block of before) {
    const key = JSON.stringify(block);
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  return after.map((block) => {
    const key = JSON.stringify(block);
    const left = pool.get(key) ?? 0;
    if (left) {
      pool.set(key, left - 1);
      return false;
    }
    return true;
  });
}

/** "today", "yesterday", "3 days ago", "Monday", "12 October": when an artifact last changed. */
export function changedWhen(value: string | null | undefined, now = new Date()) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const day = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 3) return `${days} days ago`;
  if (days <= 6) return date.toLocaleDateString('en-GB', { weekday: 'long' });
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}
