// `deploy design check` on the computer: the same check and drawing deploy.local runs
// (server/features/design/board-check.ts, server/design/check-drawing.ts), with main as this
// checkout's own origin/main and the branch as the folder's files as they are. It only reads Git
// (git show, ls-tree, diff), with optional locks off, so nothing is written inside .git: a
// sandbox that cannot write there can run it.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLibrary } from '../server/features/design/board-check.ts';
import {
  buildBoardPage,
  inlineWebFonts,
  pairPage,
  shootBoard,
} from '../server/design/check-drawing.ts';
import { openChromium } from './design-browser.mjs';
import { designSystemFolder, designSystemPaths } from '../shared/v2/design-system-path.ts';

/** What checkDesign calls the folder's working copy; never a name Git would take for a commit. */
export const WORKTREE = ':worktree:';

/** Git that reads only and takes no optional locks, so it never writes the index. */
const readOnly = { GIT_OPTIONAL_LOCKS: '0' };

/**
 * A Git reader for checkDesign in which WORKTREE is the folder's files: `show WORKTREE:path`
 * reads the file, `ls-tree WORKTREE:dir` lists it, a diff against WORKTREE is Git's diff of the
 * working tree plus the files Git does not track yet, and the merge base is HEAD's. Everything
 * else goes to Git as asked. `sent` keeps every board read, for writing layer IDs back only into
 * boards nobody changed meanwhile.
 */
export function worktreeGit({ top, git }) {
  const sent = new Map();
  const run = (args) => {
    try {
      return git(args, top, readOnly);
    } catch {
      return null;
    }
  };
  const file = (path) => {
    const full = join(top, path);
    if (!existsSync(full)) return null;
    try {
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };
  const read = async (args) => {
    const [command, ...rest] = args;
    if (!args.some((arg) => arg.includes(WORKTREE))) return run(args);
    if (command === 'merge-base')
      return run(['merge-base', ...rest.map((arg) => (arg === WORKTREE ? 'HEAD' : arg))]);
    if (command === 'show') {
      const path = rest[0].slice(WORKTREE.length + 1);
      const text = file(path);
      if (/\/boards\/[^/]+\.html$/.test(path)) sent.set(path, text);
      return text;
    }
    if (command === 'ls-tree') {
      const dir = rest.at(-1).slice(WORKTREE.length + 1);
      try {
        return readdirSync(join(top, dir), { withFileTypes: true })
          .filter((entry) => entry.isFile() || entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
          .join('\n');
      } catch {
        return null;
      }
    }
    if (command === 'diff') {
      const at = rest.indexOf(WORKTREE);
      const spec = rest.slice(rest.indexOf('--') + 1);
      const tracked = run(['diff', ...rest.slice(0, at), ...rest.slice(at + 1)]);
      const untracked = run(['ls-files', '--others', '--exclude-standard', '--', ...spec]);
      return [tracked, untracked].filter(Boolean).join('\n');
    }
    if (command === 'grep') return '';
    return null;
  };
  return { read, sent };
}

/** The folders under design/ds at a commit (or the working copy). */
export function designSystemFolders(top, at) {
  if (at === WORKTREE) {
    try {
      return readdirSync(join(top, 'design', 'ds'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
  try {
    return execFileSync('git', ['ls-tree', '-d', '--name-only', `${at}:design/ds`], {
      cwd: top,
      env: { ...process.env, ...readOnly },
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The design system file under design/ at a commit (or the working copy), as bytes. */
export function designFile(top, at, path) {
  if (at === WORKTREE) {
    const full = join(top, 'design', path);
    return existsSync(full) ? readFileSync(full) : null;
  }
  try {
    return execFileSync('git', ['show', `${at}:design/${path}`], {
      cwd: top,
      env: { ...process.env, ...readOnly },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 28,
    });
  } catch {
    return null;
  }
}

/**
 * The drawing for checkDesign, on a browser started here. Resolves to { drawing, browser, close }
 * or { reason } when no browser could start. `designSystem(path)` gives deploy.local's own design
 * system file for a project with none.
 */
export async function openLocalDrawing({
  top,
  designSystem = () => null,
  fontCache = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'deploy',
    'design-fonts',
  ),
  open = openChromium,
}) {
  // Chromium's profile and pages live in the worktree's output folder: a sandbox lets the check
  // write there when it lets it write nowhere else.
  const workDir = join(top, 'output', 'design', '.chromium');
  const { browser, reason, sandboxed } = await open({ workDir });
  if (!browser) return { reason };
  const fonts = new Map();
  const missingFonts = new Set();
  const read = (at, path) => designFile(top, at, path);
  // The project's own component library at a commit (or the working copy), read once.
  const libraries = new Map();
  const libraryAt = (at) => {
    if (!libraries.has(at)) {
      let canvas = null;
      try {
        canvas = JSON.parse(read(at, 'canvas.json')?.toString() ?? 'null');
      } catch {
        canvas = null;
      }
      const ds = designSystemFolder(canvas, designSystemFolders(top, at));
      const found = ds
        ? designSystemPaths(ds)
            .library.map((path) => read(at, path))
            .find(Boolean)
        : null;
      libraries.set(at, parseLibrary(found?.toString()));
    }
    return libraries.get(at);
  };
  const page = async (at, html) => {
    const built = await buildBoardPage(html, {
      library: async () => libraryAt(at),
      css: async (path) => read(at, path) ?? designSystem(path),
      capture: async (path) => read(at, `boards/${path}`),
    });
    const inlined = await inlineWebFonts(built, { cache: fontCache, known: fonts });
    for (const href of inlined.missing) missingFonts.add(href);
    return inlined.page;
  };
  const drawing = {
    async shoot({ commit, file, width, height, scheme, measure, inspect }) {
      const html = read(commit, `boards/${file}`);
      if (!html) return null;
      const built = await page(commit, html.toString());
      const tab = await browser.newTab({ width, height, scheme });
      try {
        return await shootBoard(tab, built, { scheme, measure, inspect });
      } finally {
        await tab.close();
      }
    },
    async pair({ before, after, width, height, scheme, questions }) {
      const tab = await browser.newTab({ width: width * 2 + 48, height: height + 64 });
      try {
        await tab.setContent(pairPage({ before, after, width, scheme, questions }));
        return await tab.screenshot({ fullPage: true });
      } finally {
        await tab.close();
      }
    },
  };
  return {
    drawing,
    executable: browser.executable,
    sandboxed: Boolean(sandboxed),
    missingFonts,
    close: () => browser.close(),
  };
}
