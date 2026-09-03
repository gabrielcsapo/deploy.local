import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { pack, type Headers } from 'tar-stream';
import { inspectUploadArchive, UploadArchiveError } from './upload-archive.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function tarGzip(
  entries: Array<{ header: Headers; body?: string | Buffer }>,
): Promise<Buffer> {
  const archive = pack();
  for (const entry of entries) {
    archive.entry(entry.header, entry.body === undefined ? Buffer.alloc(0) : entry.body);
  }
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

async function archiveFile(entries: Array<{ header: Headers; body?: string | Buffer }>) {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-upload-archive-'));
  directories.push(directory);
  const path = join(directory, 'source.tar.gz');
  writeFileSync(path, await tarGzip(entries));
  return path;
}

describe('deployment upload archive inspection', () => {
  it('accepts an archive produced by the platform tar command used by the CLI', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-upload-archive-'));
    directories.push(directory);
    writeFileSync(join(directory, 'package.json'), '{"name":"platform-tar"}');
    const path = join(directory, 'source.tar.gz');
    const result = spawnSync('tar', ['-czf', path, '-C', directory, 'package.json'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const inspection = await inspectUploadArchive(path);
    // macOS bsdtar may add a safe AppleDouble metadata entry for the file.
    assert.ok(inspection.entries >= 1);
    assert.ok(inspection.expandedBytes >= Buffer.byteLength('{"name":"platform-tar"}'));
  });

  it('accepts ordinary files plus links that remain inside the deployment root', async () => {
    const path = await archiveFile([
      { header: { name: 'package.json' }, body: '{"name":"safe"}' },
      { header: { name: 'assets', type: 'directory' } },
      { header: { name: 'assets/app.js' }, body: 'console.log("ok")' },
      { header: { name: 'assets/current', type: 'symlink', linkname: '../package.json' } },
      { header: { name: 'package-copy.json', type: 'link', linkname: 'package.json' } },
    ]);

    const result = await inspectUploadArchive(path);
    assert.equal(result.entries, 5);
    assert.equal(result.expandedBytes, Buffer.byteLength('{"name":"safe"}console.log("ok")'));
  });

  it('rejects absolute, drive-qualified, and parent-traversing entry paths', async () => {
    for (const name of ['../outside', '/tmp/outside', 'C:\\outside']) {
      const path = await archiveFile([{ header: { name }, body: 'unsafe' }]);
      await assert.rejects(() => inspectUploadArchive(path), UploadArchiveError);
    }
  });

  it('rejects links that escape the root and hard links without an archived file target', async () => {
    const escapingSymlink = await archiveFile([
      { header: { name: 'nested/link', type: 'symlink', linkname: '../../outside' } },
    ]);
    await assert.rejects(
      () => inspectUploadArchive(escapingSymlink),
      /link target.*escapes the deployment root/i,
    );

    const missingHardLink = await archiveFile([
      { header: { name: 'copy', type: 'link', linkname: 'missing' } },
    ]);
    await assert.rejects(
      () => inspectUploadArchive(missingHardLink),
      /does not target a regular archived file/,
    );
  });

  it('rejects devices, FIFOs, and duplicate archive paths', async () => {
    for (const type of ['character-device', 'block-device', 'fifo'] as const) {
      const path = await archiveFile([{ header: { name: `special-${type}`, type } }]);
      await assert.rejects(() => inspectUploadArchive(path), /unsupported type/);
    }

    const duplicate = await archiveFile([
      { header: { name: 'same' }, body: 'one' },
      { header: { name: 'same' }, body: 'two' },
    ]);
    await assert.rejects(() => inspectUploadArchive(duplicate), /duplicate path/);
  });

  it('enforces entry-count and expanded-byte limits while streaming', async () => {
    const path = await archiveFile([
      { header: { name: 'one' }, body: '1234' },
      { header: { name: 'two' }, body: '5678' },
    ]);

    await assert.rejects(
      () => inspectUploadArchive(path, { entries: 1 }),
      (error: unknown) => {
        assert.equal((error as UploadArchiveError).status, 413);
        return /exceeds 1 entries/.test((error as Error).message);
      },
    );
    await assert.rejects(
      () => inspectUploadArchive(path, { expandedBytes: 7 }),
      (error: unknown) => {
        assert.equal((error as UploadArchiveError).status, 413);
        return /expands beyond 7 bytes/.test((error as Error).message);
      },
    );
  });

  it('rejects malformed and truncated gzip/tar input', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-upload-archive-'));
    directories.push(directory);
    const path = join(directory, 'broken.tar.gz');
    writeFileSync(path, gzipSync('not a tar archive'));

    await assert.rejects(
      () => inspectUploadArchive(path),
      /Invalid gzip-compressed deployment archive/,
    );
  });
});
