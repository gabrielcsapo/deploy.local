// The Design page's data from a folder on this computer, for `deploy design dev`. It answers the
// same design API the page reads from deploy.local (see server/features/design/design.ts), so the
// page is the same components with a second source: the canvas, boards and design system come
// from the folder, edits are written into its files, and what only deploy.local has (comments,
// reviews, agents, presence, the inbox) answers empty. A "commit" here is a hash of the folder's
// design files, so an edit's answer and the reload after its save name the same version.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  applyEdits,
  boardLinks,
  layerChanges,
  layerIds,
  syncInstances,
  type Library,
} from './board-html.ts';
import { applyCanvasEdit } from './canvas-edit.ts';
import {
  brokenLinks,
  canvasProblems,
  libraryPath,
  lostLayers,
  parseLibrary,
} from '../features/design/board-check.ts';
import { screenName } from '../../shared/v2/design-review.ts';

/** The project the page shows: one, named "local" in its addresses. */
export const localProjectId = 'local';
export const localDesignApi = `/api/projects/${localProjectId}/design`;

const fileTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};
// Boards may load the design system's CSS beside them and Google Fonts; nothing else, and no script.
const boardPolicy = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-same-origin',
].join('; ');
const boardPattern = /^[A-Za-z0-9_-]+\.html$/;

export type LocalProblem = { file: string; short: string; detail: string };

export type LocalDesignOptions = {
  /** The checkout's root; the design is <root>/design. */
  root: string;
  /** The project's name, as the page's picker shows it. */
  project: string;
  /** The branch checked out here. */
  branch: string;
  /** The ref main is compared from, like origin/main. */
  main: string;
  /** deploy.local's own design system file, for a project with no design/ds. */
  designSystem: (path: string) => Buffer | null;
  /** Git in the checkout; null when it fails. */
  git?: (args: string[]) => string | null;
};

const json = (res: ServerResponse, body: unknown, status = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
  return true;
};

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw Object.assign(new Error('Too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw Object.assign(new Error('Send JSON'), { status: 400 });
  }
}

export function createLocalDesign(options: LocalDesignOptions) {
  const root = resolve(options.root);
  const design = join(root, 'design');
  const git =
    options.git ??
    ((args: string[]) => {
      try {
        return execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 1 << 28,
        }).trimEnd();
      } catch {
        return null;
      }
    });
  const inside = (path: string) => {
    const full = resolve(design, path);
    return full === design || full.startsWith(`${design}${sep}`) ? full : null;
  };
  const read = (path: string) => {
    const full = inside(path);
    try {
      return full ? readFileSync(full) : null;
    } catch {
      return null;
    }
  };
  const readText = (path: string) => read(path)?.toString() ?? null;
  const canvas = () => {
    try {
      return JSON.parse(readText('canvas.json') ?? 'null');
    } catch {
      return null;
    }
  };
  const library = () => parseLibrary(readText(libraryPath.replace(/^design\//, '')));
  const boards = () => {
    try {
      return readdirSync(join(design, 'boards')).filter((file) => boardPattern.test(file));
    } catch {
      return [];
    }
  };

  // The version: every design file's path and contents, hashed again only when one changed.
  const hashes = new Map<string, { stat: string; hash: string }>();
  const walk = (dir: string, out: string[]) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, out);
      else if (entry.isFile()) out.push(path);
    }
    return out;
  };
  function version() {
    const all = createHash('sha1');
    for (const path of walk(design, []).sort()) {
      let stat: Stats;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      const key = `${stat.size}:${stat.mtimeMs}`;
      let known = hashes.get(path);
      if (known?.stat !== key) {
        known = {
          stat: key,
          hash: createHash('sha1').update(readFileSync(path)).digest('hex'),
        };
        hashes.set(path, known);
      }
      all.update(`${relative(design, path)}\0${known.hash}\0`);
    }
    return all.digest('hex');
  }

  /** Where this branch started from main: what "Changes on this branch" compares with. */
  const forkedAt = () =>
    git(['merge-base', 'HEAD', options.main]) ?? git(['rev-parse', '--verify', options.main]);
  const mainBytes = (path: string) => {
    const base = git(['rev-parse', '--verify', '--quiet', `${options.main}^{commit}`]);
    if (!base) return null;
    try {
      return execFileSync('git', ['show', `${base}:${path}`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1 << 28,
      });
    } catch {
      return null;
    }
  };
  const onMain = (path: string) => {
    const base = git(['rev-parse', '--verify', '--quiet', `${options.main}^{commit}`]);
    return base ? git(['show', `${base}:${path}`]) : null;
  };

  /** What is wrong with a board as it is saved: what a check would say without drawing it. */
  function problems(file: string): LocalProblem[] {
    const html = readText(`boards/${file}`);
    const found: LocalProblem[] = [];
    if (html === null) return found;
    for (const layer of lostLayers(onMain(`design/boards/${file}`), html))
      found.push({ file, short: `lost layer ${layer}`, detail: 'main has it; keep its ID' });
    // A link main's board already has is not this branch's problem.
    const before = onMain(`design/boards/${file}`);
    const broken = new Set(before ? brokenLinks(before, boards()) : []);
    for (const to of brokenLinks(html, boards()))
      if (!broken.has(to))
        found.push({ file, short: `links to ${to}`, detail: 'no board has that name' });
    const placed = Object.keys(canvas()?.boards ?? {});
    for (const problem of canvasProblems({ disk: boards(), canvas: placed }))
      if (problem.file === file)
        found.push({
          file,
          short: problem.label.slice(problem.file.length + 1),
          detail: problem.detail,
        });
    return found;
  }

  function write(path: string, content: string) {
    const full = inside(path);
    if (!full) throw Object.assign(new Error('Not found'), { status: 404 });
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    // What only deploy.local has: nothing here.
    const empty: Record<string, unknown> = {
      '/api/inbox': { items: [], cursor: 0 },
      '/api/artifacts': { artifacts: [] },
      '/api/computers': { computers: [] },
      '/api/user': { username: '' },
      [`${localDesignApi}/comments`]: { comments: [] },
      [`${localDesignApi}/asks`]: { asks: [] },
      [`${localDesignApi}/presence`]: { agents: [] },
      [`${localDesignApi}/proposals`]: { proposals: [] },
    };
    if (method === 'GET' && path in empty) return json(res, empty[path]);
    if (method === 'GET' && path === '/api/activity-events') {
      // Nothing happens here that the page follows this way; a long poll waits, then says so.
      if (url.searchParams.has('waitMs'))
        await new Promise<void>((done) => {
          const timer = setTimeout(done, 10_000);
          timer.unref?.();
          req.once('close', () => (clearTimeout(timer), done()));
        });
      if (res.destroyed) return true;
      return json(res, { events: [], cursor: 0, supportsWait: true });
    }
    if (method === 'GET' && path === '/api/projects')
      return json(res, {
        projects: [{ id: localProjectId, name: options.project, apps: [] }],
      });
    if (method === 'GET' && path === '/api/design/projects')
      return json(res, {
        projects: [{ id: localProjectId, name: options.project, boards: boards().length }],
      });
    if (!path.startsWith(localDesignApi)) return false;
    const sub = path.slice(localDesignApi.length);
    try {
      if (method === 'GET' && sub === '')
        return json(res, {
          ref: options.branch,
          commit: version(),
          canvas: canvas(),
          fresh: false,
          branches: [],
          openComments: 0,
        });
      // A board as this folder has it, or (main-files) as main has it, for measuring beside it.
      const file = sub.match(
        /^\/(?:files\/[0-9a-f]+|(main-files))\/((?:boards|ds)\/[A-Za-z0-9_./-]+)$/,
      );
      if (file && (method === 'GET' || method === 'HEAD')) {
        const [, fromMain, at] = file;
        const type = fileTypes[at.split('.').pop()!];
        if (!type || at.split('/').includes('..')) return json(res, { error: 'Not found' }, 404);
        let bytes =
          (fromMain && at.startsWith('boards/') ? mainBytes(`design/${at}`) : null) ??
          (fromMain && at.startsWith('boards/') ? null : read(at)) ??
          (at.startsWith('ds/') ? options.designSystem(at) : null);
        if (!bytes) return json(res, { error: 'Not found' }, 404);
        // A board shows its instances as the folder's library draws them.
        if (at.startsWith('boards/') && at.endsWith('.html')) {
          const html = bytes.toString();
          const lib = html.includes(' data-component="') ? library() : null;
          if (lib) bytes = Buffer.from(syncInstances(html, lib));
        }
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': bytes.length,
          'Content-Security-Policy': boardPolicy,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        res.end(method === 'HEAD' ? undefined : bytes);
        return true;
      }
      if (method === 'GET' && sub === '/links') {
        const links = Object.keys(canvas()?.boards ?? {}).flatMap((from) => {
          const html = readText(`boards/${from}`);
          return html ? boardLinks(html).map((link) => ({ from, ...link })) : [];
        });
        return json(res, { commit: version(), links });
      }
      if (method === 'GET' && sub === '/components') {
        const lib = library();
        const usage: Record<string, string[]> = {};
        if (lib)
          for (const board of boards())
            for (const match of (readText(`boards/${board}`) ?? '').matchAll(
              /data-component="([a-z0-9-]*)"/g,
            )) {
              const using = (usage[match[1]] ??= []);
              if (!using.includes(board)) using.push(board);
            }
        return json(res, { commit: version(), library: lib, usage });
      }
      if (method === 'GET' && sub === '/changes') {
        const base = forkedAt();
        const files: { status: string; path: string; layers?: unknown[] }[] = [];
        if (base) {
          const lines = [
            ...(git(['diff', '--name-status', '--no-renames', base, '--', 'design/']) ?? '').split(
              '\n',
            ),
            ...(git(['ls-files', '--others', '--exclude-standard', '--', 'design/']) ?? '')
              .split('\n')
              .filter(Boolean)
              .map((line) => `A\t${line}`),
          ].filter(Boolean);
          for (const line of lines) {
            const [code, changed] = line.split('\t');
            const status = code === 'A' ? 'added' : code === 'D' ? 'removed' : 'changed';
            if (status !== 'changed' || !/^design\/boards\/[^/]+\.html$/.test(changed)) {
              files.push({ status, path: changed });
              continue;
            }
            const before = git(['show', `${base}:${changed}`]);
            const after = readText(changed.slice('design/'.length));
            files.push({
              status,
              path: changed,
              layers: before && after ? layerChanges(before, after) : [],
            });
          }
        }
        return json(res, { base, commit: version(), files, artifacts: [] });
      }
      if (method === 'POST' && sub === '/edit') {
        const body = await readBody(req);
        const board = String(body?.board ?? '');
        if (!boardPattern.test(board)) return json(res, { error: 'Name a board' }, 400);
        const edits = body?.edits;
        if (!Array.isArray(edits) || !edits.length || edits.length > 50)
          return json(res, { error: 'Send 1 to 50 edits' }, 400);
        const html = readText(`boards/${board}`);
        if (html === null) return json(res, { error: `design/boards/${board} is missing` }, 404);
        const lib = edits.some((edit: any) => edit.op === 'insert' && edit.component)
          ? library()
          : undefined;
        const next = applyEdits(
          html,
          edits,
          onMain(`design/boards/${board}`) ?? undefined,
          (lib ?? undefined) as Library | undefined,
        );
        if (next === html)
          return json(res, { branch: options.branch, commit: version(), layers: [] });
        const before = new Set(layerIds(html));
        write(`boards/${board}`, next);
        return json(res, {
          branch: options.branch,
          commit: version(),
          layers: layerIds(next).filter((layer) => !before.has(layer)),
        });
      }
      if (method === 'POST' && sub === '/canvas') {
        const body = await readBody(req);
        const current = canvas();
        if (!current) return json(res, { error: 'This design has no canvas.json' }, 404);
        const { writes, made } = applyCanvasEdit(current, body, 'design');
        for (const entry of writes) write(entry.path.slice('design/'.length), entry.content);
        write('canvas.json', `${JSON.stringify(current, null, 2)}\n`);
        return json(res, { branch: options.branch, commit: version(), made });
      }
      return json(res, { error: 'Comments, review and agents are on deploy.local' }, 404);
    } catch (error: any) {
      return json(res, { error: error?.message ?? 'Failed' }, error?.status ?? 500);
    }
  }

  return {
    handle,
    version,
    problems,
    /** A board's name as the page and the check say it. */
    name: (file: string) => screenName(file),
    exists: () => existsSync(join(design, 'canvas.json')),
    /** A board's place and size on the canvas, or null when it is not on it. */
    placed: (file: string): { w: number; h: number } | null => {
      const board = canvas()?.boards?.[file];
      return board ? { w: Number(board.w ?? 1440), h: Number(board.h ?? 900) } : null;
    },
  };
}
