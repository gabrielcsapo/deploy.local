import { editorial } from './editorial.ts';

export interface ChangelogItem {
  tag: 'New' | 'Fixed';
  text: string;
  reference?: { label: string; url: string };
}
export interface ChangelogRelease {
  version: string;
  url?: string;
  date: string;
  items: ChangelogItem[];
}

const safeLink = (url: string) => (/^https?:\/\//i.test(url) ? url : undefined);
export function plainLanguage(text: string): string {
  if (editorial[text.trim()]) return editorial[text.trim()];
  const body = text
    .replace(/^\*\*[^*]+:\*\*\s*/, '')
    .replace(/^(?:feat|fix|perf|refactor|docs|chore)(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\bdeployments\b/gi, 'releases')
    .replace(/\bdeployment\b/gi, 'release')
    .replace(/\bnodes\b/gi, 'computers')
    .replace(/\bnode\b/gi, 'computer')
    .replace(/\bworkspace\b/gi, 'project')
    .replace(/;$/, '')
    .trim();
  return body ? body[0].toUpperCase() + body.slice(1) + (/[.!?]$/.test(body) ? '' : '.') : '';
}

// Vite supplies CHANGELOG.md as raw text at build time. Keep source order for undated
// integration releases; dated releases are sorted newest first within their slots.
export function parseChangelog(raw: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | undefined;
  let tag: ChangelogItem['tag'] | undefined = 'New';
  let pending: string | undefined;
  const flush = () => {
    if (pending && release && tag) {
      const ref = pending.match(/\s*\(\[([^\]]+)\]\(([^)]+)\)\)\s*$/);
      const url = ref && safeLink(ref[2]);
      release.items.push({
        tag,
        text: plainLanguage(ref ? pending.slice(0, ref.index) : pending),
        ...(ref && url
          ? {
              reference: {
                label: /^#\d+$/.test(ref[1]) ? `PR ${ref[1]}` : ref[1].slice(0, 7),
                url,
              },
            }
          : {}),
      });
    }
    pending = undefined;
  };
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(?:\[([^\]]+)\]\(([^)]+)\)|([^\s]+))(?:\s+\(([^)]+)\))?\s*$/);
    if (heading) {
      flush();
      release = {
        version: (heading[1] || heading[3]).replace(/^v(?=\d)/, ''),
        date: heading[4] || '',
        items: [],
        ...(heading[2] && safeLink(heading[2]) ? { url: heading[2] } : {}),
      };
      releases.push(release);
      tag = 'New';
      continue;
    }
    const section = line.match(/^###\s+(.+)$/);
    if (section) {
      flush();
      tag = /^(features?|new|added|feat)$/i.test(section[1])
        ? 'New'
        : /^(bug fixes|fix(es|ed)?|performance improvements|perf|security|reverts?)$/i.test(
              section[1],
            )
          ? 'Fixed'
          : undefined;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      flush();
      pending = line.slice(2);
    } else if (/^\s+\S/.test(line) && pending) pending += ` ${line.trim()}`;
    else if (!line.trim()) flush();
  }
  flush();
  const visible = releases.filter((entry) => entry.items.length);
  const dated = visible
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  return visible.map((entry) => (/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? dated.shift()! : entry));
}
