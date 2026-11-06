import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { db, fail, now, objectPath, storeFile, MAX_DOC, fileOf, nameOf } from './store.ts';

// This setting is supplied by server construction, never by a request or persisted user setting.
// The production singleton uses registry.npmjs.org; tests inject a loopback origin.
export type RegistrySettings = { upstreamBase: string; publicBase: string; revalidateMs?: number };
export const productionSettings: RegistrySettings = {
  upstreamBase: 'https://registry.npmjs.org/',
  publicBase: 'https://deploy.local/npm/',
};
export type CacheEntry = {
  key: string;
  sha256: string;
  size: number;
  etag: string | null;
  fetched_at: string;
  removed_at: string | null;
};
const entry = (kind: string, key: string) =>
  db()
    .prepare("SELECT * FROM package_cache_entries WHERE ecosystem='npm' AND kind=? AND key=?")
    .get(kind, key) as CacheEntry | undefined;
export class NpmCopy {
  readonly settings: RegistrySettings;
  reachable = true;
  checkedAt: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, Promise<any>>();
  constructor(settings: RegistrySettings = productionSettings) {
    const base = new URL(settings.upstreamBase);
    if (
      base.origin !== 'https://registry.npmjs.org' &&
      !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
    )
      throw new Error('Upstream must be npmjs.org or a loopback test server');
    this.settings = { ...settings, upstreamBase: base.origin + '/' };
  }
  close() {
    if (this.timer) clearInterval(this.timer);
  }
  private state(reachable: boolean) {
    this.reachable = reachable;
    this.checkedAt = now();
    if (reachable) {
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
    if (url.origin !== new URL(this.settings.upstreamBase).origin)
      fail('Invalid upstream host', 422);
    try {
      const response = await fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 500) {
        await response.body?.cancel();
        throw new Error('source unavailable');
      }
      this.state(true);
      return response;
    } catch {
      this.state(false);
      fail('npmjs.org is unreachable and this package has not been kept.', 503);
    }
  }
  private async single<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.pending.has(key)) return this.pending.get(key)!;
    const promise = work().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  async document(name: string, force = false): Promise<any | null> {
    nameOf(name);
    return this.single('doc:' + name, async () => {
      let previous = entry('doc', name);
      if (
        previous &&
        !(await stat(objectPath('docs', previous.sha256)).catch(() => null))?.isFile()
      ) {
        db()
          .prepare(
            "DELETE FROM package_cache_entries WHERE ecosystem='npm' AND kind='doc' AND key=?",
          )
          .run(name);
        previous = undefined;
      }
      const read = async () => {
        db()
          .prepare(
            "UPDATE package_cache_entries SET last_used_at=? WHERE ecosystem='npm' AND kind='doc' AND key=?",
          )
          .run(now(), name);
        return JSON.parse(await readFile(objectPath('docs', previous!.sha256), 'utf8'));
      };
      if (
        previous &&
        !force &&
        Date.now() - Date.parse(previous.fetched_at) < (this.settings.revalidateMs ?? 300000)
      )
        return read();
      let response: Response;
      try {
        response = await this.fetch(encodeURIComponent(name), {
          headers: previous?.etag ? { 'If-None-Match': previous.etag } : {},
        });
      } catch (error) {
        if (previous) return read();
        throw error;
      }
      if (response.status === 304 && previous) {
        db()
          .prepare(
            "UPDATE package_cache_entries SET fetched_at=? WHERE ecosystem='npm' AND kind='doc' AND key=?",
          )
          .run(now(), name);
        return read();
      }
      if (response.status === 404) {
        await response.body?.cancel();
        this.markRemoved(name, {});
        // Keep a tombstone so fresh requests cannot resurrect the stale document.
        await this.saveDocument(
          name,
          { name, versions: {}, 'dist-tags': {}, _removed: true },
          null,
        );
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail('npmjs.org refused the package request', 502);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of Readable.fromWeb(response.body as any)) {
        size += chunk.length;
        if (size > MAX_DOC) fail('Upstream packument too large', 502);
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString();
      const doc = JSON.parse(raw);
      if (doc.name !== name || !doc.versions || typeof doc.versions !== 'object')
        fail('Invalid upstream packument', 502);
      this.markRemoved(name, doc.versions);
      await this.saveDocument(name, doc, response.headers.get('etag'));
      return doc;
    });
  }
  private markRemoved(name: string, versions: Record<string, unknown>) {
    const files = db()
      .prepare(
        "SELECT key FROM package_cache_entries WHERE ecosystem='npm' AND kind='file' AND key LIKE ? ESCAPE '\\'",
      )
      .all(name.replace(/[\\%_]/g, '\\$&') + '@%') as { key: string }[];
    for (const file of files)
      if (!Object.hasOwn(versions, file.key.slice(name.length + 1)))
        db()
          .prepare(
            "UPDATE package_cache_entries SET removed_at=COALESCE(removed_at,?) WHERE ecosystem='npm' AND kind='file' AND key=?",
          )
          .run(now(), file.key);
  }
  private async saveDocument(name: string, doc: any, etag: string | null) {
    const bytes = Buffer.from(JSON.stringify(doc));
    const file = await storeFile(
      Readable.from([bytes]),
      'docs',
      'sha256-' + createHash('sha256').update(bytes).digest('base64'),
      MAX_DOC,
    );
    this.record('doc', name, file, etag);
  }
  private record(
    kind: string,
    key: string,
    file: { sha256: string; size: number },
    etag: string | null = null,
  ) {
    db()
      .prepare(
        "INSERT INTO package_cache_entries(ecosystem,kind,key,sha256,size,etag,fetched_at,last_used_at) VALUES('npm',?,?,?,?,?,?,?) ON CONFLICT(ecosystem,kind,key) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,etag=excluded.etag,fetched_at=excluded.fetched_at,last_used_at=excluded.last_used_at",
      )
      .run(kind, key, file.sha256, file.size, etag, now(), now());
  }
  rewritten(doc: any) {
    const versions = Object.fromEntries(
      Object.entries(doc.versions || {}).map(([version, value]: [string, any]) => [
        version,
        { ...value, dist: { ...value.dist, tarball: this.tarballUrl(doc.name, version) } },
      ]),
    );
    return { ...doc, versions };
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
    fileOf(filename);
    const doc = await this.document(name);
    const keyPrefix = name.split('/').pop()! + '-';
    if (!filename.startsWith(keyPrefix)) fail('Tarball not found', 404);
    const version = filename.slice(keyPrefix.length, -4),
      key = name + '@' + version;
    const previous = entry('file', key);
    if (previous?.removed_at)
      fail(
        `${name}@${version} was removed from npmjs.org on ${previous.removed_at.slice(0, 10)}.`,
        404,
      );
    if (!doc?.versions?.[version]) fail('Version not found on npmjs.org', 404);
    if (
      previous &&
      (await stat(objectPath('cache', previous.sha256)).catch(() => null))?.size === previous.size
    ) {
      db()
        .prepare(
          "UPDATE package_cache_entries SET last_used_at=? WHERE ecosystem='npm' AND kind='file' AND key=?",
        )
        .run(now(), key);
      return previous;
    }
    return this.single('file:' + key, async () => {
      const dist = doc.versions[version].dist;
      const target = new URL(dist.tarball);
      if (target.origin !== new URL(this.settings.upstreamBase).origin)
        fail('Invalid upstream tarball host', 502);
      const response = await this.fetch(target.href);
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
      const file = await storeFile(Readable.fromWeb(response.body as any), 'cache', integrity);
      this.record('file', key, file);
      return { ...file, key, etag: null, fetched_at: now(), removed_at: null };
    });
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
