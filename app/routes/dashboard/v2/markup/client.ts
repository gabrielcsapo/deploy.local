import type { Attachment } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
export type ComposerMessage = { text: string; attachments: Attachment[]; model?: string | null };
export async function mediaRequest(path: string, method = 'GET', body?: unknown) {
  const response = await authenticatedFetch(`/api${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The request failed. Try again.');
  return value;
}
export async function uploadFile(file: Blob, name: string) {
  if (file.size > 10 * 1024 * 1024) throw new Error('File exceeds the 10 MiB limit');
  const response = await authenticatedFetch('/api/conversation-attachments', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'text/plain', 'X-File-Name': encodeURIComponent(name) },
    body: file,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Upload failed. Try again.');
  return value.attachment as Attachment;
}
export async function submitMessage(message: ComposerMessage, taskId?: string, agentId?: string) {
  return mediaRequest(
    agentId ? `/composer/agents/${encodeURIComponent(agentId)}/messages` : '/composer/messages',
    'POST',
    { ...message, taskId },
  );
}
