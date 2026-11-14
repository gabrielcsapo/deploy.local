import {
  convertStoredAttachmentText,
  convertStoredAttachments,
  hasStoredAttachmentLinks,
} from '../../shared/stored-attachment-urls.ts';

function origins() {
  const list = ['https://deploy.local'];
  if (process.env.DEPLOY_COORDINATOR_URL)
    list.push(new URL(process.env.DEPLOY_COORDINATOR_URL).origin);
  return list;
}
/** Stored JSON text: a substring check, and a rewrite only for text that holds an old link. */
export function readStoredText(text: string): string {
  return hasStoredAttachmentLinks(text) ? convertStoredAttachmentText(text, origins()) : text;
}
/** A value assembled outside the store. Serializing is far cheaper than walking it. */
export function readStoredUrls<T>(value: T): T {
  if (typeof value === 'string') return readStoredText(value) as T;
  const text = JSON.stringify(value);
  return text !== undefined && hasStoredAttachmentLinks(text)
    ? convertStoredAttachments(value, origins())
    : value;
}
