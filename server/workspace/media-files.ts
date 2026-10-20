import {
  constants,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { taskFileReference } from '../../app/routes/dashboard/task-file-link.ts';
export const imageLimit = 20 * 1024 * 1024;
export function sniffImage(
  data: Buffer,
): { mimeType: string; width?: number; height?: number } | null {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    data.toString('ascii', 12, 16) === 'IHDR'
  )
    return { mimeType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6)))
    return { mimeType: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const type = data.toString('ascii', 12, 16);
    if (type === 'VP8X' && data.length >= 30)
      return {
        mimeType: 'image/webp',
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    if (type === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return {
        mimeType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (
      type === 'VP8 ' &&
      data.length >= 30 &&
      data.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))
    )
      return {
        mimeType: 'image/webp',
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= data.length) {
      if (data[at++] !== 0xff) break;
      while (data[at] === 0xff) at++;
      if (at + 3 > data.length) break;
      const marker = data[at++];
      if (marker === 0xda || marker === 0xd9) break;
      const size = data.readUInt16BE(at);
      if (size < 2 || at + size > data.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        size >= 7
      )
        return {
          mimeType: 'image/jpeg',
          width: data.readUInt16BE(at + 5),
          height: data.readUInt16BE(at + 3),
        };
      at += size;
    }
  }
  return null;
}
/** Reject traversal and every symlink component; bound reads even if a file grows. */
export function readWorkspaceMedia(workspace: string, path: string) {
  const root = realpathSync(workspace);
  if (path.split(/[\\/]/).includes('..')) throw new Error('Attachment path traversal refused');
  const target = resolve(root, path);
  if (
    !target.startsWith(root + sep) ||
    target
      .slice(root.length + 1)
      .split(sep)
      .includes('.git')
  )
    throw new Error('Attachment must be inside the task workspace');
  let current = root;
  for (const part of target.slice(root.length + 1).split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Attachment symlinks refused');
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Attachment is not a file');
    if (stat.size > imageLimit) throw new Error('Attachment exceeds 20 MB');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, imageLimit + 1));
    let length = 0,
      n = 0;
    do {
      n = readSync(fd, buffer, length, buffer.length - length, null);
      length += n;
    } while (n && length < buffer.length);
    if (length > imageLimit || length > stat.size)
      throw new Error('Attachment grew while reading; retry');
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
export async function rewriteMedia(
  content: string,
  task: { id: string; workspacePath: string; remoteWorkspacePath?: string },
  upload: (path: string, caption: string) => Promise<{ id: string }>,
) {
  const pattern = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g;
  let rewritten = '',
    end = 0;
  const attachmentIds: string[] = [],
    errors: string[] = [];
  for (const match of content.matchAll(pattern)) {
    rewritten += content.slice(end, match.index);
    const reference = taskFileReference(match[2] || match[3], task);
    if (!reference) rewritten += match[0];
    else
      try {
        const attachment = await upload(reference.path, match[1]);
        attachmentIds.push(attachment.id);
        rewritten += `![${match[1]}](/api/workspace/attachments/${attachment.id})`;
      } catch (error: any) {
        errors.push(error.message);
        rewritten += `${match[1] || 'Image'}: Image unavailable (${error.message})`;
      }
    end = match.index! + match[0].length;
  }
  return { content: rewritten + content.slice(end), attachmentIds, errors };
}
export function materializeImages(images: { id: string; data: string; mimeType: string }[]) {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-images-'));
  const paths = images.map((image, index) => {
    const extension = (
      {
        'image/png': 'png',
        'image/jpeg': 'jpeg',
        'image/gif': 'gif',
        'image/webp': 'webp',
      } as Record<string, string>
    )[image.mimeType];
    if (!extension) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error('Unsupported image input');
    }
    const bytes = Buffer.from(image.data, 'base64');
    if (!sniffImage(bytes) || bytes.length > imageLimit) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error('Invalid image input');
    }
    const path = join(directory, `${index}.${extension}`);
    try {
      writeFileSync(path, bytes, { mode: 0o600 });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return path;
  });
  return { paths, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
export function claudeImageMessage(prompt: string, images: { data: string; mimeType: string }[]) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((image) => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType, data: image.data },
        })),
        { type: 'text', text: prompt },
      ],
    },
  };
}
