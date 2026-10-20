import { basename } from 'node:path';
import { readFileSync, createReadStream, closeSync, fstatSync } from 'node:fs';
import { openWorkspaceMedia } from './media-files.ts';
import { videoLimit } from './video-files.ts';
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
  for (const id of ids || []) {
    const input = await agentMediaCall(endpoint, token, 'deploy_attachment_read', { id });
    if (input.kind !== 'video') images.push(input);
  }
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

/** Upload the actual worker file over raw HTTP; never serialize media into JSON. */
export async function streamWorkspaceAttachment(
  workspace: string,
  path: string,
  caption: string,
  endpoint: string,
  token: string,
) {
  const { fd, stat } = openWorkspaceMedia(workspace, path);
  try {
    if (!stat.size || stat.size > Math.max(videoLimit(), 20 * 1024 * 1024))
      throw new Error('Attachment exceeds media limit (default video 200 MB)');
    const hash = createHash('sha256').update(JSON.stringify([path, caption]));
    for await (const chunk of createReadStream('', {
      fd,
      autoClose: false,
      start: 0,
      end: stat.size - 1,
    }))
      hash.update(chunk);
    const current = fstatSync(fd);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)
      throw new Error('Attachment changed while reading; finalize the file and retry');
    const url = new URL(endpoint);
    url.pathname = '/api/workspace/agent/attachments';
    url.search = new URLSearchParams({
      name: basename(path),
      caption,
      operationId: 'attach:' + hash.digest('hex'),
    }).toString();
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/octet-stream', 'x-deploy-agent-token': token },
      body: createReadStream('', { fd, autoClose: false, start: 0, end: stat.size - 1 }),
      duplex: 'half',
      signal: AbortSignal.timeout(600000),
    } as unknown as RequestInit);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Attachment HTTP ${response.status}`);
    return result;
  } finally {
    closeSync(fd);
  }
}
