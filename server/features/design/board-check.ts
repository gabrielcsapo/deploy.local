// `deploy design check`, drawn by deploy.local. The terminal pushes its working copy of design/
// as a private commit; this checks that commit against main the way review sees it. It names new
// elements, draws each changed board at its widths in light and dark beside main, and looks for
// problems: content cut off or overflowing sideways at 700 px, a layer ID main has that the branch
// lost, a board missing from canvas.json or the reverse, and a link to a board that does not
// exist. A change to a shared part (a component in the design system's library) is one row, with
// the screens that show it; boards the branch carries only because their instances were drawn
// again are a problem, since landing draws them anyway, and `drop` lists them to put back as they
// were on main. Nothing is written here: the terminal writes the named boards and restores the
// carried ones in its own folder.
import {
  assignLayerIds,
  boardElements,
  boardLinks,
  layerChanges,
  layerIds,
  layerSnippet,
  syncInstances,
  type Library,
} from '../../design/board-html.ts';
import { layerLabel } from '../../../shared/v2/design.ts';
import { reviewWidths, screenName } from '../../../shared/v2/design-review.ts';
import {
  measureOverflow,
  overflowProblems,
  type CheckProblem,
  type Overflow,
} from '../../../shared/v2/design-overflow.ts';

export { measureOverflow, overflowProblems, type CheckProblem, type Overflow };

export type CheckBoardRow = {
  file: string;
  title: string;
  status: string;
  words: string;
  part?: string;
  problems?: string[];
};

/** The boards a list of changed paths names, as file names in <folder>/boards. */
export function changedBoardFiles(paths: string[], folder = 'design') {
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

/** An element's markup without its layer IDs or formatting: the same content gives the same text. */
const signature = (outer: string) =>
  outer
    .replace(/\sdata-layer="[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Layer IDs main's board has that the branch lost while keeping the element. A layer whose ID is
 * gone from the branch is lost when the branch still has its exact markup (layer IDs aside) on an
 * element without one of main's IDs, so the element came back with no ID or another one; otherwise
 * it was removed, and so was everything inside it.
 */
export function lostLayers(main: string | null, branch: string | null) {
  if (!main || !branch) return [];
  const mainIds = new Set(layerIds(main));
  const branchIds = new Set(layerIds(branch));
  // The branch's elements that do not carry one of main's IDs, by their markup.
  const unclaimed = new Map<string, number>();
  for (const element of boardElements(branch))
    if (!element.layer || !mainIds.has(element.layer)) {
      const key = signature(element.outer);
      unclaimed.set(key, (unclaimed.get(key) ?? 0) + 1);
    }
  const lost = new Set<string>();
  const elements = boardElements(main);
  const removed = new Set<number>();
  // Parents come before their children, so a removed container is known before what it held.
  elements.forEach((element, index) => {
    if (removed.has(element.parent)) return void removed.add(index);
    if (!element.layer || branchIds.has(element.layer)) return;
    const key = signature(element.outer);
    const left = unclaimed.get(key) ?? 0;
    if (!left) return void removed.add(index);
    unclaimed.set(key, left - 1);
    lost.add(element.layer);
  });
  return [...lost];
}

const plainText = (html: string) =>
  html
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** What changed on a board, in the review's words for its layers: "New Show menu · Title". */
export function boardWords(before: string | null, after: string | null, limit = 3) {
  if (!before && after) return 'New board';
  if (before && !after) return 'Board removed';
  const changes = layerChanges(before ?? '', after ?? '');
  if (!changes.length) return 'No visible change';
  const words = changes.map((change) => {
    const label = layerLabel(
      change.layer,
      plainText(
        layerSnippet((change.change === 'removed' ? before : after) ?? '', change.layer) ?? '',
      ),
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
export function canvasProblems(
  branch: { disk: string[]; canvas: string[] },
  main: { disk: string[]; canvas: string[] } = { disk: [], canvas: [] },
) {
  const problems: { file: string; label: string; detail: string }[] = [];
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
export function brokenLinks(html: string, boards: string[]) {
  const known = new Set(boards);
  return [...new Set(boardLinks(html).map((link) => link.to))].filter((to) => !known.has(to));
}

/** The design system's components, which boards hold instances of. */
export const libraryPath = 'design/ds/deploy-local/components/library.json';
export function parseLibrary(text: string | null | undefined): Library | null {
  try {
    const library = text ? JSON.parse(text) : null;
    return Array.isArray(library?.components) ? library : null;
  } catch {
    return null;
  }
}

/** The components a branch changed in the library: added, or different in any way. */
export function changedComponents(before: Library | null, after: Library | null) {
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
export function instanceOnly(
  after: string | null,
  befores: (string | null)[],
  library: Library | null,
) {
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
export const hasInstance = (html: string | null | undefined, id: string) =>
  Boolean(html?.includes(`data-component="${id}"`));

/** How the check names a number of screens. */
export const screens = (count: number) => `${count} screen${count === 1 ? '' : 's'}`;

/**
 * A changed part as a row of the check's table, with its problem when the branch carries boards
 * that only show it: one line for the part, however many boards.
 */
export function partRow(part: { id: string; name: string }, shown: number, carried: number) {
  const row: CheckBoardRow = {
    file: `part:${part.id}`,
    part: part.id,
    title: part.name,
    status: 'part',
    words: screens(shown),
  };
  const problems: CheckProblem[] = carried
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
export const checkWidths = (width: number | undefined) => reviewWidths(width ?? 1440);

/** One side of a pair: a board drawn at a commit, with what overflows when measured. */
export type CheckShot = { png: Buffer; measured: Overflow | null };
export type CheckDrawing = {
  /** A board at a commit and width, in a scheme; measured only when `measure` is set. */
  shoot(input: {
    commit: string;
    file: string;
    width: number;
    height: number;
    scheme: 'light' | 'dark';
    measure: boolean;
  }): Promise<CheckShot | null>;
  /** Before and after side by side, captioned, as one PNG. */
  pair(input: {
    before: Buffer | null;
    after: Buffer;
    width: number;
    height: number;
    scheme: 'light' | 'dark';
  }): Promise<Buffer>;
};

export type CheckGit = {
  /** Git's output, or null when it fails. */
  read(args: string[]): Promise<string | null>;
};

export type CheckResult = {
  base: { ref: string; commit: string };
  named: number;
  drawn: number;
  widths: number[];
  schemes: string[];
  seconds: number;
  dropped?: number;
  boards: CheckBoardRow[];
  problems: CheckProblem[];
  pairs: string;
  /** Boards whose new elements got layer IDs, as they read now, for the terminal to write. */
  layers: Record<string, string>;
  /** Carried boards to put back, from the commit each comes back from (with drop). */
  restore: { commit: string; files: string[] }[];
  /** Before and after, named <Board>-<width>-<scheme>.png, as base64. */
  pictures: { name: string; png: string }[];
};

/** How many boards the check has drawn so far, of those it will draw. */
export type CheckProgress = { drawn: number; total: number };

/** Boards drawn at once; each waits for the drawing queue, which keeps Chromium's slots. */
export const checkConcurrency = 6;

/**
 * Checks a commit's design/ against main. `commit` is the terminal's working copy; `base` is
 * main as deploy.local has it.
 */
export async function checkDesign(
  input: { commit: string; base: string; baseRef?: string; drop?: boolean; folder?: string },
  git: CheckGit,
  drawing: CheckDrawing,
  clock = Date.now,
  progress?: (state: CheckProgress) => void,
): Promise<CheckResult> {
  const started = clock();
  const { commit, base } = input;
  const folder = input.folder ?? 'design';
  const forkedAt = (await git.read(['merge-base', commit, base])) || base;
  const paths = (
    (await git.read([
      'diff',
      '--name-only',
      '--no-renames',
      forkedAt,
      commit,
      '--',
      `${folder}/`,
    ])) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  const files = changedBoardFiles(paths, folder);
  const show = (at: string, path: string) => git.read(['show', `${at}:${path}`]);
  const readJson = (text: string | null) => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const canvas = readJson(await show(commit, `${folder}/canvas.json`));
  const mainCanvas = readJson(await show(base, `${folder}/canvas.json`));
  const listBoards = async (at: string) =>
    ((await git.read(['ls-tree', '--name-only', `${at}:${folder}/boards`])) ?? '')
      .split('\n')
      .filter((file) => file.endsWith('.html'));
  const disk = await listBoards(commit);
  const mainDisk = await listBoards(base);
  const texts = new Map<string, string | null>();
  const after = async (file: string) => {
    if (!texts.has(file)) texts.set(file, await show(commit, `${folder}/boards/${file}`));
    return texts.get(file) ?? null;
  };

  // A component the branch changed is one row, with the screens that show it. Boards the branch
  // carries only because their instances were drawn again are left to the landing, which draws
  // every instance again from main's boards: drop puts them back.
  const drop = Boolean(input.drop);
  const parts: { part: { id: string; name: string }; shown: number; carried: number }[] = [];
  const carried = new Map<string, string>();
  let dropped = 0;
  const restore: CheckResult['restore'] = [];
  if (paths.includes(libraryPath)) {
    const library = parseLibrary(await show(commit, libraryPath));
    const changed = changedComponents(parseLibrary(await show(forkedAt, libraryPath)), library);
    if (changed.length)
      for (const file of files) {
        const text = await after(file);
        // Put back as it was where the branch started, or as main has it now.
        for (const from of [forkedAt, base]) {
          if (instanceOnly(text, [await show(from, `${folder}/boards/${file}`)], library)) {
            carried.set(file, from);
            break;
          }
        }
      }
    for (const part of changed) {
      // Counted as landing draws them: every board on main with an instance, and the branch's own.
      const onMain = (
        (await git.read([
          'grep',
          '-l',
          '-F',
          `data-component="${part.id}"`,
          base,
          '--',
          `${folder}/boards`,
        ])) ?? ''
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(line.lastIndexOf('/') + 1));
      const holding: string[] = [];
      for (const file of files) if (hasInstance(await after(file), part.id)) holding.push(file);
      const shown = new Set([...onMain, ...holding]);
      const bringing = [...carried.keys()].filter((file) => holding.includes(file));
      parts.push({ part, shown: shown.size, carried: bringing.length });
    }
    if (drop && carried.size) {
      for (const from of new Set(carried.values()))
        restore.push({
          commit: from,
          files: [...carried].filter(([, at]) => at === from).map(([file]) => file),
        });
      dropped = carried.size;
      for (const entry of parts) entry.carried = 0;
    }
  }
  // The boards that are changes of the branch's own.
  const own = files.filter((file) => !carried.has(file));

  // New elements get layer IDs; existing IDs are kept.
  let named = 0;
  const layers: Record<string, string> = {};
  for (const file of own) {
    const html = await after(file);
    if (html === null) continue;
    const next = assignLayerIds(html);
    if (next !== html) {
      named += layerIds(next).length - layerIds(html).length;
      layers[file] = next;
      texts.set(file, next);
    }
  }

  const problems: CheckProblem[] = [];
  const partRows = parts.map((entry) => {
    const { row, problems: carriedProblems } = partRow(entry.part, entry.shown, entry.carried);
    problems.push(...carriedProblems);
    return row;
  });
  const boardRows: CheckBoardRow[] = [];
  for (const file of own) {
    const text = await after(file);
    const before = await show(base, `${folder}/boards/${file}`);
    // The board's name, as the boards and the review's list name it; a canvas title is a sentence.
    const title = screenName(file);
    for (const layer of lostLayers(before, text))
      problems.push({
        file,
        label: `${title} lost layer ${layer}`,
        detail: 'main has it; keep its ID',
        short: `lost layer ${layer}`,
      });
    for (const to of text ? brokenLinks(text, disk) : [])
      problems.push({
        file,
        label: `${title} links to ${to}`,
        detail: 'no board has that name',
        short: `links to ${to}`,
      });
    boardRows.push({
      file,
      title,
      status: !before ? 'new' : !text ? 'removed' : 'changed',
      words: boardWords(before, text),
    });
  }
  // Parts first: one change, however many screens show it.
  const boards = [...partRows, ...boardRows];
  for (const problem of canvasProblems(
    { disk, canvas: Object.keys(canvas?.boards ?? {}) },
    { disk: mainDisk, canvas: Object.keys(mainCanvas?.boards ?? {}) },
  ))
    problems.push({ ...problem, short: problem.label.slice(problem.file.length + 1) });

  // Each of the branch's own boards beside main's, at its widths in light and dark. Several boards
  // are drawn at once (the drawing queue decides how many reach Chromium); results keep the
  // boards' order, and the first failure stops the boards not yet started.
  const overflow: Record<string, { after: Overflow; before: Overflow | null }> = {};
  const drawBoard = async (file: string) => {
    const placed = canvas?.boards?.[file];
    if ((await after(file)) === null) return null;
    const height = Number(placed?.h ?? 900);
    const onMain = (await show(base, `${folder}/boards/${file}`)) !== null;
    const name = file.replace(/\.html$/, '');
    const shots: CheckResult['pictures'] = [];
    for (const width of checkWidths(placed?.w)) {
      for (const scheme of ['light', 'dark'] as const) {
        const measure = width === 700 && scheme === 'light';
        const shot = (at: string) =>
          drawing.shoot({ commit: at, file, width, height, scheme, measure });
        const [afterShot, beforeShot] = await Promise.all([
          shot(commit),
          onMain ? shot(base) : null,
        ]);
        if (!afterShot) continue;
        if (afterShot.measured)
          overflow[file] = { after: afterShot.measured, before: beforeShot?.measured ?? null };
        const png = await drawing.pair({
          before: beforeShot?.png ?? null,
          after: afterShot.png,
          width,
          height,
          scheme,
        });
        shots.push({ name: `${name}-${width}-${scheme}.png`, png: png.toString('base64') });
      }
    }
    return shots;
  };
  const results: (CheckResult['pictures'] | null | undefined)[] = new Array(own.length);
  let finished = 0;
  progress?.({ drawn: 0, total: own.length });
  try {
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < own.length) {
        const at = next++;
        try {
          results[at] = await drawBoard(own[at]);
        } catch (error) {
          failed = true;
          throw error;
        }
        progress?.({ drawn: ++finished, total: own.length });
      }
    };
    const workers = Array.from({ length: Math.min(checkConcurrency, own.length) }, worker);
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((entry) => entry.status === 'rejected');
    if (rejected) throw (rejected as PromiseRejectedResult).reason;
  } catch (error: any) {
    problems.push({
      file: null,
      label: 'Could not draw the boards',
      detail: String(error?.message || error).split('\n')[0],
      short: 'not drawn',
    });
  }
  // A board counts as drawn when it finished, in the order the boards were listed.
  const drawn: string[] = [];
  const pictures: CheckResult['pictures'] = [];
  own.forEach((file, at) => {
    if (!results[at]) return;
    drawn.push(file);
    pictures.push(...results[at]!);
  });
  for (const board of boardRows)
    problems.push(...overflowProblems(board.file, board.title, overflow[board.file]));
  const widths = [...new Set(drawn.flatMap((file) => checkWidths(canvas?.boards?.[file]?.w)))].sort(
    (a, b) => b - a,
  );
  for (const board of boards)
    board.problems = problems.filter((problem) => problem.file === board.file).map((p) => p.short);
  return {
    base: { ref: input.baseRef ?? 'main', commit: base },
    named,
    drawn: drawn.length,
    widths,
    schemes: ['light', 'dark'],
    seconds: Math.round((clock() - started) / 1000),
    ...(drop ? { dropped } : {}),
    boards,
    problems,
    pairs: 'output/design/pairs',
    layers,
    restore,
    pictures,
  };
}
