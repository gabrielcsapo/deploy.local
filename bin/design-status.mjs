// `deploy design status` and `deploy design guide`: where to start a board and how to work here,
// read from the project's own files (design/, its design system and README) and from Git, which
// is only read. Nothing here calls deploy.local, so both work offline and in a sandbox.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardPlatform, parseBoardMeta } from '../shared/v2/design-board-meta.ts';
import {
  boardFrame,
  designKinds,
  drawSteps,
  drawnAt,
  kindPlatform,
  platformInfo,
  platformSchemes,
  stepWidths,
} from '../shared/v2/design-platforms.ts';
import {
  boardQuestions,
  boardSimilarity,
  checkCodes,
  onlyWithSystem,
  stopsOnOpenCanvas,
  readTokens,
  screenBase,
  screenFamily,
} from '../server/design/board-quality.ts';
import { designSystemFolder, designSystemPaths } from '../shared/v2/design-system-path.ts';

const readOnly = { GIT_OPTIONAL_LOCKS: '0' };

/** The size keys a head of each platform names, for the guide's example head. */
const boardSizeKeys = {
  mac: ',width=1280,height=800',
  slide: ',width=1920,height=1080',
  doc: ',page=a4',
  print: ',size=85x55mm,bleed=3mm,safe=4mm',
  game: ',device=phone,width=390,height=844',
  logo: ',width=1024,height=1024',
  art: ',width=1280,height=960,tile=16',
  model: ',width=1280,height=720,model=<Name>,size=1x1x1,tris=500',
};

/**
 * A file under design/: the project's own. Only deploy.local's own design system (ds/deploy-local)
 * falls back to the copy the CLI carries; no other project gets deploy.local's.
 */
function designText(top, path, designSystem) {
  const full = join(top, 'design', path);
  if (existsSync(full)) return readFileSync(full, 'utf8');
  return /^ds\/(deploy-local\/|README\.md$)/.test(path) &&
    existsSync(join(top, 'design', 'ds', 'deploy-local'))
    ? (designSystem?.(path)?.toString() ?? null)
    : null;
}

/** The project's design system folder under design/ ("ds/larder"), or null when it has none. */
export function projectDesignSystem(top, canvas) {
  let folders = [];
  try {
    folders = readdirSync(join(top, 'design', 'ds'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    folders = [];
  }
  return designSystemFolder(canvas, folders);
}

/** The first of a design system's files for a role that exists, as text. */
const systemText = (top, paths, designSystem) => {
  for (const path of paths ?? []) {
    const text = designText(top, path, designSystem);
    if (text !== null) return text;
  }
  return null;
};

/** "PipelineRun.html" from "PipelineRun", "PipelineRun.html" or "design/boards/PipelineRun.html". */
export const boardFileName = (name) =>
  `${String(name)
    .replace(/^.*\//, '')
    .replace(/\.html$/, '')}.html`;

/** Every board's head and place: what status and guide read. */
export function readDesign(top, designSystem) {
  const boardsDir = join(top, 'design', 'boards');
  const files = existsSync(boardsDir)
    ? readdirSync(boardsDir)
        .filter((file) => /^[A-Za-z0-9_-]+\.html$/.test(file))
        .sort()
    : [];
  let canvas = null;
  try {
    canvas = JSON.parse(designText(top, 'canvas.json') ?? 'null');
  } catch {
    canvas = null;
  }
  const boards = new Map();
  for (const file of files) {
    const html = readFileSync(join(boardsDir, file), 'utf8');
    const meta = parseBoardMeta(html);
    const placed = canvas?.boards?.[file];
    const platform = boardPlatform(meta, Number(placed?.w) || meta.width || 1440);
    const frame = boardFrame(platform, meta, placed ?? {});
    boards.set(file, {
      file,
      html,
      meta,
      placed,
      platform,
      width: frame.width,
      height: frame.height ?? 900,
    });
  }
  // A board is replaced when another's head says replaces=<it>.
  const replacedBy = new Map();
  for (const board of boards.values())
    for (const old of board.meta.replacesAll ?? [])
      if (old !== board.file) replacedBy.set(old, board.file);
  // The project's own design system, never deploy.local's unless this is deploy.local.
  const ds = projectDesignSystem(top, canvas);
  const paths = ds ? designSystemPaths(ds) : null;
  let library = null;
  try {
    library = JSON.parse(systemText(top, paths?.library, designSystem) ?? 'null');
  } catch {
    library = null;
  }
  const tokensJsonText = systemText(top, paths?.tokensJson, designSystem);
  let tokensCss = systemText(top, paths?.tokensCss, designSystem);
  // A kind's type scale lives in its own stylesheet beside tokens.css.
  try {
    const kindCss = ds
      ? readdirSync(join(top, 'design', ds))
          .filter((name) => /\.css$/.test(name) && !/^(tokens|components)\.css$/.test(name))
          .map((name) => readFileSync(join(top, 'design', ds, name), 'utf8'))
          .join('\n')
      : '';
    if (kindCss) tokensCss = `${tokensCss ?? ''}\n${kindCss}`;
  } catch {
    // No such folder.
  }
  const tokens = readTokens(tokensJsonText, tokensCss);
  let tokensJson = null;
  try {
    tokensJson = JSON.parse(tokensJsonText ?? 'null');
  } catch {
    tokensJson = null;
  }
  const readme = systemText(top, paths?.readme, designSystem);
  let examples = [];
  try {
    examples = paths
      ? readdirSync(join(top, 'design', paths.examples))
          .filter((file) => file.endsWith('.html'))
          .map((file) => `design/${paths.examples}/${file}`)
      : [];
  } catch {
    examples = [];
  }
  return {
    files,
    boards,
    canvas,
    kind: typeof canvas?.kind === 'string' && designKinds[canvas.kind] ? canvas.kind : 'app',
    replacedBy,
    library,
    tokens,
    tokensJson,
    ds,
    paths,
    readme,
    examples,
    hasDesign: existsSync(join(top, 'design')),
  };
}

/** The board that is current for one that was replaced, following replaces= to the end. */
function currentOf(file, replacedBy) {
  let at = file;
  const seen = new Set();
  while (replacedBy.has(at) && !seen.has(at)) {
    seen.add(at);
    at = replacedBy.get(at);
  }
  return at;
}

const platformOfName = (file, kind = 'app') =>
  /Phone\.html$/.test(file)
    ? 'phone'
    : /(Pad|Tablet)\.html$/.test(file)
      ? 'tablet'
      : /Mac\.html$/.test(file)
        ? 'mac'
        : /TV\.html$/.test(file)
          ? 'tv'
          : kindPlatform(kind);

/** Branches on origin, other than main and this one, that change a file since they left main. */
function otherBranches(top, git, main, paths) {
  const run = (args) => {
    try {
      return git(args, top, readOnly);
    } catch {
      return null;
    }
  };
  const here = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const refs = (
    run([
      'for-each-ref',
      '--format=%(refname:short)\t%(committerdate:unix)\t%(authorname)',
      'refs/remotes/origin',
    ]) ?? ''
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(
      ([ref]) =>
        ref !== `origin/${main}` &&
        ref !== 'origin/HEAD' &&
        ref !== 'origin' &&
        ref !== upstream &&
        ref !== `origin/${here}`,
    );
  const found = new Map();
  for (const [ref, time, author] of refs) {
    const changed = run(['diff', '--name-only', `origin/${main}...${ref}`, '--', ...paths]);
    for (const path of (changed ?? '').split('\n').filter(Boolean)) {
      const list = found.get(path) ?? [];
      list.push({ branch: ref.replace(/^origin\//, ''), by: author, at: Number(time) * 1000 });
      found.set(
        path,
        list.sort((a, b) => b.at - a.at),
      );
    }
  }
  return found;
}

/** The boards this branch changed against origin/main, in the folder as it is. */
export function changedBoards(top, git, main) {
  const run = (args) => {
    try {
      return git(args, top, readOnly);
    } catch {
      return null;
    }
  };
  const base = run(['merge-base', 'HEAD', `origin/${main}`]);
  const tracked = base ? run(['diff', '--name-only', base, '--', 'design/boards/']) : null;
  const untracked = run(['ls-files', '--others', '--exclude-standard', '--', 'design/boards/']);
  return [
    ...new Set(
      [tracked, untracked]
        .join('\n')
        .split('\n')
        .filter((path) => /^design\/boards\/[A-Za-z0-9_-]+\.html$/.test(path))
        .map((path) => path.slice('design/boards/'.length))
        .filter((file) => existsSync(join(top, 'design', 'boards', file))),
    ),
  ].sort();
}

const ago = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

/**
 * The design system's conventions for phone screens: the lines of the section titled "Phone
 * screens" in design/ds/README.md, when it has one.
 */
export function phoneConventions(top, designSystem) {
  let canvas = null;
  try {
    canvas = JSON.parse(designText(top, 'canvas.json') ?? 'null');
  } catch {
    canvas = null;
  }
  const ds = projectDesignSystem(top, canvas);
  const readme = (ds && systemText(top, designSystemPaths(ds).readme, designSystem)) ?? '';
  const match = /^(#{2,4})\s+Phone screens\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(
    readme,
  );
  if (!match) return null;
  const lines = match[2]
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
  return lines.length ? lines : null;
}

const camelWords = (name) =>
  (name.replace(/\.html$/, '').match(/[A-Z0-9][a-z0-9]*|[a-z0-9]+/g) ?? []).map((word) =>
    word.toLowerCase(),
  );

/**
 * The board a name that is no board's means: "DesignPage" is the Design boards' section, and its
 * first current board on that platform (DesignCanvas). Boards starting with the name's first
 * word are grouped by the section title above them; the section with most of them wins, or the
 * one whose title has the name's other words.
 */
export function resolveScreen(file, design, current = () => true) {
  const words = camelWords(file).filter((word) => word !== 'phone');
  if (!words.length) return null;
  const platform = platformOfName(file);
  const prefix = file.replace(/\.html$/, '').match(/^[A-Z0-9][a-z0-9]*/)?.[0];
  const titles = Object.values(design.canvas?.notes ?? {})
    .filter((note) => /^title/.test(note.kind ?? '') && Number.isFinite(Number(note.y)))
    .sort((a, b) => Number(b.y) - Number(a.y));
  const sectionOf = (board) =>
    titles.find(
      (note) =>
        Number(note.y) <= Number(board.placed?.y) && Number(note.x) <= Number(board.placed?.x) + 1,
    )?.text ?? '';
  const candidates = [...design.boards.values()].filter(
    (board) =>
      prefix &&
      board.file.startsWith(prefix) &&
      board.platform === platform &&
      current(board.file) &&
      board.placed,
  );
  if (!candidates.length) return null;
  const sections = new Map();
  for (const board of candidates) {
    const section = sectionOf(board);
    sections.set(section, [...(sections.get(section) ?? []), board]);
  }
  const rest = words.slice(1);
  const score = ([title, boards]) =>
    rest.filter((word) => title.toLowerCase().includes(word)).length * 1000 + boards.length;
  const [, boards] = [...sections].sort((a, b) => score(b) - score(a))[0];
  boards.sort(
    (a, b) => Number(a.placed.y) - Number(b.placed.y) || Number(a.placed.x) - Number(b.placed.x),
  );
  return boards[0].file;
}

/**
 * The board to copy for a new one on a platform: the current board there of the same kind
 * (detail or list) whose own counterpart on the source's platform is most like the source (for
 * a phone run screen drawn from the web PipelineRun, the phone detail board of the web screen
 * most like PipelineRun).
 */
export function closestStructure(platform, source, design, current = () => true) {
  const sourceBoard = source ? design.boards.get(source) : null;
  if (!sourceBoard) return null;
  // A detail screen (a way back) is copied from a detail screen, a list from a list.
  const detail = (html) => /\bdl-crumbs\b|aria-label="Back"/.test(html);
  const kind = detail(sourceBoard.html);
  let best = null;
  for (const board of design.boards.values()) {
    if (board.platform !== platform || !current(board.file) || board.file === source) continue;
    if (detail(board.html) !== kind) continue;
    const counterpart = design.boards.get(`${screenBase(board.file)}.html`);
    if (!counterpart || counterpart.platform !== sourceBoard.platform) continue;
    const score = boardSimilarity(counterpart.html, sourceBoard.html);
    if (!best || score > best.score) best = { file: board.file, score };
  }
  return best?.file ?? null;
}

/**
 * What status says about each board: its platform and sizes, whether it is current, its source,
 * its siblings, open questions and other branches changing it; for a name with no board, the
 * current boards to start from.
 */
export function designStatus({
  top,
  git,
  main = 'main',
  names = [],
  designSystem,
  now = Date.now(),
}) {
  const design = readDesign(top, designSystem);
  const asked = names.length ? names.map(boardFileName) : changedBoards(top, git, main);
  const branches = otherBranches(
    top,
    git,
    main,
    asked.map((file) => `design/boards/${file}`),
  );
  const current = (file) => !design.replacedBy.has(file);
  const components = (design.library?.components ?? []).map((component) => ({
    id: component.id,
    name: component.name,
    group: component.group,
  }));
  const boards = asked.map((file) => {
    const board = design.boards.get(file);
    if (!board) {
      // No board yet: the current boards of the same screen, on this platform first, then the
      // others, which the new board takes as its source.
      // A name with no platform in it (no Phone, Mac…) is the kind's own platform; in an app whose
      // boards are all phone boards, a new one is a phone board too, and the line says how to ask.
      const named = platformOfName(file, design.kind) !== kindPlatform(design.kind);
      const allPhone =
        design.files.length > 0 &&
        design.files.every((other) => design.boards.get(other)?.platform === 'phone');
      const platform =
        !named && design.kind === 'app' && allPhone ? 'phone' : platformOfName(file, design.kind);
      const family = screenFamily(file, design.files).filter(current);
      const same = family.filter((other) => design.boards.get(other)?.platform === platform);
      const other = family.filter((entry) => !same.includes(entry));
      const base = `${screenBase(file)}.html`;
      const source = other.includes(base) ? base : (other[0] ?? null);
      // A name that is no board's: the board its words point at, by section and title.
      const means = family.length ? null : resolveScreen(file, design, current);
      const copyFrom = means ?? same[0] ?? closestStructure(platform, source, design, current);
      const templates = components.filter(
        (component) =>
          component.group === 'Page templates' &&
          (platform === 'phone' ? /-phone$/.test(component.id) : !/-phone$/.test(component.id)),
      );
      return {
        file,
        exists: false,
        platform,
        ...(!named && design.kind === 'app' ? { platformFromName: false } : {}),
        sizes: stepWidths(drawSteps(platform, parseBoardMeta(null), {})),
        drawnAt: drawnAt(platform, parseBoardMeta(null), {}),
        startFrom: same.slice(0, 5),
        ...(means ? { means } : {}),
        copyFrom,
        source,
        sourceOn: source ? design.boards.get(source)?.platform : null,
        templates: templates.map((component) => component.id),
        // A project's first board starts from its design system's examples, if any.
        ...(design.files.length
          ? {}
          : {
              // Examples of this platform first.
              examples: [...design.examples].sort(
                (a, b) =>
                  Number(platformOfName(b.split('/').pop(), design.kind) === platform) -
                  Number(platformOfName(a.split('/').pop(), design.kind) === platform),
              ),
              ds: design.ds,
            }),
        ...(platform === 'phone' && phoneConventions(top, designSystem)
          ? { conventions: phoneConventions(top, designSystem) }
          : {}),
        otherBranches: branches.get(`design/boards/${file}`) ?? [],
      };
    }
    const siblings = screenFamily(
      file,
      design.files,
      (other) => design.boards.get(other)?.platform === board.platform,
    );
    return {
      file,
      exists: true,
      title: board.meta.title ?? board.placed?.title ?? null,
      platform: board.platform,
      sizes: stepWidths(drawSteps(board.platform, board.meta, board.placed ?? {})),
      drawnAt: drawnAt(board.platform, board.meta, board.placed ?? {}),
      height: board.height,
      schemes: board.meta.schemes ?? platformSchemes(board.platform, design.canvas?.schemes),
      current: current(file),
      replacedBy: current(file) ? null : currentOf(file, design.replacedBy),
      replaces: board.meta.replaces,
      source: board.meta.source,
      starting: design.canvas?.startingBoard === file,
      siblings: siblings.map((other) => ({ file: other, current: current(other) })),
      questions: boardQuestions(board.html).map(({ layer, question }) => ({ layer, question })),
      otherBranches: branches.get(`design/boards/${file}`) ?? [],
    };
  });
  return { boards, components, asked: names.length ? 'named' : 'changed', now };
}

/** The lines status prints, ending with the next command. */
export function statusLines(status) {
  const lines = [];
  const label = (text) => text.padEnd(16);
  if (!status.boards.length) {
    lines.push('This branch changes no boards yet.');
    lines.push('Next  deploy design status <Board>, to see where to start');
    return lines;
  }
  for (const board of status.boards) {
    if (!board.exists) {
      lines.push(`${board.file}  no board yet · ${board.platform} · ${board.drawnAt}`);
      if (board.platformFromName === false)
        lines.push(
          `  ${label('Platform')}its name says none: platform=phone or platform=web in its head decides, and the check draws it so`,
        );
      if (board.means)
        lines.push(`  ${label('Means')}${board.means}: work on that board, it is this screen`);
      else if (board.copyFrom)
        lines.push(
          `  ${label('Copy from')}${board.copyFrom}, and put copied_from=${board.copyFrom} in its head`,
        );
      if (board.source)
        lines.push(
          `  ${label('Source')}${board.source} (${board.sourceOn}): draw this one from it and put source=${board.source} in its head`,
        );
      if (board.startFrom.length)
        lines.push(`  ${label('Start from')}${board.startFrom.join(', ')}`);
      if (board.conventions)
        for (const [at, line] of board.conventions.entries())
          lines.push(`  ${label(at ? '' : 'Conventions')}${line}`);
      if (board.templates.length && !board.means)
        lines.push(`  ${label('Templates')}${board.templates.join(', ')}`);
      if (board.examples && board.ds)
        lines.push(
          `  ${label('First board')}start from the starter's examples in design/${board.ds}/${board.examples.length ? `: ${board.examples.map((path) => path.split('/').pop()).join(', ')}` : ''}`,
        );
      else if (board.examples)
        lines.push(
          `  ${label('First board')}this project has no design system: deploy design init`,
        );
      else if (!board.source && !board.startFrom.length && !board.means && !board.copyFrom)
        lines.push(
          `  ${label('Start from')}no board of this screen; ${board.templates.length ? 'use a page template' : 'copy the nearest board of this project'}`,
        );
      for (const other of board.otherBranches)
        lines.push(
          `  ${label('Also changing')}branch ${other.branch} (${other.by}, ${ago(status.now - other.at)})`,
        );
      continue;
    }
    lines.push(
      `${board.file}  ${board.platform} · ${board.drawnAt} · ${board.schemes.join(', ')} · ${
        board.current ? 'current' : `replaced by ${board.replacedBy}`
      }`,
    );
    if (board.title) lines.push(`  ${label('Title')}${board.title}`);
    if (board.starting)
      lines.push(
        `  ${label('Starting board')}placed by init as the example to start from: replace its words with this project's, rename it (git mv, and its key in canvas.json) if you like, and drop "startingBoard" from canvas.json`,
      );
    if (board.source) lines.push(`  ${label('Source')}${board.source}`);
    if (board.replaces) lines.push(`  ${label('Replaces')}${board.replaces}`);
    if (board.siblings.length)
      lines.push(
        `  ${label('Siblings')}${board.siblings
          .map(
            (sibling) =>
              `${sibling.file.replace(/\.html$/, '')}${sibling.current ? '' : ' (replaced)'}`,
          )
          .join(', ')}`,
      );
    for (const question of board.questions)
      lines.push(`  ${label('Open question')}${question.layer}: "${question.question}"`);
    for (const other of board.otherBranches)
      lines.push(
        `  ${label('Also changing')}branch ${other.branch} (${other.by}, ${ago(status.now - other.at)})`,
      );
  }
  const shown = status.components.filter((component) => component.group !== 'Icons and art');
  const icons = status.components.length - shown.length;
  if (status.components.length)
    lines.push(
      `${label('Components')}${shown.map((component) => component.id).join(', ')}${icons ? `, and ${icons} icons` : ''}`,
    );
  const first = status.boards[0];
  if (!first.exists && first.means) {
    lines.push(`Next  deploy design status ${first.means.replace(/\.html$/, '')}`);
    return lines;
  }
  const target = first.exists && !first.current ? first.replacedBy : first.file;
  lines.push(
    first.exists && !first.current
      ? `Next  edit design/boards/${target} instead (${first.file} was replaced), then deploy design check --fix`
      : first.exists
        ? `Next  edit design/boards/${target}, then deploy design check --fix`
        : first.copyFrom
          ? `Next  copy design/boards/${first.copyFrom} to design/boards/${target}${first.source ? `, draw it from ${first.source}` : ''}, then deploy design check --fix (it places it on the canvas)`
          : first.examples?.length
            ? `Next  copy ${first.examples[0]} to design/boards/${target}, then deploy design check --fix (it places it on the canvas)`
            : `Next  draw design/boards/${target}, then deploy design check --fix (it places it on the canvas)`,
  );
  return lines;
}

/**
 * Where to copy each icon's SVG from: a current board that draws it (the same path), else the
 * library itself.
 */
export function iconSources(design, icons) {
  const boards = [...design.boards.values()].filter((board) => !design.replacedBy.has(board.file));
  return icons.map((component) => {
    const path = /<path d="([^"]+)"/.exec(component.html ?? '')?.[1];
    const board = path ? boards.find((entry) => entry.html.includes(`d="${path}"`))?.file : null;
    return { name: component.id.replace(/^icon-/, ''), id: component.id, board: board ?? null };
  });
}

const kindWords = {
  doc: 'documents, read on screen and printed',
  slides: 'a slide deck (1920×1080, light, in canvas order)',
  print: 'print pieces (trim, bleed and safe margins in mm, type in pt)',
  mac: 'Mac app windows',
  game: 'game screens',
  logo: 'a logo (the mark from 512 down to 16 px)',
  art: 'game art: sprites and tiles on a pixel grid, read at play size',
  model:
    'game models: built in Blender, drawn from every side, underneath too, in the box they must fit',
};

/** Check codes only an app's web and iPhone boards meet. */
const appOnlyCodes = new Set([
  'source_action_missing',
  'second_primary',
  'row_height_differs',
  'box_in_card',
  'differs_from_source',
  'specimen_text',
]);

/** `deploy design guide`: how to work on this project's design, from its own files. */
export function guideLines({ top, designSystem, all = false }) {
  const design = readDesign(top, designSystem);
  // A project of one non-app kind gets the shared essentials and its own kind; --all prints it all.
  const trimmed = design.kind !== 'app' && !all;
  const lines = [];
  const section = (title) => {
    if (lines.length) lines.push('');
    lines.push(title);
  };
  // An open canvas (no design system): the look is the project's own, in look.css.
  const open = !design.ds;
  if (open) {
    section('Look');
    lines.push(
      existsSync(join(top, 'design', 'look.css'))
        ? "  design/look.css holds this project's shared look; boards link ../look.css and add to it."
        : '  Boards carry their own <style>; put what several boards share in design/look.css.',
    );
  } else section('Design system');
  if (open) {
    // Nothing more: no tokens, type scale or components to keep to.
  } else if (design.ds) {
    const files = Object.values(design.paths)
      .flat()
      .filter(
        (path) =>
          typeof path === 'string' &&
          path.startsWith(design.ds) &&
          existsSync(join(top, 'design', path)),
      );
    lines.push(
      `  design/${design.ds}: ${files.map((path) => path.slice(design.ds.length + 1)).join(', ') || 'empty'}`,
    );
    if (design.examples.length)
      lines.push(`  Examples to start from: ${design.examples.join(', ')}`);
  } else {
    lines.push('  This project has no design system yet.');
    lines.push('  deploy design init makes design/ with a starter one in design/ds/<name>/.');
  }
  if (design.kind !== 'app') {
    section('Kind');
    lines.push(
      `  This project makes ${kindWords[design.kind] ?? design.kind} (canvas.json "kind": "${design.kind}"); its boards are ${designKinds[design.kind].platforms.join(' or ')} boards.`,
    );
  }
  section('Platforms and sizes');
  const none = parseBoardMeta(null);
  const schemeWords = (platform) => platformSchemes(platform, design.canvas?.schemes).join(' and ');
  if (!design.boards.size)
    for (const platform of designKinds[design.kind].platforms)
      lines.push(
        `  ${platform.padEnd(8)}${String(boardFrame(platform, none, {}).width).padEnd(6)}drawn at ${drawnAt(platform, none, {})}, ${schemeWords(platform)}`,
      );
  const platforms = new Map();
  for (const board of design.boards.values()) {
    const entry = platforms.get(board.platform) ?? { count: 0, widths: new Map(), example: board };
    entry.count++;
    entry.widths.set(board.width, (entry.widths.get(board.width) ?? 0) + 1);
    platforms.set(board.platform, entry);
  }
  for (const [platform, entry] of [...platforms].sort((a, b) => b[1].count - a[1].count)) {
    const width = [...entry.widths].sort((a, b) => b[1] - a[1])[0][0];
    lines.push(
      `  ${platform.padEnd(8)}${String(width).padEnd(6)}drawn at ${drawnAt(platform, entry.example.meta, entry.example.placed ?? {})}, ${schemeWords(platform)} · ${entry.count} board${entry.count === 1 ? '' : 's'}`,
    );
  }
  const platformHelp = {
    web: 'web',
    phone: 'phone',
    mac: 'mac',
    slide: 'slide',
    doc: 'doc (page=a4|letter)',
    print: 'print (size=85x55mm,bleed=3mm,safe=4mm)',
    game: 'game (device=phone, width=390,height=844)',
    logo: 'logo',
    art: 'art (tile=16, and play=48 when the brief gives one: the tile in art pixels, and the px it is drawn at in play)',
    model:
      'model (model=Crate,size=1x1x1,tris=500: design/models/Crate.py, the box it fits in metres, its triangle budget)',
  };
  const ownPlatforms = designKinds[design.kind].platforms;
  const headExample =
    design.kind === 'app'
      ? 'width=390,height=844,platform=phone,source=Inbox.html'
      : `platform=${ownPlatforms[0]}${boardSizeKeys[ownPlatforms[0]] ?? ''}`;
  lines.push(
    `  A board says what it is in its head: <meta name="design-board" content="${headExample}">`,
  );
  // A project of one kind lists that kind's platforms only; the app lists them all.
  lines.push(
    `  Platforms: ${
      design.kind === 'app'
        ? Object.values(platformHelp).join(', ')
        : ownPlatforms.map((platform) => platformHelp[platform] ?? platform).join(', ')
    }.`,
  );
  if (open && design.kind === 'game')
    lines.push(
      '  A game board with device=phone is an iPhone screen (390 x 844, or 844 x 390 turned sideways): keep play and text out of the top 54 and bottom 34 px',
      '  (the sides, 54 px, in landscape); outside_safe_area says so. immersive=true in the head opts out for a full-screen game.',
    );
  else if (!trimmed || design.kind === 'game')
    lines.push(
      '  A game board with device=phone is an iPhone screen (390 x 844, or 844 x 390 turned sideways): draw the status bar in its top 54 px, keep content out of',
      '  the top 54 and bottom 34 px (the sides, 54 px, in landscape); outside_safe_area and no_status_bar say so. immersive=true in the head opts out for a',
      "  full-screen game. An app's phone boards are not held to it (they are the app's content, without the device's chrome). Its type is the game scale",
      "  (--text-game-*), never the phone's; every other platform is held to its own kit's scale too.",
    );
  if (open)
    lines.push(
      '  Limits from the brief go in the head too, and the check holds the board to them: size= and tris= (model), tile= and play= (art), pages= (doc), min-text=28 or 11pt (any board), contrast=aa (low contrast stops the check).',
      '  Anything that must scroll sideways says so (overflow-x: auto or data-scroll-x); the rest ends inside its edge (cut_off_side).',
    );
  else
    lines.push(
      '  Style lives in the design system, not the board: no style="…" with a colour, size, space or font, and no <style> block for html, body or a design-system class (inline_style). A kit’s own custom property in style, like a bar’s --v or a print face’s --print-w, is how the kit is driven, and is fine.',
      "  Put it in the kind's css (design/ds/<system>/<kind>.css) as a class. Anything that must scroll sideways says so (overflow-x: auto or data-scroll-x); the rest ends inside its edge (cut_off_side).",
    );
  lines.push(
    '  Also schemes=light dark, title=…, replaces=<Old>.html, copied_from=<Board>.html (commas between keys; semicolons work too).',
  );
  lines.push(
    design.kind === 'doc'
      ? "  A doc's height is measured, never set: deploy design check --fix writes it into the head and canvas.json together."
      : '  Its height in the head and in canvas.json must agree; deploy design check --fix writes both.',
  );

  const groups = design.tokensJson?.type?.groups ?? [];
  const kindScale = [...new Set(designKinds[design.kind].platforms)]
    .map((platform) => platformInfo(platform).scale)
    .filter((scale) => scale && design.tokens?.typeTokens?.[scale]);
  if (design.kind !== 'app' && kindScale.length) {
    for (const scale of kindScale) {
      section(`Type scale for ${design.kind} (${scale}, from the design system's CSS)`);
      for (const token of design.tokens.typeTokens[scale])
        lines.push(`  ${token.name.padEnd(28)}${token.value}`);
    }
  } else if (groups.length) {
    section('Type scale (px, size/line height)');
    for (const group of groups)
      for (const style of group.styles ?? [])
        lines.push(
          `  ${`${style.name}`.padEnd(14)}${`${Number.parseFloat(style.fontSize)}/${Number.parseFloat(style.lineHeight)}`.padEnd(8)}${String(style.fontWeight ?? 400).padEnd(5)}${(style.usage ?? '').split('. ')[0]}`,
        );
  } else if (design.tokens?.type.length) {
    section('Type scale (px, from tokens.css)');
    lines.push(`  ${design.tokens.type.join(', ')}`);
    if (design.tokens.phoneType?.length)
      lines.push(`  phone: ${design.tokens.phoneType.join(', ')}`);
  }
  if (design.tokens?.space.length) {
    section('Spacing');
    lines.push(
      `  ${design.tokens.space.join(', ')} px, as var(--space-1) … ; nothing else for margins, padding and gaps`,
    );
  }
  if (design.tokens?.colors.length) {
    section('Colours (tokens; never a written-out colour)');
    lines.push(`  ${design.tokens.colors.map((token) => `--${token.name}`).join(', ')}`);
  }
  const components = design.library?.components ?? [];
  if (components.length) {
    section(
      `Components (design/${design.paths.library.find((path) => existsSync(join(top, 'design', path))) ?? design.paths.library[0]})`,
    );
    const width = Math.max(...components.map((component) => component.id.length)) + 2;
    const icons = components.filter((component) => component.group === 'Icons and art');
    for (const component of components.filter((entry) => entry.group !== 'Icons and art'))
      lines.push(
        `  ${component.id.padEnd(width)}${(component.description ?? component.name).split('. ')[0].replace(/\.$/, '')}`,
      );
    if (icons.length) {
      section("Icons (copy the <svg> from the board named, or from library.json's icon-<name>)");
      const shown = iconSources(design, icons);
      const iconWidth = Math.max(...shown.map((entry) => entry.name.length)) + 2;
      for (const entry of shown)
        lines.push(
          `  ${entry.name.padEnd(iconWidth)}${entry.board ?? `design/${design.paths.library[0]}`}`,
        );
    }
  }
  const readme = designText(top, 'README.md') ?? '';
  // The README's own sentence that lists them: "Use the fixture names from the boards: a, b, c."
  const fixtures = /use the fixture names[^:\n]*:\s*([^\n]+)/i.exec(readme)?.[1];
  if (fixtures) {
    section('Fixtures (use these names, never invented ones)');
    lines.push(`  ${fixtures.trim().replace(/\.$/, '')}`);
  }
  if (open) {
    section('Content');
    lines.push(
      '  Draw sample content real and specific, never "Item one" or "Lorem". A product fact the brief does not give (a price, hours,',
      '  a policy) is left out, or drawn as finished copy with data-question="Is this the real price?" on its layer.',
    );
    section('Check codes (problems stop the check; advice is yours to weigh)');
    const kindPlatforms = designKinds[design.kind].platforms;
    const shown = checkCodes.filter((entry) => {
      if (onlyWithSystem(entry.code)) return false;
      if (!trimmed) return true;
      if (appOnlyCodes.has(entry.code)) return false;
      const named = /^(print|doc|logo|game|art|model)\b/.exec(entry.means)?.[1];
      return !named || kindPlatforms.includes(named);
    });
    const width = Math.max(...shown.map((entry) => entry.code.length)) + 2;
    for (const entry of shown)
      lines.push(
        `  ${entry.code.padEnd(width)}${stopsOnOpenCanvas(entry.code, entry.problem) ? 'problem' : 'advice '}  ${entry.means}`,
      );
    section('The loop');
    lines.push(
      '  1. edit design/boards/<Board>.html    link ../look.css; keep data-layer IDs',
      '  2. deploy design look <Board>        see it (--zoom 3, --width, --scheme dark, --angle for a model)',
      '  3. deploy design check --fix        beside main; fix every problem, weigh the advice',
      '  4. deploy design export             the files to hand on',
    );
    return lines;
  }
  section('Sample content, product facts and questions');
  lines.push(
    '  Sample user content (what someone using the product would type or make: a note title, a folder, a contact, a caption,',
  );
  lines.push(
    '  a recipe) is drawn real and specific, with no flag. Never "Item one", "Note title one", "Lorem" or "00": filler reads as a wireframe.',
  );
  lines.push(
    '  Product facts (features, settings and defaults, prices, hours, dates, contact details, statistics, claims) the brief',
  );
  lines.push(
    '  does not give: leave them out, or draw a value that reads as finished copy and put data-question="Are these the real hours?"',
  );
  lines.push(
    '  on the layer. Report, slide and handbook figures are facts: draw plausibly shaped values at real density, flagged.',
  );
  lines.push(
    '  Flagged figures still agree: a total is the sum of its lines, and one figure on two boards is one number.',
  );
  lines.push(
    '  A rule the product has not decided: mark the layer with data-question="How long are kept files kept?" and say only what is',
  );
  lines.push("  true today, with no value: 'Kept with this run.' No guess, no promised setting.");
  lines.push('  The check lists every question for the owner.');
  lines.push(
    '  Inside a component instance, ask on its root, by inner layer ID, since the library draws the',
  );
  lines.push(
    '  insides again: data-questions=\'{"draft-size":"Is the size the frame or the window?"}\'',
  );
  section('Components on a board');
  lines.push(
    '  An instance (data-component) is drawn from its data-props; anything typed inside it is lost.',
  );
  lines.push(
    '  Change data-props, then deploy design sync [<Board>…] draws it again, keeping its layer IDs.',
  );
  section('Check codes (problems block; notes do not)');
  // A kind project lists the codes its boards can meet; --all lists every one.
  const kindPlatforms = designKinds[design.kind].platforms;
  const shownCodes = trimmed
    ? checkCodes.filter((entry) => {
        if (appOnlyCodes.has(entry.code)) return false;
        const named = /^(print|doc|logo|game|art|model)\b/.exec(entry.means)?.[1];
        return !named || kindPlatforms.includes(named);
      })
    : checkCodes;
  const codeWidth = Math.max(...shownCodes.map((entry) => entry.code.length)) + 2;
  for (const entry of shownCodes)
    lines.push(
      `  ${entry.code.padEnd(codeWidth)}${entry.problem ? 'problem' : 'note   '}  ${entry.means}`,
    );
  section('The loop');
  lines.push(
    '  1. deploy design status <Board>     where to start, its source, siblings, questions',
  );
  lines.push('  2. edit design/boards/<Board>.html  with components, tokens and fixture names');
  lines.push("     deploy design sync                 after changing an instance's data-props");
  lines.push(
    '  3. deploy design check --fix        draws it beside main here; fixes what has one answer',
  );
  lines.push('  4. fix every problem, read the notes and the pairs in output/design/pairs');
  lines.push(
    '     deploy design review               a brief for a second agent; act on its facts',
  );
  lines.push('  5. git commit, with the code the board pictures');
  if (trimmed) {
    section('Rules of this kind');
    lines.push(
      `  design/${design.ds ?? 'ds/<name>'}/README.md has the ${design.kind} section. deploy design guide --all prints the full guide (web, iPhone and every kind).`,
    );
  }
  return lines;
}
