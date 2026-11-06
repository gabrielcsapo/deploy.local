import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { stat, mkdir, mkdtemp, rename, rm, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import {
  db,
  fail,
  now,
  objectPath,
  storeFile,
  MAX_UPSTREAM_DOC,
  MAX_FILE,
  fileOf,
  nameOf,
  tempRoot,
  limiter,
  recentlyUsed,
  cleanTemporaryFiles,
} from './store.ts';

// These settings come from server construction, never from requests or persisted settings.
export type RegistrySettings = {
  upstreamBase: string;
  publicBase: string;
  revalidateMs?: number;
  headerTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  bodyTotalTimeoutMs?: number;
};
export const productionSettings: RegistrySettings = {
  upstreamBase: 'https://registry.npmjs.org/',
  publicBase: 'https://deploy.local/npm/',
};
export type CacheEntry = {
  key: string;
  sha256: string;
  size: number;
  abbreviated_sha256: string;
  abbreviated_size: number;
  index_sha256: string;
  index_size: number;
  etag: string | null;
  fetched_at: string;
  last_used_at: string;
  removed_at: string | null;
};
type File = { sha256: string; size: number };
type Prepared = { files: { full: File; abbreviated: File; index: File }; versions: string[] };
export type VersionIndex = Record<
  string,
  { tarball: string; integrity: string; os?: string[]; cpu?: string[] }
>;
export const entry = (kind: string, key: string) =>
  db()
    .prepare("SELECT * FROM package_cache_entries WHERE ecosystem='npm' AND kind=? AND key=?")
    .get(kind, key) as CacheEntry | undefined;
// Serialize promotion and collection across registry instances: a shared index must
// never be collected between another writer's promotion and row update.
let writing: Promise<unknown> = Promise.resolve();
export function writeCopy<T>(work: () => Promise<T>): Promise<T> {
  const result = writing.then(work);
  writing = result.catch(() => {});
  return result;
}
// A first install asks for hundreds of documents at once, and each large one takes a worker
// a lot of memory to prepare. Serving what's prepared never waits on this.
const PREPARING_AT_ONCE = 4;
let preparing = 0;
const waitingToPrepare: (() => void)[] = [];
async function preparationSlot<T>(work: () => Promise<T>): Promise<T> {
  if (preparing >= PREPARING_AT_ONCE) await new Promise<void>((go) => waitingToPrepare.push(go));
  else preparing++;
  try {
    return await work();
  } finally {
    const next = waitingToPrepare.shift();
    if (next) next();
    else preparing--;
  }
}
export class NpmCopy {
  readonly settings: RegistrySettings;
  readonly startupCleanup: Promise<void>;
  reachable = true;
  failures = 0;
  downSince: string | null = null;
  copiesServed = 0;
  get activeRequests() {
    return this.pending.size;
  }
  checkedAt: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private checkingAlways = false;
  private pending = new Map<string, Promise<any>>();
  constructor(settings: RegistrySettings = productionSettings) {
    const base = new URL(settings.upstreamBase);
    if (
      base.origin !== 'https://registry.npmjs.org' &&
      !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
    )
      throw new Error('Upstream must be npmjs.org or a loopback test server');
    this.settings = { ...settings, upstreamBase: base.origin + '/' };
    this.startupCleanup = cleanTemporaryFiles().catch(() => {
      console.error('Package temporary file cleanup failed');
    });
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.checkingAlways = false;
  }
  startChecks() {
    this.close();
    this.checkingAlways = true;
    const check = () =>
      void this.fetch('-/ping')
        .then((response) => response.body?.cancel())
        .catch(() => {});
    check();
    this.timer = setInterval(check, 60000);
    this.timer.unref();
  }
  private state(reachable: boolean) {
    if (reachable) {
      this.failures = 0;
      this.downSince = null;
    } else this.failures++;
    this.reachable = reachable || this.failures < 2;
    if (!this.reachable) this.downSince ||= now();
    this.checkedAt = now();
    if (reachable && !this.checkingAlways) {
      this.close();
      this.timer = undefined;
    } else if (!this.timer) {
      this.timer = setInterval(() => {
        void this.fetch('-/ping')
          .then((r) => r.body?.cancel())
          .catch(() => {});
      }, 60000);
      this.timer.unref();
    }
  }
  async fetch(path: string, options: RequestInit = {}) {
    const url = new URL(path, this.settings.upstreamBase);
    if (url.origin !== new URL(this.settings.upstreamBase).origin || url.username || url.password)
      fail('Invalid upstream host', 422);
    // This controller belongs to the shared fetch, never to an individual client.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.headerTimeoutMs ?? 5000);
    try {
      const response = await fetch(url, {
        ...options,
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status >= 500 || response.status === 429) {
        await response.body?.cancel();
        throw new Error('source unavailable');
      }
      // A package-level 404 still proves that the registry is reachable.
      this.state(true);
      return response;
    } catch (error: any) {
      console.warn(
        `[packages] npmjs.org request failed: ${url.pathname} ${error?.cause?.code || error?.message}`,
      );
      this.state(false);
      fail('npmjs.org is unreachable and this package has not been kept.', 503);
    } finally {
      clearTimeout(timer);
    }
  }
  body(response: Response): Readable {
    const source = Readable.fromWeb(response.body as any);
    let failed = false;
    const unavailable = () => {
      if (!failed) this.state(false);
      failed = true;
      return Object.assign(new Error('npmjs.org package download failed.'), { status: 503 });
    };
    let idle: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => source.destroy(unavailable()),
        this.settings.bodyIdleTimeoutMs ?? 60000,
      );
    };
    const total = setTimeout(
      () => source.destroy(unavailable()),
      this.settings.bodyTotalTimeoutMs ?? 600000,
    );
    reset();
    const watched = new Transform({
      transform(chunk, _encoding, callback) {
        reset();
        callback(null, chunk);
      },
    });
    // pipeline propagates failures and cancellation in both directions, with no
    // unhandled rejection when a consumer rejects (size or integrity limits).
    void pipeline(source, watched).catch(() => {});
    source.prependOnceListener('error', () => watched.destroy(unavailable()));
    watched.once('close', () => {
      clearTimeout(idle);
      clearTimeout(total);
    });
    return watched;
  }
  private async single<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.pending.has(key)) return this.pending.get(key)!;
    const promise = work().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  private touch(kind: string, row: CacheEntry) {
    if (!recentlyUsed(row.last_used_at))
      db()
        .prepare(
          "UPDATE package_cache_entries SET last_used_at=? WHERE ecosystem='npm' AND kind=? AND key=?",
        )
        .run(now(), kind, row.key);
    return row;
  }
  async index(row: CacheEntry, version?: string): Promise<VersionIndex> {
    return writeCopy(async () => {
      const current = entry('doc', row.key);
      if (!current || current.removed_at) return {};
      const bundled = new URL('./package-index-worker.mjs', import.meta.url);
      const worker = new Worker(
        existsSync(bundled) ? bundled : new URL('./index-worker.mjs', import.meta.url),
        {
          workerData: { path: objectPath('docs', current.index_sha256), version },
        },
      );
      return new Promise<VersionIndex>((resolve, reject) => {
        worker.once('message', (result) =>
          result.error ? reject(new Error(result.error)) : resolve(result.index),
        );
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code) reject(new Error('Package index reader failed'));
        });
      });
    });
  }
  async openDocument(name: string, abbreviated = false) {
    if (!(await this.document(name))) fail('Package not found', 404);
    // Pin an open file before collection can unlink it. A revalidation may have
    // replaced the row while document() was checking the old files.
    return writeCopy(async () => {
      const current = entry('doc', name);
      if (!current || current.removed_at) fail('Package not found', 404);
      const file = abbreviated
        ? { sha256: current.abbreviated_sha256, size: current.abbreviated_size }
        : { sha256: current.sha256, size: current.size };
      return { ...file, handle: await open(objectPath('docs', file.sha256), 'r') };
    });
  }
  async document(name: string, force = false): Promise<CacheEntry | null> {
    nameOf(name);
    if (name.startsWith('@deploy.local/')) return null;
    return this.single('doc:' + name, async () => {
      let previous = entry('doc', name);
      if (
        previous &&
        !previous.removed_at &&
        !(
          await Promise.all(
            [previous.sha256, previous.abbreviated_sha256, previous.index_sha256].map((hash) =>
              stat(objectPath('docs', hash)).catch(() => null),
            ),
          )
        ).every((file) => file?.isFile())
      ) {
        await writeCopy(async () => {
          db()
            .prepare(
              "DELETE FROM package_cache_entries WHERE ecosystem='npm' AND kind='doc' AND key=?",
            )
            .run(name);
          await this.collect(previous!);
        });
        previous = undefined;
      }
      if (
        previous &&
        !force &&
        Date.now() - Date.parse(previous.fetched_at) < (this.settings.revalidateMs ?? 300000)
      )
        return previous.removed_at ? null : this.touch('doc', previous);
      let response: Response;
      try {
        response = await this.fetch(encodeURIComponent(name), {
          headers: previous?.etag ? { 'If-None-Match': previous.etag } : {},
        });
      } catch (error) {
        if (previous) return previous.removed_at ? null : this.touch('doc', previous);
        throw error;
      }
      if (response.status === 304 && previous) {
        db()
          .prepare(
            "UPDATE package_cache_entries SET fetched_at=? WHERE ecosystem='npm' AND kind='doc' AND key=?",
          )
          .run(now(), name);
        return previous.removed_at ? null : this.touch('doc', previous);
      }
      if (response.status === 404) {
        await response.body?.cancel();
        await writeCopy(async () => {
          db().transaction(() => {
            this.markRemoved(name, []);
            // A tombstone has no files. Retain it so an offline retry cannot
            // resurrect the old document or turn a known removal into a 503.
            this.record('doc', name, { sha256: '0'.repeat(64), size: 0 });
            db()
              .prepare(
                "UPDATE package_cache_entries SET removed_at=?,abbreviated_sha256=NULL,abbreviated_size=NULL,index_sha256=NULL,index_size=NULL WHERE ecosystem='npm' AND kind='doc' AND key=?",
              )
              .run(now(), name);
          })();
          if (previous) await this.collect(previous);
        });
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail('npmjs.org refused the package request', 502);
      }
      await mkdir(tempRoot(), { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(tempRoot(), 'document-'));
      const path = join(directory, 'upstream');
      try {
        try {
          await pipeline(
            this.body(response),
            limiter(MAX_UPSTREAM_DOC),
            createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          );
        } catch (error: any) {
          if (error.status === 413) fail('Upstream packument too large', 502);
          throw error;
        }
        const prepared = await preparationSlot(() => {
          const bundled = new URL('./package-document-worker.mjs', import.meta.url);
          const worker = new Worker(
            existsSync(bundled) ? bundled : new URL('./document-worker.mjs', import.meta.url),
            {
              workerData: {
                path,
                directory,
                name,
                publicBase: this.settings.publicBase,
                upstreamOrigin: new URL(this.settings.upstreamBase).origin,
              },
            },
          );
          return new Promise<Prepared>((resolve, reject) => {
            worker.once('message', (value) =>
              value.error
                ? reject(
                    Object.assign(new Error(value.error), value.invalid ? { status: 502 } : {}),
                  )
                : resolve(value),
            );
            worker.once('error', reject);
            worker.once('exit', (code) => {
              if (code) reject(new Error('Package preparation failed'));
            });
          });
        });
        await writeCopy(async () => {
          try {
            for (const [kind, file] of Object.entries(prepared.files)) {
              const target = objectPath('docs', file.sha256);
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              await rename(join(directory, kind), target);
            }
            const { full, abbreviated, index } = prepared.files;
            db().transaction(() => {
              this.record('doc', name, full, response.headers.get('etag'));
              db()
                .prepare(
                  "UPDATE package_cache_entries SET removed_at=NULL,abbreviated_sha256=?,abbreviated_size=?,index_sha256=?,index_size=? WHERE ecosystem='npm' AND kind='doc' AND key=?",
                )
                .run(abbreviated.sha256, abbreviated.size, index.sha256, index.size, name);
              this.markRemoved(name, prepared.versions);
            })();
          } catch (error) {
            await this.collectHashes(Object.values(prepared.files).map((file) => file.sha256));
            throw error;
          }
          if (previous) await this.collect(previous);
        });
        return entry('doc', name)!;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  private async collect(row: CacheEntry) {
    await this.collectHashes([row.sha256, row.abbreviated_sha256, row.index_sha256]);
  }
  private async collectHashes(hashes: string[]) {
    for (const hash of new Set(hashes)) {
      if (!hash) continue;
      if (
        !db()
          .prepare(
            "SELECT 1 FROM package_cache_entries WHERE kind='doc' AND (sha256=? OR abbreviated_sha256=? OR index_sha256=?)",
          )
          .get(hash, hash, hash)
      )
        await rm(objectPath('docs', hash), { force: true });
    }
  }
  private markRemoved(name: string, versions: string[]) {
    const present = new Set(versions);
    const files = db()
      .prepare(
        "SELECT key FROM package_cache_entries WHERE ecosystem='npm' AND kind='file' AND key LIKE ? ESCAPE '\\'",
      )
      .all(name.replace(/[\\%_]/g, '\\$&') + '@%') as { key: string }[];
    for (const file of files)
      if (!present.has(file.key.slice(name.length + 1)))
        db()
          .prepare(
            "UPDATE package_cache_entries SET removed_at=COALESCE(removed_at,?) WHERE ecosystem='npm' AND kind='file' AND key=?",
          )
          .run(now(), file.key);
  }
  private record(kind: string, key: string, file: File, etag: string | null = null) {
    db()
      .prepare(
        "INSERT INTO package_cache_entries(ecosystem,kind,key,sha256,size,etag,fetched_at,last_used_at) VALUES('npm',?,?,?,?,?,?,?) ON CONFLICT(ecosystem,kind,key) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,etag=excluded.etag,fetched_at=excluded.fetched_at",
      )
      .run(kind, key, file.sha256, file.size, etag, now(), now());
  }
  tarballUrl(name: string, version: string) {
    return (
      this.settings.publicBase +
      encodeURIComponent(name) +
      '/-/' +
      encodeURIComponent(name.split('/').pop()! + '-' + version + '.tgz')
    );
  }
  async tarball(name: string, filename: string) {
    nameOf(name);
    fileOf(filename);
    if (name.startsWith('@deploy.local/')) fail('Package not found', 404);
    const doc = await this.document(name);
    const keyPrefix = name.split('/').pop()! + '-';
    if (!filename.startsWith(keyPrefix)) fail('Tarball not found', 404);
    const version = filename.slice(keyPrefix.length, -4),
      key = name + '@' + version;
    return this.single('file:' + key, async () => {
      const previous = entry('file', key);
      if (previous?.removed_at)
        fail(
          `${name}@${version} was removed from npmjs.org on ${previous.removed_at.slice(0, 10)}.`,
          404,
        );
      const index = doc ? await this.index(doc, version) : {};
      if (!Object.hasOwn(index, version)) fail('Version not found on npmjs.org', 404);
      if (
        previous &&
        (await stat(objectPath('cache', previous.sha256)).catch(() => null))?.size === previous.size
      ) {
        if (!this.reachable) this.copiesServed++;
        return this.touch('file', previous);
      }
      const dist = index[version];
      const response = await this.fetch(dist.tarball);
      if (!response.ok) {
        await response.body?.cancel();
        fail('Tarball not found on npmjs.org', 404);
      }
      const integrity = dist.integrity;
      if (
        typeof integrity !== 'string' ||
        !integrity.split(/\s+/).some((value) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value))
      ) {
        await response.body?.cancel();
        fail('npmjs.org did not supply sha512 integrity for this tarball.', 502);
      }
      await storeFile(this.body(response), 'cache', integrity, MAX_FILE, (file, move) =>
        writeCopy(async () => {
          await move();
          this.record('file', key, file);
          this.touch('file', entry('file', key)!);
        }),
      );
      return entry('file', key)!;
    });
  }
  async openTarball(
    name: string,
    filename: string,
  ): Promise<CacheEntry & { handle: import('node:fs/promises').FileHandle }> {
    await this.tarball(name, filename);
    const key = name + '@' + filename.slice(name.split('/').pop()!.length + 1, -4);
    const file = await writeCopy(async () => {
      const current = entry('file', key);
      if (!current) return null;
      if (current.removed_at)
        fail(`${key} was removed from npmjs.org on ${current.removed_at.slice(0, 10)}.`, 404);
      this.touch('file', current);
      return { ...current, handle: await open(objectPath('cache', current.sha256), 'r') };
    });
    if (!file) return this.openTarball(name, filename);
    return file;
  }
  async importVersion(name: string, version: string) {
    const file = await this.tarball(name, name.split('/').pop()! + '-' + version + '.tgz');
    return storeFile(
      createReadStream(objectPath('cache', file.sha256)),
      'hosted',
      'sha256-' + Buffer.from(file.sha256, 'hex').toString('base64'),
    );
  }
}
