import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export function updateAvailable(current, published) {
  return !!(
    typeof current?.commit === 'string' &&
    current.commit &&
    typeof published?.commit === 'string' &&
    published.commit &&
    current.commit !== 'unknown' &&
    published.commit !== 'unknown' &&
    current.commit !== published.commit &&
    Date.parse(published.buildTime) > Date.parse(current.buildTime)
  );
}
export function updateTarget(manifest, arch) {
  const target = manifest?.targets?.[`darwin-${arch}`];
  if (
    !target ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    typeof manifest.commit !== 'string' ||
    !manifest.commit ||
    !Number.isFinite(Date.parse(manifest.buildTime)) ||
    typeof target.file !== 'string' ||
    basename(target.file) !== target.file ||
    !target.file.endsWith('.zip') ||
    !Number.isSafeInteger(target.size) ||
    target.size <= 0 ||
    !/^[a-f0-9]{64}$/i.test(target.sha256)
  )
    throw new Error('Invalid desktop manifest.');
  return target;
}
export function downloadProgress(bytes, total) {
  return {
    bytes,
    total,
    percent: total > 0 ? Math.min(100, Math.max(0, Math.round((bytes / total) * 100))) : 0,
  };
}
export async function verifyDownload(path, target) {
  if ((await stat(path)).size !== target.size) throw new Error('Download size mismatch.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== target.sha256.toLowerCase())
    throw new Error('Download SHA-256 mismatch.');
}
export async function stageDownload(archive, directory) {
  const stage = join(directory, 'stage');
  await mkdir(stage);
  await run('/usr/bin/ditto', ['-x', '-k', archive, stage]);
  const apps = (await readdir(stage, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
  );
  if (apps.length !== 1) throw new Error('Expected one application bundle.');
  const bundle = join(stage, apps[0].name);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  return bundle;
}

export class DesktopUpdater {
  constructor({
    build,
    client,
    directory,
    arch = process.arch,
    onChange = () => {},
    stage = stageDownload,
    install,
    log = console.error,
  }) {
    Object.assign(this, { build, client, directory, arch, onChange, stage, install, log });
    this.state = { phase: 'idle' };
  }
  status() {
    return this.state;
  }
  change(phase, fields = {}) {
    this.state = { ...this.state, ...fields, phase };
    if (this.disposed) return this.state;
    this.onChange(this.state);
    return this.state;
  }
  async check() {
    if (
      this.disposed ||
      this.checking ||
      this.operation ||
      ['ready', 'installing', 'failed'].includes(this.state.phase)
    )
      return;
    const client = this.client();
    if (!client) return;
    this.checking = true;
    try {
      const manifest = await client.request('/desktop/version');
      if (this.disposed || client !== this.client() || this.operation) return;
      updateTarget(manifest, this.arch);
      if (updateAvailable(this.build, manifest)) {
        this.manifest = manifest;
        this.change('available', { version: manifest.version, commit: manifest.commit });
      } else {
        this.manifest = null;
        this.state = { phase: 'idle' };
        this.onChange(this.state);
      }
    } catch (error) {
      // A failed check preserves the last known status; it never asserts the app is current.
      this.log('[desktop update] Check failed:', error.message);
    } finally {
      this.checking = false;
    }
  }
  start() {
    if (this.disposed || this.operation || !['available', 'failed'].includes(this.state.phase))
      return this.operation;
    const controller = new AbortController();
    this.controller = controller;
    const retry = this.state.phase === 'failed';
    this.change('downloading', {
      ...downloadProgress(0, this.manifest.targets[`darwin-${this.arch}`].size),
      error: undefined,
    });
    this.operation = this.download(controller, retry).finally(() => {
      this.operation = null;
      this.controller = null;
    });
    return this.operation;
  }
  async download(controller, retry) {
    let directory;
    const client = this.client();
    try {
      if (retry) {
        const manifest = await client.request('/desktop/version');
        controller.signal.throwIfAborted();
        const target = updateTarget(manifest, this.arch);
        if (!updateAvailable(this.build, manifest)) {
          this.change('idle');
          return;
        }
        this.manifest = manifest;
        this.change('downloading', {
          version: manifest.version,
          commit: manifest.commit,
          ...downloadProgress(0, target.size),
        });
      }
      await mkdir(this.directory, { recursive: true });
      directory = await mkdtemp(join(this.directory, 'download-'));
      const target = updateTarget(this.manifest, this.arch);
      const archive = join(directory, target.file);
      await client.download(
        `/desktop?os=darwin&arch=${encodeURIComponent(this.arch)}&version=${encodeURIComponent(this.manifest.version)}`,
        archive,
        {
          signal: controller.signal,
          size: target.size,
          onProgress: (bytes) => this.change('downloading', downloadProgress(bytes, target.size)),
        },
      );
      controller.signal.throwIfAborted();
      this.change('checking');
      await verifyDownload(archive, target);
      this.staged = await this.stage(archive, directory);
      controller.signal.throwIfAborted();
      this.stagingDirectory = directory;
      this.change('ready');
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      if (controller.signal.aborted) this.change('available', { bytes: 0, percent: 0 });
      else {
        this.log('[desktop update] Download failed:', error.message);
        this.change('failed', {
          error:
            this.state.phase === 'checking' || error.code === 'SIZE_MISMATCH'
              ? 'verification'
              : 'network',
        });
      }
    }
  }
  async cancel() {
    if (this.state.phase !== 'downloading') return;
    this.controller?.abort();
    await this.operation;
  }
  async restart(page) {
    if (this.state.phase !== 'ready' || this.operation) return;
    this.change('installing');
    try {
      await this.install(this.staged, page, this.manifest);
    } catch (error) {
      this.log('[desktop update] Install handoff failed:', error.message);
      // The verified download remains ready if the installed location is not writable.
      this.change('ready');
    }
  }
  async dispose() {
    this.disposed = true;
    this.controller?.abort();
    await this.operation;
    if (this.stagingDirectory) await rm(this.stagingDirectory, { recursive: true, force: true });
  }
}
