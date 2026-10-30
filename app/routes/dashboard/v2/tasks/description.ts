import type { PullFile } from './types';

// Pure helpers for a pull request's description: which URLs survive, the Markdown a dropped
// file inserts, and how its size reads.
export const ownFile = /^\/api\/v2\/pulls\/[^/]+\/files\/[a-f0-9-]+$/;
/** Only this coordinator's own files and plain web links survive; nothing else is a URL. */
export function safeUrl(url: string) {
  if (ownFile.test(url)) return url;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}
export function fileMarkdown(file: Pick<PullFile, 'kind' | 'name' | 'url'>) {
  const name = file.name.replace(/[[\]]/g, '');
  return file.kind === 'image' ? `![${name}](${file.url})` : `[${name}](${file.url})`;
}
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
