import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readFile, realpath, rename, rm } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gitText, repositoryGit } from '../../workspace/repository-git.ts';

export function lfsPointer(bytes: Buffer) {
  if (bytes.length > 1024) return null;
  const text = bytes.toString();
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1\n')) return null;
  const oid = /^oid sha256:([a-f0-9]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  if (!oid || !size || !Number.isSafeInteger(Number(size)))
    throw new Error('Invalid Git LFS pointer');
  if (/^ext-/m.test(text)) throw new Error('Git LFS pointer extensions are unsupported');
  return { oid, size: Number(size) };
}
export async function hydrateLfs(
  cwd: string,
  source: string,
  options: Parameters<typeof repositoryGit>[2] = {},
) {
  options = {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout || 600000)])
      : AbortSignal.timeout(options.timeout || 600000),
  };
  const files = (await repositoryGit(cwd, ['ls-files', '-z'], options))
    .toString()
    .split('\0')
    .filter(Boolean);
  const root = await realpath(cwd);
  let configured = false;
  for (const name of files) {
    const path = resolve(cwd, name);
    const info = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile() || info.size > 1024) continue;
    const parent = await realpath(dirname(path));
    if (parent !== root && !parent.startsWith(root + sep))
      throw new Error('Invalid LFS checkout path');
    const pointer = lfsPointer(await readFile(path));
    if (!pointer) continue;
    if (!configured) {
      await gitText(cwd, ['lfs', 'version'], options).catch(() => {
        throw new Error('This repository uses Git LFS; install git-lfs on this execution computer');
      });
      // Required filters preserve pointers in future agent commits without installing hooks.
      for (const [key, value] of Object.entries({
        clean: 'git-lfs clean -- %f',
        smudge: 'git-lfs smudge -- %f',
        process: 'git-lfs filter-process',
        required: 'true',
      }))
        await gitText(cwd, ['config', `filter.lfs.${key}`, value], options);
      configured = true;
    }
    const temporary = path + '.' + randomUUID() + '.lfs-download';
    let input: Readable;
    if (source.startsWith('http:') || source.startsWith('https:')) {
      const url = new URL(source + '/info/lfs/objects/' + pointer.oid);
      const auth = options.authentication;
      if (!auth || url.origin !== auth.origin)
        throw new Error('LFS source is outside the assigned coordinator');
      const colon = auth.header.indexOf(':');
      const response = await fetch(url, {
        headers: { [auth.header.slice(0, colon)]: auth.header.slice(colon + 1).trim() },
        redirect: 'error',
        signal: options.signal || AbortSignal.timeout(options.timeout || 600000),
      });
      if (!response.ok || !response.body)
        throw new Error(`Assigned LFS object unavailable (${response.status})`);
      input = Readable.fromWeb(response.body as any);
    } else
      input = createReadStream(
        resolve(
          source,
          'lfs',
          'objects',
          pointer.oid.slice(0, 2),
          pointer.oid.slice(2, 4),
          pointer.oid,
        ),
      );
    let size = 0;
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > pointer.size) return done(new Error('LFS object exceeds its declared size'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        input,
        meter,
        createWriteStream(temporary, { flags: 'wx', mode: info.mode & 0o777 }),
        { signal: options.signal },
      );
      if (size !== pointer.size || hash.digest('hex') !== pointer.oid)
        throw new Error('LFS object failed content verification');
      await rename(temporary, path);
      // Refresh only stat information; never stage a user's changes during resume.
      await gitText(cwd, ['update-index', '--refresh', '--', name], options).catch(() => {});
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
