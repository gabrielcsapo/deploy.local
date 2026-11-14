/** Read-time conversion of stored attachment strings only; never an HTTP alias. */
const legacyAttachmentPaths = new Map([
  ['/api/v2/attachments/', '/api/conversation-attachments/'],
  ['/api/workspace/attachments/', '/api/attachments/'],
]);
const storedLink =
  /(?:https?:\/\/[^\s<>"'`()]+)?\/api\/(?:v2|workspace)\/attachments\/[A-Za-z0-9-]+/g;

export function convertStoredAttachmentText(
  text: string,
  origins: readonly string[] = ['https://deploy.local'],
): string {
  return text.replace(storedLink, (link, offset: number) => {
    // A foreign absolute URL, protocol-relative URL or a suffix of another path is not ours.
    const absolute = /^https?:\/\//.test(link);
    if (!absolute && offset && /[\w/.:%-]/.test(text[offset - 1])) return link;
    if (absolute && !origins.includes(new URL(link).origin)) return link;
    for (const [oldPath, newPath] of legacyAttachmentPaths) {
      if (absolute) {
        const url = new URL(link);
        if (url.pathname.startsWith(oldPath)) return link.replace(oldPath, newPath);
      } else if (link.startsWith(oldPath)) return newPath + link.slice(oldPath.length);
    }
    return link;
  });
}

export function convertStoredAttachments<T>(value: T, origins?: readonly string[]): T {
  if (typeof value === 'string') return convertStoredAttachmentText(value, origins) as T;
  if (Array.isArray(value))
    return value.map((item) => convertStoredAttachments(item, origins)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, convertStoredAttachments(item, origins)]),
    ) as T;
  return value;
}
