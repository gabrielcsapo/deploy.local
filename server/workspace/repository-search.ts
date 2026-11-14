import { spawn } from 'node:child_process';
import { gitEnvironment } from '../kernel/git.ts';

export type CodeLine = { path: string; line: number; text: string };
export type CodeSearch = {
  /** Matching lines, in file order, up to `keep`. */
  items: CodeLine[];
  /** Lines and files counted before the search stopped. */
  lines: number;
  files: number;
  /** True when the search stopped at its limit or its time, so the counts are a floor. */
  truncated: boolean;
};

const LINE_WIDTH = 240;

/** The part of a long line around its match, without the indentation. */
function trimLine(text: string, query: string) {
  const line = text.replace(/\t/g, '  ').trim();
  if (line.length <= LINE_WIDTH) return line;
  const at = line.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, Math.min(at - 60, line.length - LINE_WIDTH));
  return (start > 0 ? '…' : '') + line.slice(start, start + LINE_WIDTH);
}

/**
 * Lines of text files at `commit` that contain `query`, as typed and ignoring case.
 *
 * This reads the repository directly with `git grep` instead of keeping an index: nothing to
 * build or keep in step with pushes, and any commit can be searched. It stops itself after
 * `count` lines or `timeout` milliseconds so one broad search cannot hold a repository busy.
 */
export function searchRepositoryCode(
  repo: string,
  commit: string,
  query: string,
  options: { keep?: number; count?: number; timeout?: number; signal?: AbortSignal } = {},
): Promise<CodeSearch> {
  const keep = options.keep ?? 200;
  const count = options.count ?? 2000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.ext.allow=never',
        '-C',
        repo,
        'grep',
        '-I',
        '-n',
        '-i',
        '-F',
        '--no-color',
        '--null',
        '-e',
        query,
        commit,
        '--',
      ],
      { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const result: CodeSearch = { items: [], lines: 0, files: 0, truncated: false };
    const prefix = `${commit}:`;
    let pending: Buffer = Buffer.alloc(0);
    let lastPath: string | undefined;
    let stderr = '';
    let failure: Error | undefined;
    const stop = () => {
      result.truncated = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, options.timeout ?? 10_000);
    const abort = () => {
      failure = new Error('Search cancelled');
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const take = (record: Buffer) => {
      // `<commit>:<path>\0<line>\0<text>`
      const first = record.indexOf(0);
      const second = record.indexOf(0, first + 1);
      if (first < 0 || second < 0) return;
      const path = record.subarray(0, first).toString().slice(prefix.length);
      const line = Number(record.subarray(first + 1, second).toString());
      if (!path || !Number.isInteger(line)) return;
      if (path !== lastPath) {
        lastPath = path;
        result.files++;
      }
      result.lines++;
      if (result.items.length < keep)
        result.items.push({
          path,
          line,
          text: trimLine(record.subarray(second + 1, second + 1 + 4096).toString(), query),
        });
      if (result.lines >= count) stop();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (result.truncated) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let from = 0;
      for (;;) {
        const end = pending.indexOf(10, from);
        if (end < 0) break;
        take(pending.subarray(from, end));
        from = end + 1;
        if (result.truncated) return;
      }
      pending = pending.subarray(from);
      // A single line longer than this is not text anyone reads.
      if (pending.length > 1024 * 1024) pending = Buffer.alloc(0);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once('error', (error) => {
      failure ||= error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      // 1 means nothing matched.
      else if (result.truncated || code === 0 || code === 1) resolve(result);
      else reject(new Error(`Code search failed (${code}): ${stderr.trim()}`));
    });
  });
}

export type FileMatch = { path: string; name: string; directory: string };

/** Files whose name contains `query`, names that start with it first; then paths that contain it. */
export function matchFileNames(paths: string[], query: string, keep = 20) {
  const needle = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const slash = lower.lastIndexOf('/');
    const at = lower.indexOf(needle, slash + 1);
    if (at === slash + 1) scored.push({ path, score: 0 });
    else if (at > 0) scored.push({ path, score: 1 });
    else if (needle.includes('/') && lower.includes(needle)) scored.push({ path, score: 2 });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return {
    total: scored.length,
    items: scored.slice(0, keep).map(({ path }): FileMatch => {
      const slash = path.lastIndexOf('/');
      return {
        path,
        name: path.slice(slash + 1),
        directory: slash < 0 ? '' : path.slice(0, slash),
      };
    }),
  };
}
