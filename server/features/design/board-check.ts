// `deploy design check`: a branch's design/ against main. The CLI runs it on the computer, with
// the working copy as the branch; when no browser can start there, deploy.local runs it on a
// private commit the terminal pushed. It names new elements, draws each changed board at its
// widths in its schemes beside main, and looks for problems: content cut off or overflowing
// sideways at 700 px, a layer ID main has that the branch lost, a board missing from canvas.json
// or the reverse, a link to a board that does not exist, low contrast in light or dark, colours
// that are not tokens, boards on top of each other on the canvas, a question answered with a
// made-up fact, and a height the canvas and the board disagree on. Notes are taste and blocks
// nothing: type and spacing off the scale, edges nearly lined up, rows unlike sibling boards', a
// box in a card, a second primary button, layer names that say nothing, a board-local copy of a
// component, open questions and differences from a board's source (see board-quality.ts). Each
// looks only at what the branch changed. A change to a shared part (a component in the design system's library) is one row, with
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
  syncsTo,
  type Library,
} from '../../design/board-html.ts';
import { layerLabel } from '../../../shared/v2/design.ts';
import {
  boardPlatform,
  decodeHtmlText,
  parseBoardMeta,
} from '../../../shared/v2/design-board-meta.ts';
import type { Inspection } from '../../../shared/v2/design-inspect.ts';
import { layerFates } from '../../design/board-layers.ts';
import {
  designSystemFolder,
  designSystemPaths,
  firstFile,
} from '../../../shared/v2/design-system-path.ts';
import { boardOrder, placeBoard } from '../../design/board-placement.ts';
import {
  missingBoardImages,
  type BoardQuestion,
  type ModelSheet,
} from '../../design/check-drawing.ts';
import {
  artGridProblems,
  artPaletteProblems,
  artReadNote,
  artSilhouetteNote,
  type ArtSheet,
} from '../../design/art-checks.ts';
import { modelFindings } from '../../design/model-checks.ts';
import {
  contrastProblems,
  cutOffBottomProblems,
  cutOffSideProblems,
  textCollisionProblems,
  drawnNotes,
  heightProblem,
  inlineStyleNotes,
  layerNameNote,
  localCopyNotes,
  notATokenProblems,
  overlapProblems,
  questionFindings,
  statedClaims,
  unflaggedClaimsNote,
  readTokens,
  boardSchemes,
  schemeDroppedProblem,
  schemePinnedProblems,
  removedLayersNote,
  boardContent,
  boardSimilarity,
  distinctiveWords,
  editedInstanceProblems,
  isSpecimen,
  noteOverlapProblems,
  phoneMappings,
  specimenNote,
  styleLines,
  screenFamily,
  sourceNotes,
  spacingNotes,
  settleFindings,
  type Finding,
} from '../../design/board-quality.ts';
import { reviewWidths, screenName } from '../../../shared/v2/design-review.ts';
import {
  boardFrame,
  drawSteps,
  platformInfo,
  platformSchemes,
  printGeometry,
  type DrawStep,
  type PairLayout,
  type Scheme,
} from '../../../shared/v2/design-platforms.ts';
import {
  fixedHeight,
  isImmersive,
  logoGroundNote,
  logoSmallNote,
  markLegibility,
  pageBreakNotesFromPages,
  shortLastPageNote,
  type LogoGround,
  type LogoMarks,
  type StrandedHeading,
  measuredHeightProblem,
  pageBreakNotes,
  phoneScreen,
  safeAreaProblems,
  logoCutProblems,
  screenSafeAreaProblems,
  smallContrast,
  statusBarNote,
  tallerThanFrameProblem,
} from '../../design/kind-checks.ts';
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
  /** For a new board that names no source: the board on main it was judged against. */
  comparedWith?: string;
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

/**
 * A model board whose model changed: "Model Crate changed", ahead of what changed on the board
 * itself, if anything. Null for any other board.
 */
export function modelWords(before: string | null, after: string | null, changed: Set<unknown>) {
  if (!before || !after) return null;
  const model = parseBoardMeta(after).other.model;
  if (!model || !changed.has(model)) return null;
  const words = boardWords(before, after);
  return words === 'No visible change'
    ? `Model ${model} changed`
    : `Model ${model} changed · ${words}`;
}

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
  const problems: { code: string; file: string; label: string; detail: string }[] = [];
  const onCanvas = new Set(branch.canvas);
  const onDisk = new Set(branch.disk);
  const mainCanvas = new Set(main.canvas);
  const mainDisk = new Set(main.disk);
  for (const file of branch.disk)
    if (!onCanvas.has(file) && !(mainDisk.has(file) && !mainCanvas.has(file)))
      problems.push({
        code: 'not_on_canvas',
        file,
        label: `${file} is not on the canvas`,
        detail: 'add it to canvas.json',
      });
  for (const file of branch.canvas)
    if (!onDisk.has(file) && !(mainCanvas.has(file) && !mainDisk.has(file)))
      problems.push({
        code: 'canvas_only',
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
/** deploy.local's own component library, where the Design page and local-design read it. */
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
      syncsTo(before, after, library),
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
          code: 'part_carried',
          file: row.file,
          fix: 'deploy design check --drop-instances',
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

/** One side of a pair: a board drawn at a commit, with what the check measured there. */
export type CheckShot = {
  png: Buffer;
  measured: Overflow | null;
  inspected?: Inspection | null;
  /** The questions marked on the picture, by their badges' numbers. */
  questions?: BoardQuestion[];
  /** A document's printed sheets, one picture each, as the browser printed them. */
  pages?: Buffer[];
  /** The headings that end a printed sheet with nothing after them on it. */
  stranded?: StrandedHeading[];
  /** A logo's mark drawn from the mark itself at each size. */
  marks?: LogoMarks | null;
  /** A logo board's grounds labelled for one fixed ground, with the colour drawn. */
  grounds?: LogoGround[];
  /** A sprite sheet's palette, grounds and sprites at play size. */
  art?: ArtSheet | null;
  /** A model board's model, its box and budget and what its build measured. */
  model?: ModelSheet | null;
};
export type CheckDrawing = {
  /**
   * A board at a commit and width, in a scheme; measured for what leaves the page only when
   * `measure` is set, inspected for contrast and taste only when `inspect` is set.
   */
  shoot(input: {
    commit: string;
    file: string;
    width: number;
    height: number;
    scheme: 'light' | 'dark';
    measure: boolean;
    inspect?: boolean;
    /** Device pixels per CSS pixel (a print piece is drawn at 8 px/mm). */
    scale?: number;
    /** Draw with the page's print styles (a document's printed pages). */
    media?: 'print';
    /** Picture the whole page, however tall (a document), not just the window. */
    fullPage?: boolean;
    /** Also print the page on this paper and picture each sheet (a document's printed pages). */
    printed?: { paperWidth: number; paperHeight: number };
    /** Also draw the mark itself at true size, and read the grounds labelled for one colour. */
    logo?: boolean;
    /** Also read a sprite sheet and draw each sprite at play size on each ground. */
    art?: boolean;
    /** Also read a model board's model and draw its box over each picture of it. */
    model?: boolean;
  }): Promise<CheckShot | null>;
  /** Before and after side by side, captioned, as one PNG. */
  pair(input: {
    before: Buffer | null;
    after: Buffer;
    width: number;
    height: number;
    scheme: 'light' | 'dark';
    /** The After's questions, listed beside it, never over the board. */
    questions?: BoardQuestion[];
    /** Pages, a print piece's guides or a sheet of sizes, when the picture is more than a screen. */
    layout?: PairLayout;
    /** The printed sheets themselves, when the browser printed them. */
    beforePages?: Buffer[];
    afterPages?: Buffer[];
    /** The mark drawn from the mark itself, when it could be. */
    beforeMarks?: LogoMarks | null;
    afterMarks?: LogoMarks | null;
    /** A sprite sheet's sprites at play size, when they could be drawn. */
    beforeArt?: ArtSheet | null;
    afterArt?: ArtSheet | null;
    /** Captions in place of Before and After: a print proof's Front and Back. */
    labels?: { before: string; after: string };
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
  /** What blocks: each with a stable code, where it is and a fix. */
  problems: CheckProblem[];
  /** Taste and open questions: blocks nothing. */
  notes: CheckProblem[];
  pairs: string;
  /** Boards whose new elements got layer IDs, as they read now, for the terminal to write. */
  layers: Record<string, string>;
  /** Carried boards to put back, from the commit each comes back from (with drop). */
  restore: { commit: string; files: string[] }[];
  /** Boards whose canvas and meta heights disagree, with the height drawn: what --fix writes. */
  heights: Record<string, number>;
  /** Boards whose new, meaningless layer IDs --fix names again, as they would read. */
  renames: Record<string, string>;
  /** Boards with no place on the canvas or a bad one, and the free place --fix puts them. */
  places: Record<
    string,
    {
      x: number;
      y: number;
      w: number;
      h: number;
      /** The board it was put beside, and on which side; null when it went under the rest. */
      near: string | null;
      side: string;
      /** Why it needed a place: the problem's short words. */
      why: string;
    }
  >;
  /** Canvas entries whose board file is gone: what --fix takes off the canvas. */
  removed: string[];
  /** Boards whose canvas title differs from the title in the board: what --fix writes to the canvas. */
  titles: Record<string, string>;
  /** Before and after, named <Board>-<width>-<scheme>.png, as base64. */
  pictures: { name: string; png: string }[];
};

/** How many boards the check has drawn so far, of those it will draw. */
export type CheckProgress = { drawn: number; total: number };

/** Boards drawn at once; each waits for the drawing queue, which keeps Chromium's slots. */
export const checkConcurrency = 6;

/** Sibling boards drawn from main to compare list rows with, at most, per changed board. */
export const siblingLimit = 3;

/**
 * Checks a commit's design/ against main. `commit` is the working copy (a pushed commit, or
 * whatever the CLI's reader takes for the folder); `base` is main. `systemFile` gives the design
 * system's files (by their path under design/) for a project that has none of its own.
 */
export async function checkDesign(
  input: {
    commit: string;
    base: string;
    baseRef?: string;
    drop?: boolean;
    folder?: string;
    systemFile?: (path: string) => string | null;
  },
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
  // A model changed in design/models/ changes every board that shows it.
  const changedModels = new Set(
    paths
      .map(
        (path) =>
          new RegExp(`^${folder}/models/([A-Za-z0-9_-]+)\\.(?:py|glb|gltf|blend)$`).exec(path)?.[1],
      )
      .filter(Boolean),
  );
  if (changedModels.size) {
    for (const file of disk)
      if (!files.includes(file) && changedModels.has(parseBoardMeta(await after(file)).other.model))
        files.push(file);
    files.sort();
  }
  const mainTexts = new Map<string, Promise<string | null>>();
  const onMain = (file: string) => {
    if (!mainTexts.has(file)) mainTexts.set(file, show(base, `${folder}/boards/${file}`));
    return mainTexts.get(file)!;
  };

  // The project's own design system: the one canvas.json names, else the single one in ds/. Only
  // deploy.local's own falls back to the copy the CLI carries; another project's never does.
  const dsFolders = ((await git.read(['ls-tree', '--name-only', `${commit}:${folder}/ds`])) ?? '')
    .split('\n')
    .filter((name) => name && !/\.[a-z]+$/i.test(name));
  const dsFolder = designSystemFolder(canvas, dsFolders);
  const dsPaths = dsFolder ? designSystemPaths(dsFolder) : null;
  // The schemes the project says every board draws (canvas.json "schemes"); each platform has
  // its own default otherwise: light and dark, light for a slide or a printed piece.
  // An open canvas (no design system) draws light unless the project or the board asks for more.
  const openCanvas = !dsFolder;
  const canvasSchemes: Scheme[] | null = Array.isArray(canvas?.schemes)
    ? canvas.schemes.filter((scheme: unknown) => scheme === 'light' || scheme === 'dark')
    : openCanvas
      ? ['light']
      : null;
  const placedWidth = (file: string, at: 'branch' | 'main' = 'branch') =>
    Number((at === 'branch' ? canvas : mainCanvas)?.boards?.[file]?.w) || undefined;
  /** The schemes a board of this text draws unless its head says: its platform's. */
  const requiredSchemes = (html: string | null, file: string, at: 'branch' | 'main' = 'branch') =>
    platformSchemes(
      boardPlatform(parseBoardMeta(html), placedWidth(file, at)),
      openCanvas ? canvasSchemes : null,
    );
  const systemFile = async (candidates: string[] | undefined) =>
    candidates
      ? ((
          await firstFile(candidates, async (path) => {
            const own = await show(commit, `${folder}/${path}`);
            if (own !== null) return own;
            return dsFolder === 'ds/deploy-local' ? (input.systemFile?.(path) ?? null) : null;
          })
        )?.text ?? null)
      : null;
  // A kind's type scale lives in its own stylesheet (doc.css, slides.css …) beside tokens.css.
  const kindCss = dsFolder
    ? (
        await Promise.all(
          ((await git.read(['ls-tree', '--name-only', `${commit}:${folder}/${dsFolder}`])) ?? '')
            .split('\n')
            .filter((name) => /\.css$/.test(name) && !/^(tokens|components)\.css$/.test(name))
            .map((name) => show(commit, `${folder}/${dsFolder}/${name}`)),
        )
      )
        .filter(Boolean)
        .join('\n')
    : '';
  const baseCss = await systemFile(dsPaths?.tokensCss);
  const tokens = readTokens(
    await systemFile(dsPaths?.tokensJson),
    kindCss ? `${baseCss ?? ''}\n${kindCss}` : baseCss,
  );
  const bundle = await systemFile(dsPaths?.bundle);
  // The classes the design system's stylesheets define, for what a board's <style> block redefines.
  const systemClasses = new Set(
    [baseCss, kindCss, bundle]
      .flatMap((css) =>
        [...(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(
          (match) => match[1],
        ),
      )
      .filter((name) => !/^\d/.test(name)),
  );
  const branchLibrary = parseLibrary(await systemFile(dsPaths?.library));
  // The values the design system's own samples show (its examples and library): a board copied
  // from them is the kit's sample, not a figure the agent made up.
  const examplesFolder = dsPaths ? `${folder}/${dsPaths.examples}` : null;
  const exampleTexts = examplesFolder
    ? await Promise.all(
        ((await git.read(['ls-tree', '--name-only', `${commit}:${examplesFolder}`])) ?? '')
          .split('\n')
          .filter((name) => name.endsWith('.html'))
          .map((name) => show(commit, `${examplesFolder}/${name}`)),
      )
    : [];
  // The brief, kept in design/brief.md, gives its own figures: those are the product's, not made up.
  const brief = await show(commit, `${folder}/brief.md`);
  const sampleValues = new Set(
    [...exampleTexts, await systemFile(dsPaths?.library), brief].flatMap((text) =>
      text ? statedClaims(text.replace(/<[^>]+>/g, ' ')) : [],
    ),
  );
  // Where the library is, for a change to a component.
  let ownLibrary = '';
  for (const path of dsPaths?.library ?? [])
    if (
      (await show(commit, `${folder}/${path}`)) !== null ||
      (await show(base, `${folder}/${path}`)) !== null
    ) {
      ownLibrary = `${folder}/${path}`;
      break;
    }

  // A component the branch changed is one row, with the screens that show it. Boards the branch
  // carries only because their instances were drawn again are left to the landing, which draws
  // every instance again from main's boards: drop puts them back.
  const drop = Boolean(input.drop);
  const parts: { part: { id: string; name: string }; shown: number; carried: number }[] = [];
  const carried = new Map<string, string>();
  let dropped = 0;
  const restore: CheckResult['restore'] = [];
  if (ownLibrary && paths.includes(ownLibrary)) {
    const library = parseLibrary(await show(commit, ownLibrary));
    const changed = changedComponents(parseLibrary(await show(forkedAt, ownLibrary)), library);
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
      const onMainBoards = (
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
      const shown = new Set([...onMainBoards, ...holding]);
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

  // New elements get layer IDs; existing IDs are kept. What became of main's IDs is judged on
  // the board as written, before naming, so an element left with no ID shows as such. On an open
  // canvas the designer names the layers that matter and nothing is named for them: a hundred
  // made-up names are noise they would only rename.
  let named = 0;
  const layers: Record<string, string> = {};
  const written = new Map<string, string | null>();
  for (const file of own) {
    const html = await after(file);
    written.set(file, html);
    if (html === null || openCanvas) continue;
    const next = assignLayerIds(html);
    if (next !== html) {
      named += layerIds(next).length - layerIds(html).length;
      layers[file] = next;
      texts.set(file, next);
    }
  }

  const problems: CheckProblem[] = [];
  const notes: CheckProblem[] = [];
  const comparedWith = new Map<string, string>();
  // The boards a board's schemes are compared with: its screen, else the boards sharing its first
  // word (DesignComment with the other Design boards).
  const schemeSiblings = (file: string) => {
    const family = screenFamily(file, disk);
    if (family.length) return family;
    const word = /^[A-Z][a-z0-9]+/.exec(file)?.[0];
    return word
      ? disk.filter((other) => other !== file && new RegExp(`^${word}(?![a-z])`).test(other))
      : [];
  };
  // Phone boards by the board their head says they were drawn from, read once when needed.
  let phoneSourceIndex: Map<string, string[]> | null = null;
  const phoneSources = async () => {
    if (!phoneSourceIndex) {
      phoneSourceIndex = new Map();
      for (const other of disk.filter((entry) => /Phone\.html$/.test(entry))) {
        const from = parseBoardMeta(await after(other)).source;
        if (from) phoneSourceIndex.set(from, [...(phoneSourceIndex.get(from) ?? []), other]);
      }
    }
    return phoneSourceIndex;
  };
  const renames: Record<string, string> = {};
  const originOf = new Map<string, string>();
  /**
   * The board on main a new one is most like: most of its own style lines, by one git grep, then
   * the closest of the best few by styles and classes. Null when nothing is close.
   */
  const similarOnMain = async (file: string, text: string) => {
    const lines = [...new Set(styleLines(text))].sort((a, b) => b.length - a.length).slice(0, 40);
    if (lines.length < 3) return null;
    const counts = (
      (await git.read([
        'grep',
        '-c',
        '-F',
        ...lines.flatMap((line) => ['-e', line]),
        base,
        '--',
        `${folder}/boards`,
      ])) ?? ''
    )
      .split('\n')
      .map((line) => /\/([^/:]+\.html):(\d+)$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match) && match![1] !== file)
      .map((match) => ({ file: match[1], count: Number(match[2]) }))
      .filter((entry) => entry.count >= Math.max(3, lines.length * 0.3))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
    let best: { file: string; score: number } | null = null;
    for (const entry of counts) {
      const score = boardSimilarity(text, await onMain(entry.file));
      if (!best || score > best.score) best = { file: entry.file, score };
    }
    return best && best.score >= 0.3 ? best.file : null;
  };
  // Whether the product's own code says a string (the server's wording, an app label): then it is
  // the product's words, not a specimen's. Asked of main, once per string.
  const productWords = new Map<string, Promise<boolean>>();
  const inProductCode = (word: string) => {
    if (!productWords.has(word))
      productWords.set(
        word,
        git
          .read([
            'grep',
            '-l',
            '-F',
            '-e',
            word,
            base,
            '--',
            'app',
            'server',
            'shared',
            'native/Apple',
          ])
          .then((out) => Boolean(out?.trim())),
      );
    return productWords.get(word)!;
  };
  // Distinctive words on the design system's specimen boards, read once.
  let specimens: Map<string, string> | null = null;
  const specimenTexts = new Map<string, string | null>();
  for (const file of mainDisk.filter(isSpecimen)) specimenTexts.set(file, await onMain(file));
  const specimenWords = () => {
    if (!specimens) {
      specimens = new Map();
      for (const [file, html] of specimenTexts)
        for (const word of distinctiveWords(html))
          if (!specimens.has(word)) specimens.set(word, file);
    }
    return specimens;
  };
  // A component no screen shows yet (a new project's whole kit, a part added for a board still
  // to come) changes nothing anyone sees: one line says how many, not a "0 screens" row each.
  const partRows = parts
    .filter((entry) => entry.shown || entry.carried)
    .map((entry) => {
      const { row, problems: carriedProblems } = partRow(entry.part, entry.shown, entry.carried);
      problems.push(...carriedProblems);
      return row;
    });
  const unshown = parts.filter((entry) => !entry.shown && !entry.carried);
  // A library new on this branch (a new project's kit) is all "new": saying so is noise.
  const libraryIsNew = Boolean(ownLibrary) && (await show(forkedAt, ownLibrary)) === null;
  if (unshown.length && !libraryIsNew)
    partRows.push({
      file: 'part:unshown',
      title: unshown.length === 1 ? unshown[0].part.name : 'Components',
      status: 'part',
      words:
        unshown.length === 1
          ? 'on no screen yet'
          : `${unshown.length} new or changed, on no screen yet`,
    });
  const boardRows: CheckBoardRow[] = [];
  // Heights to measure for --fix: boards whose canvas and meta disagree.
  const measureHeight = new Set<string>();
  for (const file of own) {
    const text = await after(file);
    const before = await onMain(file);
    // The board's name, as the boards and the review's list name it; a canvas title is a sentence.
    const title = screenName(file);
    // Comments and pins point at layer IDs, so one main has must survive while its element does.
    const removed: string[] = [];
    // The board init placed to start from is the kit's example: nobody has commented on its IDs,
    // so its sprites, sets and blocks take the project's own names.
    const kitStart = mainCanvas?.startingBoard === file;
    for (const entry of kitStart ? [] : layerFates(before, written.get(file) ?? text)) {
      if (entry.fate === 'removed') removed.push(entry.layer);
      else if (entry.fate === 'renamed')
        problems.push({
          code: 'layer_renamed',
          file,
          board: title,
          layer: entry.layer,
          label: `${title} renamed layer ${entry.layer} to ${entry.to}`,
          detail: 'comments and pins on deploy.local point at the old ID',
          short: `renamed ${entry.layer}`,
          fix: `keep the ID ${entry.layer} on ${entry.to}: move data-layer="${entry.layer}" onto the new element`,
        });
      else
        problems.push({
          code: 'lost_layer',
          file,
          board: title,
          layer: entry.layer,
          label: `${title} lost layer ${entry.layer}`,
          detail: 'the element is still drawn, with no ID',
          short: `lost layer ${entry.layer}`,
          fix: `put data-layer="${entry.layer}" back on the element`,
        });
    }
    const removedNote = removedLayersNote({ file, title, layers: removed });
    if (removedNote) notes.push(removedNote);
    for (const to of text ? brokenLinks(text, disk) : [])
      problems.push({
        code: 'broken_link',
        file,
        board: title,
        label: `${title} links to ${to}`,
        detail: 'no board has that name',
        short: `links to ${to}`,
        fix: `link to a board that exists, or add ${to}`,
      });
    for (const src of text
      ? await missingBoardImages(text, async (path) => {
          // Listed in its folder: works on a commit and on the working copy alike.
          const at = path.lastIndexOf('/');
          const dir = at < 0 ? folder : `${folder}/${path.slice(0, at)}`;
          const names = await git.read(['ls-tree', '--name-only', `${commit}:${dir}`]);
          return (names ?? '').split('\n').includes(path.slice(at + 1));
        })
      : [])
      problems.push({
        code: 'image_missing',
        file,
        board: title,
        label: `${title} shows a picture that is not there: ${src}`,
        detail: 'it draws broken',
        short: `missing ${src.split('/').pop()}`,
        fix: 'commit the picture under design/ and point src at it from boards/ (../art/cat.png), or use a data: URL',
      });
    if (text) {
      const meta = parseBoardMeta(text);
      // A new board is judged against the board it came from: the one its head names, else the
      // board on main it is most like (a copy keeps its chrome and styles).
      let from = !before ? (meta.source ?? meta.copiedFrom ?? meta.replaces) : null;
      if (!before && !from) {
        from = await similarOnMain(file, text);
        if (from) comparedWith.set(file, from);
      }
      if (from === file) from = null;
      if (from) originOf.set(file, from);
      const origin = from ? ((await after(from)) ?? (await onMain(from))) : null;
      const board = { file, title, before, after: text };
      // Taste is judged against main's board, or the board this one came from.
      const baseline = { ...board, before: before ?? origin };
      problems.push(...notATokenProblems({ ...board, tokens, library: branchLibrary, origin }));
      problems.push(...editedInstanceProblems({ ...board, library: branchLibrary }));
      // Every scheme its source or siblings draw, and no page pinned to one.
      const platformDefault = requiredSchemes(text, file);
      // What the project asks of every board: canvas.json's schemes, else the platform's own.
      const projectSchemes = platformSchemes(boardPlatform(meta, placedWidth(file)), canvasSchemes);
      const schemes = boardSchemes(meta, platformDefault);
      const mainSchemes = before
        ? boardSchemes(parseBoardMeta(before), requiredSchemes(before, file, 'main')).join(' ')
        : null;
      // Every board draws its platform's schemes (canvas.json "schemes" overrides them; light and
      // dark unless the platform says otherwise); a board that leaves one out is a problem of its own.
      const missing = projectSchemes.filter((scheme) => !schemes.includes(scheme));
      if (missing.length && schemes.join(' ') !== mainSchemes)
        problems.push({
          code: 'missing_scheme',
          file,
          board: title,
          label: `${title} is not drawn in ${missing.join(' or ')}`,
          detail: `its head says schemes=${schemes.join(' ')}; this project draws ${projectSchemes.join(' and ')}`,
          short: `no ${missing.join(' or ')}`,
          fix: `take schemes= out of its head (or list ${projectSchemes.join(' ')}) and draw it with tokens, so ${missing.join(' and ')} reads too`,
        });
      else if (schemes.join(' ') !== mainSchemes && schemes.length < 2) {
        const drawnFrom = meta.source ?? meta.copiedFrom;
        const fromText = drawnFrom && drawnFrom !== file ? await after(drawnFrom) : null;
        const platform = boardPlatform(meta, Number(canvas?.boards?.[file]?.w) || undefined);
        const siblings: { file: string; schemes: string[] }[] = [];
        if (!fromText)
          for (const sibling of schemeSiblings(file)) {
            const html = await after(sibling);
            const siblingMeta = parseBoardMeta(html);
            if (
              html &&
              boardPlatform(siblingMeta, Number(canvas?.boards?.[sibling]?.w) || undefined) ===
                platform
            )
              siblings.push({
                file: sibling,
                schemes: boardSchemes(siblingMeta, requiredSchemes(html, sibling)),
              });
          }
        const narrower = schemeDroppedProblem({
          file,
          title,
          schemes,
          from: fromText
            ? {
                file: drawnFrom!,
                schemes: boardSchemes(
                  parseBoardMeta(fromText),
                  requiredSchemes(fromText, drawnFrom!),
                ),
              }
            : null,
          siblings,
        });
        if (narrower) problems.push(narrower);
      }
      problems.push(...schemePinnedProblems(board));
      const asked = questionFindings(board);
      problems.push(...asked.problems);
      notes.push(...asked.notes);
      const unflagged = unflaggedClaimsNote({ ...board, samples: sampleValues });
      if (unflagged) notes.push(unflagged);
      // Only names the board was written with: the check's own names are its job, not the agent's.
      const nameProblem = layerNameNote({ ...baseline, after: written.get(file) ?? text });
      // --fix never replaces an ID the author wrote; it only names elements that have none.
      if (nameProblem) problems.push(nameProblem);
      notes.push(
        ...spacingNotes({ ...baseline, tokens, platform: boardPlatform(meta, placedWidth(file)) }),
      );
      notes.push(...inlineStyleNotes({ ...baseline, systemClasses }));
      if (platformInfo(boardPlatform(meta, placedWidth(file))).appChecks)
        notes.push(...localCopyNotes({ ...board, bundle, library: branchLibrary, origin }));
      if (!isSpecimen(file)) {
        const old = new Set(distinctiveWords(before ?? origin));
        const borrowed = new Map<string, string[]>();
        for (const word of distinctiveWords(text)) {
          const specimen = specimenWords().get(word);
          if (!specimen || old.has(word)) continue;
          const elsewhere = (
            (await git.read(['grep', '-l', '-F', '-e', word, base, '--', `${folder}/boards`])) ?? ''
          )
            .split('\n')
            .filter(Boolean)
            .map((line) => line.slice(line.lastIndexOf('/') + 1))
            .filter((other) => !isSpecimen(other) && other !== file);
          if (elsewhere.length || (await inProductCode(word))) continue;
          borrowed.set(specimen, [...(borrowed.get(specimen) ?? []), word]);
        }
        for (const [specimen, words] of borrowed) {
          const note = specimenNote({ file, title, words, specimen });
          if (note) notes.push(note);
        }
      }
      if (meta.source && meta.source !== file) {
        // A link on the source to a web board is answered by a link here to its phone
        // counterpart: a board drawn from it, or its name with Phone.
        const counterparts: Record<string, string[]> = {};
        const drawnFrom = await phoneSources();
        const mapped = phoneMappings((await systemFile(dsPaths?.readme)) ?? null, disk);
        for (const link of boardContent(await after(meta.source)).links) {
          const phoneName = `${link.replace(/\.html$/, '')}Phone.html`;
          const found = [
            ...new Set([
              ...(disk.includes(phoneName) ? [phoneName] : []),
              ...(drawnFrom.get(link) ?? []),
              ...(mapped[link] ?? []),
            ]),
          ];
          if (found.length) counterparts[link] = found;
        }
        const compared = sourceNotes({
          ...board,
          source: meta.source,
          sourceAfter: await after(meta.source),
          sourceBefore: await onMain(meta.source),
          counterparts,
        });
        problems.push(...compared.filter((finding) => finding.code === 'source_action_missing'));
        notes.push(...compared.filter((finding) => finding.code !== 'source_action_missing'));
      }
      const height = heightProblem({
        file,
        title,
        canvasHeight: Number(canvas?.boards?.[file]?.h) || undefined,
        metaHeight: meta.height,
        mainCanvasHeight: Number(mainCanvas?.boards?.[file]?.h) || undefined,
        mainMetaHeight: parseBoardMeta(before).height,
      });
      if (height) {
        problems.push(height);
        measureHeight.add(file);
      }
    }
    // A board gone because another of the branch's boards replaces it says so.
    let replacedBy: string | null = null;
    if (!text)
      for (const other of own)
        if (other !== file && parseBoardMeta(await after(other)).replacesAll?.includes(file)) {
          replacedBy = other;
          break;
        }
    boardRows.push({
      file,
      title,
      status: !before ? 'new' : !text ? 'removed' : 'changed',
      words: replacedBy
        ? `replaced by ${screenName(replacedBy)}`
        : comparedWith.has(file)
          ? `${boardWords(before, text)}, judged against ${screenName(comparedWith.get(file)!)}`
          : (modelWords(before, text, changedModels) ?? boardWords(before, text)),
      ...(comparedWith.has(file) ? { comparedWith: comparedWith.get(file) } : {}),
    });
  }
  // Parts first: one change, however many screens show it.
  const boards = [...partRows, ...boardRows];
  for (const problem of canvasProblems(
    { disk, canvas: Object.keys(canvas?.boards ?? {}) },
    { disk: mainDisk, canvas: Object.keys(mainCanvas?.boards ?? {}) },
  ))
    problems.push({ ...problem, short: problem.label.slice(problem.file.length + 1) });
  problems.push(...overlapProblems(canvas, mainCanvas));
  problems.push(...noteOverlapProblems(canvas, mainCanvas));

  // Where --fix puts a board with no place or a bad one: beside the board it came from. Each place
  // is taken before the next is found, so two new boards never land on one spot.
  const places: CheckResult['places'] = {};
  const placing = { ...canvas, boards: { ...canvas?.boards } };
  const canvasOrder: string[] = Array.isArray(canvas?.order) ? canvas.order : [];
  // In the order they are read, so a deck's or a card's boards go in a row as they run, and
  // canvas.json's order gets them in that order too.
  for (const file of [...own].sort((a, b) => boardOrder(a, b, canvasOrder))) {
    const text = await after(file);
    if (text === null) continue;
    // A board the agent placed stays where it is unless it covers a board, a note or a title.
    const why = problems.find(
      (problem) =>
        problem.file === file &&
        ['boards_overlap', 'board_overlaps_note', 'not_on_canvas'].includes(problem.code ?? ''),
    );
    if (!why) continue;
    const meta = parseBoardMeta(text);
    const frame = boardFrame(
      boardPlatform(meta, Number(placing.boards[file]?.w) || undefined),
      meta,
      placing.boards[file] ?? {},
    );
    const size = { w: frame.width, h: frame.height ?? 900 };
    // Beside the board it came from; else, for a kind that is drawn in runs (slides, a card's
    // sides, a deck of game screens), in a row with the boards of its kind, in their order; else
    // beside a board of the same screen already placed.
    const platform = boardPlatform(meta, Number(placing.boards[file]?.w) || undefined);
    const sameKind: string[] = [];
    if (!['web', 'phone'].includes(platform))
      for (const other of Object.keys(placing.boards)) {
        if (other === file) continue;
        const otherText = await after(other);
        if (
          otherText &&
          boardPlatform(
            parseBoardMeta(otherText),
            Number(placing.boards[other]?.w) || undefined,
          ) === platform
        )
          sameKind.push(other);
      }
    const placedSibling = screenFamily(
      file,
      Object.keys(placing.boards).filter(
        (other) => other !== file && (!own.includes(other) || other in places),
      ),
    )[0];
    const spot = placeBoard({
      canvas: placing,
      file,
      size,
      near: originOf.get(file) ?? (sameKind.length ? null : placedSibling) ?? null,
      siblings: sameKind,
      order: canvasOrder,
    });
    places[file] = {
      x: spot.x,
      y: spot.y,
      ...size,
      near: spot.near,
      side: spot.side,
      why:
        why.code === 'not_on_canvas'
          ? 'it was not on the canvas'
          : why.code === 'boards_overlap'
            ? `it was ${why.short}`
            : `it ${why.short.replace(/^covers/, 'covered')}`,
    };
    placing.boards[file] = { ...placing.boards[file], x: spot.x, y: spot.y, ...size };
    const where = spot.near
      ? `${spot.side === 'below' ? 'below' : `${spot.side} of`} ${spot.near}`
      : spot.x === 0 && spot.y === 0
        ? 'first on the canvas'
        : 'under the rest of the canvas';
    for (const problem of problems)
      if (problem.file === file)
        if (['boards_overlap', 'board_overlaps_note', 'not_on_canvas'].includes(problem.code ?? ''))
          problem.fix = `deploy design check --fix places it at x ${spot.x}, y ${spot.y}, ${where}`;
  }

  // Canvas entries with no board file go; a canvas title that is not the board's own is updated.
  const removed = problems
    .filter((problem) => problem.code === 'canvas_only')
    .map((problem) => problem.file as string);
  const titles: Record<string, string> = {};
  for (const file of own) {
    const entry = canvas?.boards?.[file];
    const text = await after(file);
    if (!entry || text === null) continue;
    const written =
      parseBoardMeta(text).title ?? /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    const said = written ? decodeHtmlText(written) : written;
    if (said && entry.title !== said) titles[file] = said;
  }

  // The platform of a board, from its head or its width, for sizes and siblings.
  const platformOf = async (at: 'branch' | 'main', file: string) =>
    boardPlatform(
      parseBoardMeta(at === 'branch' ? await after(file) : await onMain(file)),
      Number((at === 'branch' ? canvas : mainCanvas)?.boards?.[file]?.w) || undefined,
    );

  // Each of the branch's own boards beside main's, at its widths in its schemes. Several boards
  // are drawn at once (the drawing queue decides how many reach Chromium); results keep the
  // boards' order, and the first failure stops the boards not yet started.
  const overflow: Record<string, { after: Overflow; before: Overflow | null; width: number }> = {};
  const drawnFindings: Record<string, { problems: Finding[]; notes: Finding[] }> = {};
  const heights: Record<string, number> = {};
  const usedSchemes = new Set<string>();
  const drawnWidths = new Map<string, number[]>();
  // Platforms whose bottom edge is no phone screen: a document scrolls, a card and a mark have no
  // bars to hide text under.
  const noBottomFrame = new Set(['doc', 'print', 'logo', 'art', 'model']);
  // Each print face as drawn on this branch in light, for the front and back proof.
  const printFaces = new Map<
    string,
    { png: Buffer; width: number; height: number; layout: DrawStep['layout'] }
  >();
  const drawBoard = async (file: string) => {
    const placed = canvas?.boards?.[file];
    const text = await after(file);
    if (text === null) return null;
    const meta = parseBoardMeta(text);
    const platform = boardPlatform(meta, Number(placed?.w) || undefined);
    const info = platformInfo(platform);
    const steps: DrawStep[] = drawSteps(platform, meta, placed ?? {});
    drawnWidths.set(file, [...new Set(steps.map((step) => step.width))]);
    const mainHas = (await onMain(file)) !== null;
    const name = file.replace(/\.html$/, '');
    const title = screenName(file);
    const schemes: Scheme[] =
      meta.schemes ?? platformSchemes(platform, openCanvas ? canvasSchemes : null);
    const shots: CheckResult['pictures'] = [];
    const found = { problems: [] as Finding[], notes: [] as Finding[] };
    // A logo's pictures, whose pixels say whether the mark shows at 16 px.
    const logoPictures: {
      scheme: Scheme;
      png: Buffer;
      marks: LogoMarks | null;
      grounds: LogoGround[];
    }[] = [];
    let inspectedOnce = false;
    for (const planned of steps) {
      let step = planned;
      if (planned.mode === 'pages' && planned.layout?.kind === 'pages') {
        // A sheet leaves its @page margin round the text: draw the text as wide as that leaves.
        const probe = await drawing.shoot({
          commit,
          file,
          width: planned.width,
          height: 100,
          scheme: 'light',
          measure: false,
          inspect: true,
          media: 'print',
          fullPage: true,
        });
        const margin = probe?.inspected?.pageMargin;
        if (margin)
          step = {
            ...planned,
            width: Math.max(200, Math.round(planned.width - margin.left - margin.right)),
            layout: { ...planned.layout, margin },
          };
      }
      const { width } = step;
      // A page as tall as its content is drawn in a short window and pictured whole.
      // A sheet's window is its text area, so what print pins to the margins (a running head and
      // foot) falls outside the stretch each sheet shows.
      const height =
        step.height ??
        (step.layout?.kind === 'pages'
          ? Math.max(
              100,
              Math.round(
                step.layout.pageHeight -
                  (step.layout.margin?.top ?? 0) -
                  (step.layout.margin?.bottom ?? 0),
              ),
            )
          : 100);
      const stepSchemes: Scheme[] = step.schemes ?? schemes;
      for (const scheme of stepSchemes) {
        usedSchemes.add(scheme);
        const measure = step.measure && scheme === 'light';
        const inspect = step.inspect;
        const draw = {
          width,
          height,
          scheme,
          measure,
          inspect,
          ...(step.scale !== 1 ? { scale: step.scale } : {}),
          ...(step.media ? { media: step.media } : {}),
          ...(step.height === null ? { fullPage: true } : {}),
          ...(step.mode === 'pages' && step.layout?.kind === 'pages'
            ? {
                printed: {
                  paperWidth: step.layout.pageWidth,
                  paperHeight: step.layout.pageHeight,
                },
              }
            : {}),
          ...(platform === 'logo' ? { logo: true } : {}),
          ...(platform === 'art' ? { art: true } : {}),
          ...(platform === 'model' ? { model: true } : {}),
        };
        const shot = (at: string) => drawing.shoot({ commit: at, file, ...draw });
        // A new board's taste is judged against the board it came from, drawn from main.
        const origin = originOf.get(file);
        const [afterShot, beforeShot] = await Promise.all([
          shot(commit),
          mainHas
            ? shot(base)
            : inspect && origin && mainDisk.includes(origin)
              ? drawing.shoot({ commit: base, file: origin, ...draw })
              : null,
        ]);
        if (!afterShot) continue;
        if (afterShot.measured) {
          overflow[file] = {
            after: afterShot.measured,
            before: beforeShot?.measured ?? null,
            width,
          };
        }
        if (platform === 'logo')
          logoPictures.push({
            scheme,
            png: afterShot.png,
            marks: afterShot.marks ?? null,
            grounds: afterShot.grounds ?? [],
          });
        // A smallest type size the brief states, written in the head as min-text=28 or 11pt.
        if (inspect && afterShot.inspected && scheme === stepSchemes[0]) {
          const small = textUnderMinimum(meta.other['min-text'], afterShot.inspected.texts);
          if (small)
            found.problems.push({
              code: 'text_too_small',
              file,
              board: title,
              ...(small.layers.length === 1 && !small.layers[0].startsWith('"')
                ? { layer: small.layers[0] }
                : {}),
              label: `${title} sets text at ${small.smallest} px`,
              detail: `its head asks for at least ${small.minimum} px (min-text=${meta.other['min-text']}): ${small.layers.slice(0, 4).join(', ')}${small.layers.length > 4 ? ` and ${small.layers.length - 4} more` : ''}`,
              short: `${small.smallest} px text`,
              fix: 'make that text bigger, or cut it, or change min-text= if the brief allows smaller',
            });
        }
        if (inspect && afterShot.inspected && step.mode === 'pages') {
          // A last sheet of a few lines, from the sheets as printed.
          if (
            scheme === stepSchemes[0] &&
            step.layout?.kind === 'pages' &&
            afterShot.pages?.length
          ) {
            const short = shortLastPageNote({
              file,
              title,
              pages: afterShot.pages,
              margin: step.layout.margin,
              pageHeight: step.layout.pageHeight,
            });
            if (short) found.notes.push(short);
            // Words that run on past their sheet and print over the next one: the pages are laid
            // out for print here, so this is the only place that sees it.
            found.problems.push(
              ...textCollisionProblems({
                file,
                title,
                width,
                after: { ...afterShot.inspected, spills: [] },
                before: beforeShot?.inspected ? { ...beforeShot.inspected, spills: [] } : null,
              }),
            );
            // A page count the brief states, written in the head as pages=4.
            const limit = Number(meta.other.pages);
            if (limit > 0 && afterShot.pages.length > limit)
              found.problems.push({
                code: 'over_page_limit',
                file,
                board: title,
                label: `${title} prints on ${afterShot.pages.length} pages`,
                detail: `its head allows ${limit} (pages=${limit})`,
                short: `${afterShot.pages.length} of ${limit} pages`,
                fix: 'cut or tighten until it fits, or change pages= if the brief allows more',
              });
          }
          // Printed pages: where the sheets break, nothing else read twice.
          if (scheme === stepSchemes[0] && step.layout?.kind === 'pages' && afterShot.pages?.length)
            // The sheets as the browser printed them: where they really end.
            found.notes.push(
              ...pageBreakNotesFromPages({
                file,
                title,
                stranded: afterShot.stranded ?? [],
                inspection: afterShot.inspected,
              }),
            );
          else if (scheme === stepSchemes[0] && step.layout?.kind === 'pages')
            found.notes.push(
              ...pageBreakNotes({
                file,
                title,
                inspection: afterShot.inspected,
                pageHeight:
                  step.layout.pageHeight -
                  (step.layout.margin?.top ?? 0) -
                  (step.layout.margin?.bottom ?? 0),
              }),
            );
        } else if (inspect && afterShot.inspected) {
          const inspected = { after: afterShot.inspected, before: beforeShot?.inspected ?? null };
          found.problems.push(
            ...contrastProblems({ file, title, width, scheme, tokens, ...inspected }),
          );
          if (scheme === stepSchemes[0] && !inspectedOnce) {
            inspectedOnce = true;
            const content = afterShot.inspected.height;
            if (platform === 'doc') {
              // A document is as tall as it reads: measured, never the frame it was given.
              const declared = [meta.height, Number(placed?.h) || null];
              if (declared.some((value) => value !== content)) heights[file] = content;
              const differs = measuredHeightProblem({
                file,
                title,
                measured: content,
                canvasHeight: Number(placed?.h) || undefined,
                metaHeight: meta.height,
              });
              if (differs) found.problems.push(differs);
            } else if (measureHeight.has(file)) {
              // The canvas and the head disagree: what is right is what the board needs, in a
              // window too short to give its height back.
              const natural = await drawing.shoot({
                commit,
                file,
                ...draw,
                height: 100,
                measure: false,
                inspect: true,
                fullPage: false,
              });
              // Never less than the content needs: a window-sized frame or an absolutely placed
              // layer is no shorter for the short window it was measured in.
              heights[file] = fixedHeight({
                platform,
                fixedFrame: info.fixedFrame,
                metaHeight: meta.height,
                natural: natural?.inspected?.height ?? content,
                needed: Math.max(natural?.inspected?.needed ?? 0, afterShot.inspected.needed ?? 0),
              });
            }
            if (info.fixedFrame && platform !== 'doc') {
              const tall = tallerThanFrameProblem({ file, title, content, frame: height });
              if (tall) found.problems.push(tall);
            }
            if (phoneScreen(platform, width, height)) {
              const immersive = isImmersive(meta);
              found.problems.push(
                ...screenSafeAreaProblems({
                  file,
                  title,
                  inspection: afterShot.inspected,
                  platform,
                  width,
                  height,
                  immersive,
                }),
              );
              const bar = statusBarNote({
                file,
                title,
                inspection: afterShot.inspected,
                platform,
                width,
                height,
                immersive,
              });
              if (bar) found.notes.push(bar);
            }
            if (platform === 'logo')
              found.problems.push(
                ...logoCutProblems({
                  file,
                  title,
                  inspection: afterShot.inspected,
                  width,
                  height: height ?? width,
                }),
              );
            if (platform === 'art' && afterShot.art) {
              const art = afterShot.art;
              found.problems.push(
                ...artGridProblems({ file, title, art }),
                ...artPaletteProblems({
                  file,
                  title,
                  art,
                  most: Number(meta.other.palette) || null,
                }),
              );
              for (const note of [
                artReadNote({ file, title, art }),
                artSilhouetteNote({ file, title, art }),
              ])
                if (note) found.notes.push(note);
            }
            if (platform === 'model' && afterShot.model) {
              const model = modelFindings({ file, title, model: afterShot.model });
              found.problems.push(...model.problems);
              found.notes.push(...model.notes);
            }
            if (platform === 'print') {
              const geometry = printGeometry(meta);
              found.problems.push(
                ...safeAreaProblems({
                  file,
                  title,
                  inspection: afterShot.inspected,
                  geometry: { ...geometry, width, height },
                }),
              );
            }
            // Rows are compared with the same lists on sibling boards of this platform, on main.
            const siblings: { file: string; rows: Record<string, number[]> }[] = [];
            if (info.appChecks && Object.keys(afterShot.inspected.rows).length) {
              for (const sibling of screenFamily(file, mainDisk)) {
                if (siblings.length >= siblingLimit) break;
                if ((await platformOf('main', sibling)) !== platform) continue;
                const drawn = await drawing.shoot({
                  commit: base,
                  file: sibling,
                  width,
                  height: Number(mainCanvas?.boards?.[sibling]?.h ?? 900),
                  scheme,
                  measure: false,
                  inspect: true,
                });
                if (drawn?.inspected) siblings.push({ file: sibling, rows: drawn.inspected.rows });
              }
            }
            // Two primaries at once is a problem; the rest of taste is notes.
            for (const finding of drawnNotes({
              file,
              title,
              width,
              tokens,
              platform,
              siblings,
              ...inspected,
            }))
              (finding.code === 'second_primary' ? found.problems : found.notes).push(finding);
            if (!noBottomFrame.has(platform))
              found.problems.push(...cutOffBottomProblems({ file, title, width, ...inspected }));
            if (platform !== 'logo')
              found.problems.push(
                ...cutOffSideProblems({ file, title, width, platform, ...inspected }),
              );
            if (scheme === stepSchemes[0])
              found.problems.push(...textCollisionProblems({ file, title, width, ...inspected }));
          }
        }
        const png = await drawing.pair({
          before: mainHas ? (beforeShot?.png ?? null) : null,
          after: afterShot.png,
          width: step.shown,
          height,
          scheme,
          questions: afterShot.questions ?? [],
          ...(step.layout ? { layout: step.layout } : {}),
          ...(afterShot.pages?.length ? { afterPages: afterShot.pages } : {}),
          ...(mainHas && beforeShot?.pages?.length ? { beforePages: beforeShot.pages } : {}),
          ...(afterShot.marks ? { afterMarks: afterShot.marks } : {}),
          ...(mainHas && beforeShot?.marks ? { beforeMarks: beforeShot.marks } : {}),
          ...(afterShot.art ? { afterArt: afterShot.art } : {}),
          ...(mainHas && beforeShot?.art ? { beforeArt: beforeShot.art } : {}),
        });
        shots.push({ name: `${name}-${step.key}-${scheme}.png`, png: png.toString('base64') });
        if (platform === 'print' && scheme === 'light' && !printFaces.has(file))
          printFaces.set(file, {
            png: afterShot.png,
            width: step.shown,
            height,
            layout: step.layout,
          });
      }
    }
    if (platform === 'logo' && logoPictures.length) {
      const note = logoSmallNote({
        file,
        title,
        size: 16,
        results: logoPictures.flatMap(({ scheme, png, marks }) => {
          try {
            if (marks) {
              const at = (size: number) => marks.sizes.find((entry) => entry.size === size)?.png;
              const big = marks.smallReference ?? at(128);
              const small = at(16);
              if (big && small) {
                const read = markLegibility({
                  big,
                  small,
                  size: 16,
                  ground: marks.ground,
                  ink: marks.ink,
                });
                return [{ scheme, ...read }];
              }
            }
            return [{ scheme, contrast: smallContrast(png, 16).contrast }];
          } catch {
            return [];
          }
        }),
      });
      if (note) found.notes.push(note);
      // A tile labelled for one ground keeps it in both schemes.
      const light = logoPictures.find((entry) => entry.scheme === 'light');
      const dark = logoPictures.find((entry) => entry.scheme === 'dark');
      if (light && dark) {
        const ground = logoGroundNote({
          file,
          title,
          light: light.grounds,
          dark: dark.grounds,
        });
        if (ground) found.notes.push(ground);
      }
    }
    drawnFindings[file] = found;
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
      code: 'not_drawn',
      file: null,
      label: 'Could not draw the boards',
      detail: String(error?.message || error).split('\n')[0],
      short: 'not drawn',
      fix: 'deploy browser install, then run the check again',
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
  // A print piece with a front and a back gets a proof: both faces side by side, as the printer
  // will see them, after the back's own pictures. Faces of different sizes are not one piece.
  for (const [file, front] of printFaces) {
    const stem = /^(.*)Front\.html$/.exec(file)?.[1];
    const back = stem !== undefined ? printFaces.get(`${stem}Back.html`) : undefined;
    if (stem === undefined || !back) continue;
    const trim = (layout: DrawStep['layout']) =>
      layout?.kind === 'print' ? `${layout.trim.w}x${layout.trim.h}` : null;
    if (trim(front.layout) !== trim(back.layout) || front.width !== back.width) continue;
    try {
      const png = await drawing.pair({
        before: front.png,
        after: back.png,
        width: front.width,
        height: front.height,
        scheme: 'light',
        ...(front.layout ? { layout: front.layout } : {}),
        labels: { before: 'Front', after: 'Back' },
      });
      // After whichever face's own pictures come last.
      const faces = [`${stem}Front-`, `${stem}Back-`];
      let at = pictures.length;
      for (let i = pictures.length - 1; i >= 0; i--)
        if (faces.some((face) => pictures[i].name.startsWith(face))) {
          at = i + 1;
          break;
        }
      pictures.splice(at, 0, { name: `${stem}-proof-light.png`, png: png.toString('base64') });
    } catch {
      // A proof that cannot be drawn leaves the faces' own pictures.
    }
  }
  for (const board of boardRows) {
    problems.push(
      ...overflowProblems(
        board.file,
        board.title,
        overflow[board.file],
        overflow[board.file]?.width,
      ),
    );
    problems.push(...(drawnFindings[board.file]?.problems ?? []));
    notes.push(...(drawnFindings[board.file]?.notes ?? []));
  }
  const widths = [...new Set(drawn.flatMap((file) => drawnWidths.get(file) ?? []))].sort(
    (a, b) => b - a,
  );
  // What stops the check on an open canvas: breakage and the limits a board states, not taste.
  const heads = new Map<string, ReturnType<typeof parseBoardMeta>>();
  for (const file of own) heads.set(file, parseBoardMeta(await after(file)));
  const settled = settleFindings(problems, notes, {
    system: !openCanvas,
    stated: (file, key) => Boolean(file && heads.get(file)?.other[key]),
  });
  problems.splice(0, problems.length, ...settled.problems);
  notes.splice(0, notes.length, ...settled.notes);
  for (const board of boards)
    board.problems = problems.filter((problem) => problem.file === board.file).map((p) => p.short);
  return {
    base: { ref: input.baseRef ?? 'main', commit: base },
    named,
    drawn: drawn.length,
    widths,
    schemes: ['light', 'dark'].filter((scheme) => !drawn.length || usedSchemes.has(scheme)),
    seconds: Math.round((clock() - started) / 1000),
    ...(drop ? { dropped } : {}),
    boards,
    problems,
    notes,
    pairs: 'output/design/pairs',
    layers,
    restore,
    heights,
    places,
    removed,
    titles,
    renames,
    pictures,
  };
}

/**
 * Text drawn under a board's min-text= (px, or pt: 11pt is 14.67 px), each layer once. Null when
 * the head sets none or nothing is under it. Half a pixel of rounding is allowed.
 */
export function textUnderMinimum(
  value: string | undefined,
  texts: { layer: string | null; text: string; size: number }[],
): { minimum: number; smallest: number; layers: string[] } | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px|pt)?\s*$/i.exec(value ?? '');
  if (!match) return null;
  const minimum =
    Math.round(Number(match[1]) * (match[2]?.toLowerCase() === 'pt' ? 4 / 3 : 1) * 100) / 100;
  if (!(minimum > 0)) return null;
  const under = texts.filter((text) => text.size < minimum - 0.5);
  if (!under.length) return null;
  const layers: string[] = [];
  for (const text of under) {
    const where = text.layer ?? `"${text.text}"`;
    if (!layers.includes(where)) layers.push(where);
  }
  return {
    minimum,
    smallest: Math.round(Math.min(...under.map((text) => text.size)) * 10) / 10,
    layers,
  };
}
