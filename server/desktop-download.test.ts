import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import {
  desktopDirectory,
  desktopDownloadFilename,
  isDesktopDownloadPath,
  serveDesktopDownload,
  serveDesktopVersion,
} from './desktop-download.ts';

/** A ServerResponse double that collects the status, headers and streamed body. */
function response() {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, unknown> = {};
  let finish: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      finish();
      callback();
    },
  }) as Writable & Record<string, unknown>;
  res.writeHead = (code: number, values: Record<string, unknown> = {}) => {
    status = code;
    headers = values;
    return res;
  };
  const end = res.end.bind(res);
  res.end = (value?: unknown) => {
    if (typeof value === 'string' || Buffer.isBuffer(value)) chunks.push(Buffer.from(value));
    return end();
  };
  return {
    res: res as any,
    done,
    result: () => ({ status, headers, body: Buffer.concat(chunks) }),
  };
}

function build(directory: string, version: string, buildTime: string, bytes?: Buffer) {
  mkdirSync(directory, { recursive: true });
  const file = desktopDownloadFilename(version, 'darwin', 'arm64');
  const targets = bytes
    ? {
        'darwin-arm64': {
          file,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      }
    : {};
  if (bytes) writeFileSync(join(directory, file), bytes);
  writeFileSync(
    join(directory, 'build-info.json'),
    JSON.stringify({ version, commit: 'abc', buildTime, targets }),
  );
  return file;
}

async function download(directory: string, url: string, method = 'GET') {
  const output = response();
  await serveDesktopDownload(
    { url, method, headers: { host: 'deploy.local' } } as any,
    output.res,
    directory,
  );
  await output.done;
  return output.result();
}

describe('desktop app download', () => {
  it('names the archive after the build and the platform', () => {
    assert.equal(
      desktopDownloadFilename('2.0.0+abc1234.20261030T120000Z', 'darwin', 'arm64'),
      'deploy.local-Desktop-2.0.0-abc1234.20261030T120000Z-mac-arm64.zip',
    );
  });

  it('claims only /desktop and /desktop/version', () => {
    assert.equal(isDesktopDownloadPath('/desktop?os=darwin&arch=arm64'), true);
    assert.equal(isDesktopDownloadPath('/desktop/version'), true);
    assert.equal(isDesktopDownloadPath('/desktop-notes'), false);
    assert.equal(isDesktopDownloadPath('/dashboard'), false);
  });

  it('serves the newer build, so a release shipped without one keeps the last', () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-directory-'));
    const release = join(root, 'release/dist/desktop');
    const data = join(root, 'data/desktop');
    try {
      assert.equal(desktopDirectory([release, data]), release, 'nothing built: the release');
      build(data, 'kept', '2026-10-30T15:00:00Z');
      assert.equal(desktopDirectory([release, data]), data, 'release without one: the kept');
      build(release, 'new', '2026-10-30T16:00:00Z');
      assert.equal(desktopDirectory([release, data]), release, 'newer release build wins');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a clear 404 when this coordinator has no desktop build', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-none-'));
    try {
      const version = response();
      serveDesktopVersion(version.res, directory);
      await version.done;
      assert.equal(version.result().status, 404);
      assert.match(version.result().body.toString(), /isn't published on this coordinator/);
      const file = await download(directory, '/desktop?os=darwin&arch=arm64');
      assert.equal(file.status, 404);
      assert.match(file.body.toString(), /isn't published on this coordinator/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('streams only an archive matching its manifest, as an attachment', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-served-'));
    const bytes = Buffer.from('zipped desktop app');
    try {
      const file = build(directory, '2.0.0+abc', '2026-10-30T16:00:00Z', bytes);

      const version = response();
      serveDesktopVersion(version.res, directory);
      await version.done;
      assert.equal(version.result().status, 200);
      const manifest = JSON.parse(version.result().body.toString());
      assert.equal(manifest.targets['darwin-arm64'].file, file);

      const served = await download(directory, '/desktop?os=darwin&arch=arm64');
      assert.equal(served.status, 200);
      assert.deepEqual(served.body, bytes);
      assert.equal(served.headers['Content-Type'], 'application/zip');
      assert.equal(
        served.headers['Content-Disposition'],
        'attachment; filename="deploy.local-Desktop-2.0.0-abc-mac-arm64.zip"',
      );
      assert.equal(
        served.headers['X-Deploy-Desktop-Sha256'],
        createHash('sha256').update(bytes).digest('hex'),
      );

      const head = await download(directory, '/desktop?os=darwin&arch=arm64', 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);

      assert.equal((await download(directory, '/desktop?os=linux&arch=x64')).status, 404);
      assert.equal((await download(directory, '/desktop?os=darwin')).status, 400);
      assert.equal((await download(directory, '/desktop?os=../x&arch=arm64')).status, 400);
      assert.equal(
        (await download(directory, '/desktop?os=darwin&arch=arm64&version=old')).status,
        409,
      );

      writeFileSync(join(directory, file), 'corrupt archive bytes');
      assert.equal((await download(directory, '/desktop?os=darwin&arch=arm64')).status, 409);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a manifest that points outside its folder', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'desktop-escape-'));
    try {
      writeFileSync(
        join(directory, 'build-info.json'),
        JSON.stringify({
          version: '1',
          buildTime: '2026-10-30T16:00:00Z',
          targets: { 'darwin-arm64': { file: '../secret.zip', size: 1, sha256: 'a' } },
        }),
      );
      assert.equal((await download(directory, '/desktop?os=darwin&arch=arm64')).status, 409);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
