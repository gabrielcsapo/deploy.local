import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { writeCopy, type CacheEntry } from './cache.ts';
import { db, fail, MAX_DOC, MAX_FILE, now, objectPath, storeFile } from './store.ts';

export function crateName(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value))
    fail('Invalid crate name');
  return value;
}
export function indexPath(name: string) {
  const lower = crateName(name).toLowerCase();
  return (
    (lower.length < 3
      ? `${lower.length}/`
      : lower.length === 3
        ? `3/${lower[0]}/`
        : `${lower.slice(0, 2)}/${lower.slice(2, 4)}/`) + lower
  );
}
export const cargoEntry = (kind: string, key: string) =>
  db()
    .prepare("SELECT * FROM package_cache_entries WHERE ecosystem='cargo' AND kind=? AND key=?")
    .get(kind, key) as CacheEntry | undefined;
export type CargoSettings = {
  upstreamBase?: string;
  downloadBase?: string;
  revalidateMs?: number;
  timeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  bodyTotalTimeoutMs?: number;
};
function removed(row: CacheEntry) {
  fail(`This crate was removed from crates.io on ${row.removed_at!.slice(0, 10)}.`, 404);
}
const integrity = (bytes: Buffer) =>
  'sha256-' + createHash('sha256').update(bytes).digest('base64');

/** The index is an exact copy: only config.json changes, never dependencies or checksums. */
export class CargoCopy {
  readonly settings: Required<CargoSettings>;
  reachable = true;
  checkedAt: string | null = null;
  downSince: string | null = null;
  copiesServed = 0;
  private pending = new Map<string, Promise<any>>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(settings: CargoSettings = {}) {
    this.settings = {
      upstreamBase: 'https://index.crates.io/',
      downloadBase: 'https://static.crates.io/crates/',
      revalidateMs: 300000,
      timeoutMs: 5000,
      bodyIdleTimeoutMs: 30000,
      bodyTotalTimeoutMs: 600000,
      ...settings,
    };
    for (const [base, host] of [
      [this.settings.upstreamBase, 'index.crates.io'],
      [this.settings.downloadBase, 'static.crates.io'],
    ]) {
      const url = new URL(base);
      if (
        !(url.protocol === 'https:' && url.hostname === host) &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
        throw new Error('Cargo upstream must be crates.io or a loopback test server');
    }
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private state(ok: boolean) {
    this.reachable = ok;
    this.checkedAt = now();
    if (ok) {
      this.downSince = null;
      this.close();
    } else {
      this.downSince ||= now();
      if (!this.timer) {
        this.timer = setInterval(() => {
          void this.fetch(new URL('config.json', this.settings.upstreamBase), MAX_DOC).catch(
            () => {},
          );
        }, 60000);
        this.timer.unref();
      }
    }
  }
  private async fetch(url: URL, limit: number, etag?: string | null) {
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.settings.timeoutMs),
        headers: etag ? { 'If-None-Match': etag } : {},
      });
      if (response.status >= 500 || response.status === 429) {
        await response.body?.cancel();
        throw Error('unreachable');
      }
      const chunks: Buffer[] = [];
      let length = 0;
      if (response.body)
        for await (const chunk of Readable.fromWeb(response.body as any)) {
          length += chunk.length;
          if (length > limit) fail('Cargo upstream response too large', 413);
          chunks.push(chunk);
        }
      this.state(true);
      return {
        status: response.status,
        etag: response.headers.get('etag'),
        bytes: Buffer.concat(chunks),
      };
    } catch {
      this.state(false);
      fail('crates.io is unreachable and this crate has not been kept.', 503);
    }
  }
  private single<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(key);
    if (prior) return prior;
    const promise = work().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  private touch(kind: string, key: string) {
    db()
      .prepare(
        "UPDATE package_cache_entries SET last_used_at=? WHERE ecosystem='cargo' AND kind=? AND key=?",
      )
      .run(now(), kind, key);
  }
  private async keep(
    kind: 'doc' | 'file',
    key: string,
    bytes: Buffer,
    expected: string,
    etag: string | null = null,
  ) {
    return writeCopy(async () => {
      const file = await storeFile(
        Readable.from([bytes]),
        kind === 'doc' ? 'docs' : 'cache',
        expected,
        kind === 'doc' ? MAX_DOC : MAX_FILE,
      );
      db()
        .prepare(
          "INSERT INTO package_cache_entries(ecosystem,kind,key,sha256,size,etag,fetched_at,last_used_at) VALUES('cargo',?,?,?,?,?,?,?) ON CONFLICT(ecosystem,kind,key) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,etag=excluded.etag,fetched_at=excluded.fetched_at,last_used_at=excluded.last_used_at,removed_at=NULL",
        )
        .run(kind, key, file.sha256, file.size, etag, now(), now());
      return cargoEntry(kind, key)!;
    });
  }
  async document(name: string): Promise<CacheEntry> {
    name = crateName(name).toLowerCase();
    return this.single('doc:' + name, async () => {
      const saved = cargoEntry('doc', name);
      if (saved?.removed_at && !this.reachable) removed(saved);
      if (
        saved &&
        !saved.removed_at &&
        (!this.reachable || Date.now() - Date.parse(saved.fetched_at) < this.settings.revalidateMs)
      ) {
        this.touch('doc', name);
        this.copiesServed++;
        return saved;
      }
      let result;
      try {
        result = await this.fetch(
          new URL(indexPath(name), this.settings.upstreamBase),
          MAX_DOC,
          saved?.etag,
        );
      } catch (error) {
        if (saved && !saved.removed_at) {
          this.touch('doc', name);
          this.copiesServed++;
          return saved;
        }
        throw error;
      }
      if (result.status === 304 && saved && !saved.removed_at) {
        db()
          .prepare(
            "UPDATE package_cache_entries SET fetched_at=?,last_used_at=? WHERE ecosystem='cargo' AND kind='doc' AND key=?",
          )
          .run(now(), now(), name);
        return cargoEntry('doc', name)!;
      }
      if (result.status === 404 || result.status === 410) {
        db()
          .prepare(
            "UPDATE package_cache_entries SET removed_at=COALESCE(removed_at,?) WHERE ecosystem='cargo' AND (key=? OR substr(key,1,length(?)+1)=?||'@')",
          )
          .run(now(), name, name, name);
        if (saved) removed(cargoEntry('doc', name)!);
        fail('Crate not found on crates.io', 404);
      }
      if (result.status !== 200) fail('Could not read crates.io index', 502);
      const lines = this.lines(result.bytes);
      if (
        lines.some(
          (line: any) =>
            !line ||
            typeof line.name !== 'string' ||
            line.name.toLowerCase() !== name ||
            typeof line.vers !== 'string' ||
            !Array.isArray(line.deps) ||
            !/^[a-f0-9]{64}$/.test(line.cksum),
        )
      )
        fail('Invalid crates.io index', 502);
      const row = await this.keep('doc', name, result.bytes, integrity(result.bytes), result.etag);
      db().transaction(() => {
        const kept = db()
          .prepare("SELECT key FROM package_cache_entries WHERE ecosystem='cargo' AND kind='file'")
          .all() as { key: string }[];
        const present = new Set(lines.map((line: any) => `${name}@${line.vers}`));
        for (const file of kept.filter((candidate) => candidate.key.startsWith(name + '@'))) {
          db()
            .prepare(
              "UPDATE package_cache_entries SET removed_at=CASE WHEN ? THEN NULL ELSE COALESCE(removed_at,?) END WHERE ecosystem='cargo' AND kind='file' AND key=?",
            )
            .run(Number(present.has(file.key)), now(), file.key);
        }
      })();
      return row;
    });
  }
  private lines(bytes: Buffer) {
    try {
      return bytes
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      fail('Invalid crates.io index', 502);
    }
  }
  async download(name: string, version: string) {
    name = crateName(name).toLowerCase();
    const key = `${name}@${version}`;
    return this.single('file:' + key, async () => {
      const doc = await this.document(name);
      const lines = await writeCopy(async () =>
        this.lines(await readFile(objectPath('docs', doc.sha256))),
      );
      const line = lines.find((candidate: any) => candidate.vers === version);
      const kept = cargoEntry('file', key);
      if (!line) {
        if (kept?.removed_at) removed(kept);
        fail('Crate version not found on crates.io', 404);
      }
      if (kept && !kept.removed_at && kept.sha256 === line.cksum && kept.size > 0) {
        this.touch('file', key);
        return kept;
      }
      let idle: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const header = setTimeout(() => controller.abort(), this.settings.timeoutMs);
      try {
        const response = await fetch(
          new URL(`${name}/${name}-${version}.crate`, this.settings.downloadBase),
          {
            redirect: 'error',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(this.settings.bodyTotalTimeoutMs),
            ]),
          },
        );
        clearTimeout(header);
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          if (response.status >= 500 || response.status === 429) this.state(false);
          fail('Crate file not available on crates.io', response.status === 404 ? 404 : 503);
        }
        const expected = 'sha256-' + Buffer.from(line.cksum, 'hex').toString('base64');
        const source = Readable.fromWeb(response.body as any);
        const reset = () => {
          clearTimeout(idle);
          idle = setTimeout(
            () => source.destroy(new Error('Cargo download timed out')),
            this.settings.bodyIdleTimeoutMs,
          );
        };
        const watched = Readable.from(
          (async function* () {
            reset();
            for await (const chunk of source) {
              reset();
              yield chunk;
            }
          })(),
        );
        await storeFile(watched, 'cache', expected, MAX_FILE, async (file, move) => {
          await writeCopy(async () => {
            // A revalidation may have removed the version while its file was downloading.
            const current = cargoEntry('doc', name);
            const currentLine =
              current &&
              !current.removed_at &&
              this.lines(await readFile(objectPath('docs', current.sha256))).find(
                (candidate: any) => candidate.vers === version,
              );
            if (!currentLine || currentLine.cksum !== file.sha256)
              fail('Version removed or checksum changed on crates.io', 404);
            await move();
            db()
              .prepare(
                "INSERT INTO package_cache_entries(ecosystem,kind,key,sha256,size,fetched_at,last_used_at) VALUES('cargo','file',?,?,?,?,?) ON CONFLICT(ecosystem,kind,key) DO UPDATE SET sha256=excluded.sha256,size=excluded.size,fetched_at=excluded.fetched_at,last_used_at=excluded.last_used_at,removed_at=NULL",
              )
              .run(key, file.sha256, file.size, now(), now());
          });
        });
        this.state(true);
        return cargoEntry('file', key)!;
      } catch (error: any) {
        if (error.status) throw error;
        this.state(false);
        fail('crates.io is unreachable and this crate has not been kept.', 503);
      } finally {
        clearTimeout(header);
        clearTimeout(idle);
      }
    });
  }
  async open(kind: 'doc' | 'file', row: CacheEntry) {
    return writeCopy(async () => {
      const current = cargoEntry(kind, row.key);
      if (!current) fail('Crate not found on crates.io', 404);
      if (current.removed_at) removed(current);
      this.touch(kind, row.key);
      return {
        row: current,
        handle: await open(objectPath(kind === 'doc' ? 'docs' : 'cache', current.sha256), 'r'),
      };
    });
  }
}
