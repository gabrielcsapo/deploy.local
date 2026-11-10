// Render boards from design/boards to PNG with headless Playwright Chromium.
//   node design/tools/render.mjs [--main] [--stale-ok] [Board ...]
// Web boards render at 1440 and 700 px, phone boards at their own width, into
// output/design/<Board>-<width>.png. With no names, every board on the canvas renders.
//
// Approving a design writes to main on deploy.local, so a checkout goes stale without
// anyone touching it. This refuses to render a checkout that lacks design changes main
// has; --stale-ok renders it anyway. --main renders the approved design itself, from
// origin/main, into output/design-main: use it to review, and for the Before of a pair.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const names = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const fromMain = flags.has('--main');
const main = 'origin/main';

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  }).trim();
}
function tryGit(args) {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Bring origin/main up to date; offline, the last fetched main still serves.
const fetched = tryGit(['fetch', '--quiet', 'origin', 'main']) !== null;
const mainCommit = tryGit(['rev-parse', '--short', main]);
if (!fetched && mainCommit)
  console.warn(`Could not reach origin; comparing with main as last fetched (${mainCommit}).`);

/** Design files main changed since this checkout branched that the checkout does not have. */
function missingFromMain() {
  const base = tryGit(['merge-base', 'HEAD', main]);
  if (!base) return [];
  const changed = git(['diff', '--name-only', base, main, '--', 'design']).split('\n');
  return changed.filter(
    (path) =>
      path && tryGit(['rev-parse', `HEAD:${path}`]) !== tryGit(['rev-parse', `${main}:${path}`]),
  );
}

let source = root;
let label;
let scratch;
if (fromMain) {
  if (!mainCommit) {
    console.error(`No ${main} here. Fetch origin, then run again.`);
    process.exit(1);
  }
  scratch = mkdtempSync(join(tmpdir(), 'design-main-'));
  execFileSync('tar', ['-x', '-C', scratch], {
    input: execFileSync('git', ['archive', main, 'design'], {
      cwd: root,
      maxBuffer: 1 << 30,
    }),
  });
  source = scratch;
  label = `main (${mainCommit})`;
} else {
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'this checkout';
  label = `${branch} (${tryGit(['rev-parse', '--short', 'HEAD']) ?? 'no commit'})`;
  const missing = mainCommit ? missingFromMain() : [];
  if (missing.length > 0 && !flags.has('--stale-ok')) {
    const boards = missing.filter((path) => path.startsWith('design/boards/')).length;
    console.error(
      `${label} is behind the approved design: main (${mainCommit}) changed ${missing.length} design ` +
        `file${missing.length === 1 ? '' : 's'} (${boards} board${boards === 1 ? '' : 's'}) that this checkout does not have.\n` +
        `  To look at the approved design:  node design/tools/render.mjs --main\n` +
        `  To change a design:              start a branch from ${main}, or merge ${main} into this one\n` +
        `  To render this checkout anyway:  add --stale-ok`,
    );
    process.exit(1);
  }
  if (missing.length > 0) console.warn(`Rendering ${label} although main has newer design files.`);
}

try {
  const canvas = JSON.parse(readFileSync(resolve(source, 'design/canvas.json'), 'utf8'));
  const boards = Object.entries(canvas.boards).filter(
    ([file]) => names.length === 0 || names.includes(file.replace(/\.html$/, '')),
  );
  if (boards.length === 0) {
    console.error(`No boards named ${names.join(', ')} in design/canvas.json on ${label}.`);
    process.exitCode = 1;
  } else {
    const folder = fromMain ? 'output/design-main' : 'output/design';
    const out = resolve(root, folder);
    mkdirSync(out, { recursive: true });
    const { chromium } = createRequire(`${root}/`)('playwright');
    const browser = await chromium.launch();
    try {
      for (const [file, board] of boards) {
        const widths = board.w <= 500 ? [board.w] : [1440, 700];
        for (const width of widths) {
          const page = await browser.newPage({
            viewport: { width, height: board.h },
          });
          await page.goto(pathToFileURL(resolve(source, 'design/boards', file)).href);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: resolve(out, `${file.replace(/\.html$/, '')}-${width}.png`),
          });
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
    console.log(
      `Rendered ${boards.length} board${boards.length === 1 ? '' : 's'} from ${label} into ${folder}.`,
    );
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
