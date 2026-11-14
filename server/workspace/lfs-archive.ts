import { extract, pack } from 'tar-stream';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { lfsPointer } from './lfs-checkout.ts';

export async function expandLfsArchive(archive: Buffer, repositoryPath: string, limit: number) {
  const input = extract(),
    output = pack();
  let expanded = false,
    total = 0;
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((done, fail) => {
    output.on('data', (chunk) => chunks.push(chunk as Buffer));
    output.on('end', () => done(expanded ? Buffer.concat(chunks) : archive));
    output.on('error', fail);
    input.on('error', fail);
    input.on('finish', () => output.finalize());
    input.on('entry', (header, stream, next) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const chunk of stream) parts.push(chunk as Buffer);
        let bytes = Buffer.concat(parts);
        const pointer = header.type === 'file' ? lfsPointer(bytes) : null;
        if (pointer) {
          if (total + pointer.size > limit)
            throw new Error('Expanded LFS source exceeds publication size limit');
          const path = resolve(
            repositoryPath,
            'lfs',
            'objects',
            pointer.oid.slice(0, 2),
            pointer.oid.slice(2, 4),
            pointer.oid,
          );
          const info = await stat(path).catch(() => null);
          if (!info?.isFile() || info.size !== pointer.size)
            throw new Error('Publication requires the pinned Git LFS object');
          bytes = await readFile(path);
          if (createHash('sha256').update(bytes).digest('hex') !== pointer.oid)
            throw new Error('Git LFS publication object failed verification');
          expanded = true;
        }
        total += bytes.length;
        if (total > limit) throw new Error('Expanded source exceeds publication size limit');
        output.entry({ ...header, size: bytes.length }, bytes, next);
      })().catch((error) => {
        input.destroy(error);
        output.destroy(error);
      });
    });
  });
  input.end(archive);
  return result;
}
