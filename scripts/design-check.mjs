// Check the design boards this branch changed against main, for `deploy design check`.
//   node scripts/design-check.mjs [--base origin/main] [--folder design]
// Run from the root of a checkout. It gives new elements layer IDs, draws each changed board at
// its widths in light and dark, writes Before (main) and After side by side into
// output/design/pairs, and looks for problems: content cut off or overflowing sideways at 700 px,
// a layer ID main has that the branch lost, a board missing from canvas.json or the reverse, and a
// link to a board that does not exist. A change to a shared part (a component in the design
// system's library) is one row, with the screens that show it; boards the branch carries only
// because their instances were drawn again are a problem, since landing draws them anyway, and
// --drop-instances puts them back as they were on main. It prints one JSON object and exits 1
// while a problem remains.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assignLayerIds,
  boardLinks,
  layerChanges,
  layerIds,
  layerSnippet,
  syncInstances,
} from '../server/design/board-html.ts';
import { layerLabel } from '../shared/v2/design.ts';
import { reviewWidths, screenName } from '../shared/v2/design-review.ts';

/** The boards a list of changed paths names, as file names in <folder>/boards. */
export function changedBoardFiles(paths, folder = 'design') {
  const prefix = `${folder}/boards/`;
  return [
    ...new Set(
      paths
        .filter(
          (path) =>
            path.startsWith(prefix) && /^[A-Za-z0-9_-]+\.html$/.test(path.slice(prefix.length)),
        )
        .map((path) => path.slice(prefix.length)),
    ),
  ].sort();
}

/** Layer IDs main's board has that the branch's board no longer has. */
export function lostLayers(main, branch) {
  if (!main || !branch) return [];
  const kept = new Set(layerIds(branch));
  return [...new Set(layerIds(main))].filter((id) => !kept.has(id));
}

const plainText = (html) =>
  html
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** What changed on a board, in the review's words for its layers: "New Show menu · Title". */
export function boardWords(before, after, limit = 3) {
  if (!before && after) return 'New board';
  if (before && !after) return 'Board removed';
  const changes = layerChanges(before, after);
  if (!changes.length) return 'No visible change';
  const words = changes.map((change) => {
    const label = layerLabel(
      change.layer,
      plainText(layerSnippet(change.change === 'removed' ? before : after, change.layer) ?? ''),
    );
    return change.change === 'added'
      ? `New ${label}`
      : change.change === 'removed'
        ? `${label} removed`
        : label;
  });
  const unique = [...new Set(words)];
  const shown = unique.slice(0, limit);
  return unique.length > limit
    ? `${shown.join(' · ')} · ${unique.length - limit} more`
    : shown.join(' · ');
}

/**
 * Boards on disk that canvas.json does not place, and boards it places with no file. Only what
 * the branch added counts: a mismatch main already has is not this branch's problem.
 */
export function canvasProblems(branch, main = { disk: [], canvas: [] }) {
  const problems = [];
  const onCanvas = new Set(branch.canvas);
  const onDisk = new Set(branch.disk);
  const mainCanvas = new Set(main.canvas);
  const mainDisk = new Set(main.disk);
  for (const file of branch.disk)
    if (!onCanvas.has(file) && !(mainDisk.has(file) && !mainCanvas.has(file)))
      problems.push({
        file,
        label: `${file} is not on the canvas`,
        detail: 'add it to canvas.json',
      });
  for (const file of branch.canvas)
    if (!onDisk.has(file) && !(mainCanvas.has(file) && !mainDisk.has(file)))
      problems.push({
        file,
        label: `${file} is on the canvas only`,
        detail: 'no board file has that name',
      });
  return problems;
}

/** Links from a board to boards that do not exist. */
export function brokenLinks(html, boards) {
  const known = new Set(boards);
  return [...new Set(boardLinks(html).map((link) => link.to))].filter((to) => !known.has(to));
}

/** The design system's components, which boards hold instances of. */
export const libraryPath = 'design/ds/deploy-local/components/library.json';
export function parseLibrary(text) {
  try {
    const library = text ? JSON.parse(text) : null;
    return Array.isArray(library?.components) ? library : null;
  } catch {
    return null;
  }
}

/** The components a branch changed in the library: added, or different in any way. */
export function changedComponents(before, after) {
  if (!after) return [];
  return after.components
    .filter(
      (component) =>
        JSON.stringify(component) !==
        JSON.stringify(before?.components.find((item) => item.id === component.id)),
    )
    .map((component) => ({ id: component.id, name: component.name || component.id }));
}

/**
 * Whether a board's whole change is its instances drawn again from the branch's library: the
 * branch's board is what syncing any of main's versions of it gives. Landing does that itself,
 * so such a board is not a change of the branch's own.
 */
export function instanceOnly(after, befores, library) {
  if (!after || !library) return false;
  return befores.some(
    (before) =>
      before &&
      before !== after &&
      before.includes(' data-component="') &&
      syncInstances(before, library).trimEnd() === after.trimEnd(),
  );
}

/** Whether a board holds an instance of a component. */
export const hasInstance = (html, id) => Boolean(html?.includes(`data-component="${id}"`));

/** How the check names a number of screens. */
export const screens = (count) => `${count} screen${count === 1 ? '' : 's'}`;

/**
 * A changed part as a row of the check's table, with its problem when the branch carries boards
 * that only show it: one line for the part, however many boards.
 */
export function partRow(part, shown, carried) {
  const row = {
    file: `part:${part.id}`,
    part: part.id,
    title: part.name,
    status: 'part',
    words: screens(shown),
  };
  const problems = carried
    ? [
        {
          file: row.file,
          label: `${part.name} is carried on ${screens(carried)}`,
          detail: 'landing draws them; run deploy design check --drop-instances',
          short: `carried on ${screens(carried)}`,
        },
      ]
    : [];
  return { row, problems };
}

/** The widths a board is drawn at: web boards at 1440 and 700, phone boards at their own. */
export const checkWidths = (width) => reviewWidths(width ?? 1440);

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...options,
  }).trimEnd();
}
function tryGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** In the page: the first piece of text that leaves the page sideways, and whether the page scrolls. */
function measureOverflow() {
  const width = document.documentElement.clientWidth;
  const scrolls = document.documentElement.scrollWidth > width + 1;
  let cut = null;
  for (const element of document.body.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || (rect.right <= width + 1 && rect.left >= -1)) continue;
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!own) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    cut = own.slice(0, 40);
    break;
  }
  return { scrolls, cut };
}

/** Playwright from this checkout, or from the main checkout when this is a worktree without node_modules. */
function playwright(root) {
  const main = tryGit(root, ['worktree', 'list', '--porcelain'])
    ?.split('\n')[0]
    .replace(/^worktree /, '');
  for (const place of [root, main].filter(Boolean))
    try {
      return createRequire(`${place}/`)('playwright');
    } catch {
      /* Not installed there. */
    }
  throw new Error('Playwright is not installed in this project');
}

async function draw(root, folder, base, files, canvas, out) {
  const { chromium } = playwright(root);
  const before = mkdtempSync(join(tmpdir(), 'design-check-main-'));
  // Main's design folder, with its design system, so a board's relative links resolve.
  execFileSync('tar', ['-x', '-C', before], {
    input: execFileSync(
      'git',
      ['archive', base, folder, ...(folder === 'design' ? [] : ['design/ds'])],
      {
        cwd: root,
        maxBuffer: 1 << 30,
      },
    ),
  });
  const browser = await chromium.launch();
  const drawn = [];
  const overflow = {};
  try {
    for (const file of files) {
      const after = resolve(root, folder, 'boards', file);
      if (!existsSync(after)) continue;
      const board = canvas?.boards?.[file];
      const height = board?.h ?? 900;
      const main = resolve(before, folder, 'boards', file);
      const name = file.replace(/\.html$/, '');
      for (const width of checkWidths(board?.w)) {
        for (const scheme of ['light', 'dark']) {
          const shoot = async (path) => {
            const page = await browser.newPage({
              viewport: { width, height },
              colorScheme: scheme,
            });
            await page.goto(pathToFileURL(path).href);
            await page.evaluate(() => document.fonts.ready);
            const measured =
              width === 700 && scheme === 'light' ? await page.evaluate(measureOverflow) : null;
            const png = await page.screenshot();
            await page.close();
            return { png, measured };
          };
          const afterShot = await shoot(after);
          const beforeShot = existsSync(main) ? await shoot(main) : null;
          if (afterShot.measured)
            overflow[file] = { after: afterShot.measured, before: beforeShot?.measured ?? null };
          const pair = await browser.newPage({
            viewport: { width: width * 2 + 48, height: height + 64 },
          });
          const image = (shot) =>
            shot
              ? `<img src="data:image/png;base64,${shot.png.toString('base64')}">`
              : '<p>New board · no Before</p>';
          await pair.setContent(
            `<style>body{margin:0;display:flex;gap:16px;padding:16px;font:13px system-ui;background:${scheme === 'dark' ? '#18181b' : '#f4f4f5'};color:${scheme === 'dark' ? '#fafafa' : '#18181b'}}figure{margin:0}figcaption{margin-bottom:8px}img{display:block;border:1px solid #888}p{width:${width}px}</style>` +
              `<figure><figcaption>Before · main · ${width} · ${scheme}</figcaption>${image(beforeShot)}</figure>` +
              `<figure><figcaption>After · this branch · ${width} · ${scheme}</figcaption>${image(afterShot)}</figure>`,
          );
          await pair.screenshot({
            path: join(out, `${name}-${width}-${scheme}.png`),
            fullPage: true,
          });
          await pair.close();
        }
      }
      drawn.push(file);
    }
  } finally {
    await browser.close();
    rmSync(before, { recursive: true, force: true });
  }
  return { drawn, overflow };
}

/** Problems from drawing at 700: only what the branch made, not what main already had. */
export function overflowProblems(file, title, measured) {
  if (!measured) return [];
  const { after, before } = measured;
  if (after.cut && !(before && before.cut === after.cut))
    return [
      {
        file,
        label: `${title} is cut off at 700 px`,
        detail: `"${after.cut}" leaves the page`,
        short: 'cut off at 700 px',
      },
    ];
  if (after.scrolls && !before?.scrolls)
    return [
      {
        file,
        label: `${title} overflows at 700 px`,
        detail: 'the page scrolls sideways',
        short: 'overflows at 700 px',
      },
    ];
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const started = Date.now();
  const root = tryGit(process.cwd(), ['rev-parse', '--show-toplevel']) ?? process.cwd();
  const folder = option('--folder', 'design');
  const baseRef = option('--base', 'origin/main');
  const base = tryGit(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (!base) {
    console.log(JSON.stringify({ error: `No ${baseRef} here. Fetch origin, then check again.` }));
    process.exit(2);
  }
  const forkedAt = tryGit(root, ['merge-base', 'HEAD', base]) ?? base;
  const paths = [
    ...(
      tryGit(root, ['diff', '--name-only', '--no-renames', forkedAt, '--', `${folder}/`]) ?? ''
    ).split('\n'),
    ...(
      tryGit(root, ['ls-files', '--others', '--exclude-standard', '--', `${folder}/`]) ?? ''
    ).split('\n'),
  ].filter(Boolean);
  const files = changedBoardFiles(paths, folder);
  const show = (path) => tryGit(root, ['show', `${base}:${path}`]);
  const readJson = (text) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const canvasPath = resolve(root, folder, 'canvas.json');
  const canvas = existsSync(canvasPath) ? readJson(readFileSync(canvasPath, 'utf8')) : null;
  const mainCanvas = readJson(show(`${folder}/canvas.json`));
  const boardsDir = resolve(root, folder, 'boards');
  const disk = existsSync(boardsDir)
    ? readdirSync(boardsDir).filter((file) => file.endsWith('.html'))
    : [];
  const mainDisk = (tryGit(root, ['ls-tree', '--name-only', `${base}:${folder}/boards`]) ?? '')
    .split('\n')
    .filter((file) => file.endsWith('.html'));

  // A component the branch changed is one row, with the screens that show it. Boards the branch
  // carries only because their instances were drawn again are left to the landing, which draws
  // every instance again from main's boards: --drop-instances puts them back.
  const drop = args.includes('--drop-instances');
  const parts = [];
  const carried = new Map();
  let dropped = 0;
  if (paths.includes(libraryPath)) {
    const fileAt = (commit, path) => tryGit(root, ['show', `${commit}:${path}`]);
    const onDisk = resolve(root, libraryPath);
    const library = parseLibrary(existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : null);
    const changed = changedComponents(parseLibrary(fileAt(forkedAt, libraryPath)), library);
    const texts = new Map();
    if (changed.length)
      for (const file of files) {
        const path = resolve(boardsDir, file);
        const after = existsSync(path) ? readFileSync(path, 'utf8') : null;
        texts.set(file, after);
        // Put back as it was where the branch started, or as main has it now.
        for (const commit of [forkedAt, base]) {
          const before = fileAt(commit, `${folder}/boards/${file}`);
          if (instanceOnly(after, [before], library)) {
            carried.set(file, commit);
            break;
          }
        }
      }
    for (const part of changed) {
      // Counted as landing draws them: every board on main with an instance, and the branch's own.
      const onMain = (
        tryGit(root, [
          'grep',
          '-l',
          '-F',
          `data-component="${part.id}"`,
          base,
          '--',
          `${folder}/boards`,
        ]) ?? ''
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(line.lastIndexOf('/') + 1));
      const shown = new Set([
        ...onMain,
        ...files.filter((file) => hasInstance(texts.get(file), part.id)),
      ]);
      const bringing = [...carried.keys()].filter((file) => hasInstance(texts.get(file), part.id));
      parts.push({ part, shown: shown.size, carried: bringing.length });
    }
    if (drop && carried.size) {
      for (const commit of new Set(carried.values())) {
        const restore = [...carried]
          .filter(([, from]) => from === commit)
          .map(([file]) => `${folder}/boards/${file}`);
        // A few hundred paths at a time, well inside any command line.
        for (let at = 0; at < restore.length; at += 100)
          git(root, ['checkout', commit, '--', ...restore.slice(at, at + 100)]);
      }
      dropped = carried.size;
      for (const entry of parts) entry.carried = 0;
    }
  }
  // The boards that are changes of the branch's own.
  const own = files.filter((file) => !carried.has(file));

  // New elements get layer IDs; existing IDs are kept.
  let named = 0;
  for (const file of own) {
    const path = resolve(boardsDir, file);
    if (!existsSync(path)) continue;
    const html = readFileSync(path, 'utf8');
    const next = assignLayerIds(html);
    if (next !== html) {
      named += layerIds(next).length - layerIds(html).length;
      writeFileSync(path, next);
    }
  }

  const problems = [];
  const partRows = parts.map((entry) => {
    const { row, problems: carriedProblems } = partRow(entry.part, entry.shown, entry.carried);
    problems.push(...carriedProblems);
    return row;
  });
  const boardRows = own.map((file) => {
    const path = resolve(boardsDir, file);
    const after = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const before = show(`${folder}/boards/${file}`);
    // The board's name, as the boards and the review's list name it; a canvas title is a sentence.
    const title = screenName(file);
    for (const layer of lostLayers(before, after))
      problems.push({
        file,
        label: `${title} lost layer ${layer}`,
        detail: 'main has it; keep its ID',
        short: `lost layer ${layer}`,
      });
    for (const to of after ? brokenLinks(after, disk) : [])
      problems.push({
        file,
        label: `${title} links to ${to}`,
        detail: 'no board has that name',
        short: `links to ${to}`,
      });
    return {
      file,
      title,
      status: !before ? 'new' : !after ? 'removed' : 'changed',
      words: boardWords(before, after),
    };
  });
  // Parts first: one change, however many screens show it.
  const boards = [...partRows, ...boardRows];
  for (const problem of canvasProblems(
    { disk, canvas: Object.keys(canvas?.boards ?? {}) },
    { disk: mainDisk, canvas: Object.keys(mainCanvas?.boards ?? {}) },
  ))
    problems.push({ ...problem, short: problem.label.slice(problem.file.length + 1) });

  const out = resolve(root, 'output/design/pairs');
  mkdirSync(out, { recursive: true });
  let drawing = { drawn: [], overflow: {} };
  let drawError = null;
  if (own.length)
    try {
      drawing = await draw(root, folder, base, own, canvas, out);
    } catch (error) {
      drawError = String(error.message || error).split('\n')[0];
      problems.push({
        file: null,
        label: 'Could not draw the boards',
        detail: drawError,
        short: 'not drawn',
      });
    }
  for (const board of boardRows)
    problems.push(...overflowProblems(board.file, board.title, drawing.overflow[board.file]));
  const widths = [
    ...new Set(drawing.drawn.flatMap((file) => checkWidths(canvas?.boards?.[file]?.w))),
  ].sort((a, b) => b - a);
  for (const board of boards)
    board.problems = problems.filter((problem) => problem.file === board.file).map((p) => p.short);
  console.log(
    JSON.stringify({
      base: { ref: baseRef, commit: base },
      named,
      drawn: drawing.drawn.length,
      widths,
      schemes: ['light', 'dark'],
      seconds: Math.round((Date.now() - started) / 1000),
      ...(drop ? { dropped } : {}),
      boards,
      problems,
      pairs: 'output/design/pairs',
    }),
  );
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
