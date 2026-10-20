import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { materializeImages, readWorkspaceMedia, rewriteMedia, sniffImage } from './media-files.ts';
export async function agentMediaCall(endpoint: string, token: string, name: string, args: any) {
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-deploy-agent-token': token },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Attachment HTTP ${response.status}`);
  return result;
}
export async function prepareAgentImages(ids: string[], endpoint: string, token: string) {
  const images = [];
  for (const id of ids || [])
    images.push(await agentMediaCall(endpoint, token, 'deploy_attachment_read', { id }));
  return materializeImages(images);
}
export function environmentImages() {
  return (JSON.parse(process.env.DEPLOY_IMAGE_PATHS || '[]') as string[]).map((path) => ({
    data: readFileSync(path).toString('base64'),
    mimeType: (
      { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<
        string,
        string
      >
    )[path.split('.').at(-1)!],
  }));
}
export async function attachFinalMedia(
  content: string,
  task: { id: string; workspacePath: string; remoteWorkspacePath?: string },
  endpoint: string,
  token: string,
) {
  return rewriteMedia(content, task, async (path, caption) => {
    const data = readWorkspaceMedia(task.workspacePath, path);
    if (!sniffImage(data)) throw new Error('Unsupported image format');
    return agentMediaCall(endpoint, token, 'deploy_attach', {
      name: basename(path),
      caption,
      data: data.toString('base64'),
      kind: 'image',
      operationId:
        'final-media:' +
        createHash('sha256')
          .update(JSON.stringify([path, caption]))
          .update(data)
          .digest('hex'),
    });
  });
}
