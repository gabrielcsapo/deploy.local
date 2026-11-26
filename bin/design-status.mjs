// `deploy design status` and `deploy design guide`: where to start a board and how to work here,
// read from the project's own files (design/, its design system and README) and from Git, which
// is only read. Nothing here calls deploy.local, so both work offline and in a sandbox.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardPlatform, parseBoardMeta, platformWidths } from '../shared/v2/design-board-meta.ts';
import { reviewWidths } from '../shared/v2/design-review.ts';
import {
  boardQuestions,
  boardSimilarity,
  checkCodes,
  readTokens,
  screenBase,
  screenFamily,
} from '../server/design/board-quality.ts';
import { designSystemFolder, designSystemPaths } from '../shared/v2/design-system-path.ts';

const readOnly = { GIT_OPTIONAL_LOCKS: '0' };

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
    const width = Number(placed?.w) || meta.width || 1440;
    boards.set(file, {
      file,
      html,
      meta,
      placed,
      platform: boardPlatform(meta, width),
      width,
      height: Number(placed?.h) || meta.height || 900,
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

const platformOfName = (file) =>
  /Phone\.html$/.test(file)
    ? 'phone'
    : /(Pad|Tablet)\.html$/.test(file)
      ? 'tablet'
      : /Mac\.html$/.test(file)
        ? 'mac'
        : /TV\.html$/.test(file)
          ? 'tv'
          : 'web';

/** "1440 and 700" for a web board, "390" for a phone board. */
const sizes = (width) => reviewWidths(width).join(' and ');

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
      const platform = platformOfName(file);
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
        sizes: reviewWidths(platformWidths[platform] ?? 1440),
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
                  Number(platformOfName(b.split('/').pop()) === platform) -
                  Number(platformOfName(a.split('/').pop()) === platform),
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
      sizes: reviewWidths(board.width),
      height: board.height,
      schemes: board.meta.schemes ?? ['light', 'dark'],
      current: current(file),
      replacedBy: current(file) ? null : currentOf(file, design.replacedBy),
      replaces: board.meta.replaces,
      source: board.meta.source,
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
      lines.push(`${board.file}  no board yet · ${board.platform} · ${board.sizes.join(' and ')}`);
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
      `${board.file}  ${board.platform} · ${board.sizes.join(' and ')} · ${board.schemes.join(', ')} · ${
        board.current ? 'current' : `replaced by ${board.replacedBy}`
      }`,
    );
    if (board.title) lines.push(`  ${label('Title')}${board.title}`);
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

/** `deploy design guide`: how to work on this project's design, from its own files. */
export function guideLines({ top, designSystem }) {
  const design = readDesign(top, designSystem);
  const lines = [];
  const section = (title) => {
    if (lines.length) lines.push('');
    lines.push(title);
  };
  section('Design system');
  if (design.ds) {
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
  section('Platforms and sizes');
  if (!design.boards.size) {
    lines.push('  web     1440  drawn at 1440 and 700, light and dark');
    lines.push('  phone   390   drawn at 390 (844 tall), light and dark');
  }
  const platforms = new Map();
  for (const board of design.boards.values()) {
    const entry = platforms.get(board.platform) ?? { count: 0, widths: new Map() };
    entry.count++;
    entry.widths.set(board.width, (entry.widths.get(board.width) ?? 0) + 1);
    platforms.set(board.platform, entry);
  }
  for (const [platform, entry] of [...platforms].sort((a, b) => b[1].count - a[1].count)) {
    const width = [...entry.widths].sort((a, b) => b[1] - a[1])[0][0];
    lines.push(
      `  ${platform.padEnd(8)}${String(width).padEnd(6)}drawn at ${sizes(width)}, light and dark · ${entry.count} board${entry.count === 1 ? '' : 's'}`,
    );
  }
  lines.push(
    '  A board says what it is in its head: <meta name="design-board" content="width=390,height=844,platform=phone,source=Inbox.html">',
  );
  lines.push(
    '  Also schemes=light dark, title=…, replaces=<Old>.html, copied_from=<Board>.html (commas between keys; semicolons work too).',
  );
  lines.push(
    '  Its height in the head and in canvas.json must agree; deploy design check --fix writes both.',
  );

  const groups = design.tokensJson?.type?.groups ?? [];
  if (groups.length) {
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
  section('When the product does not say');
  lines.push(
    '  Mark the layer with data-question="How long are kept files kept?" and say only what is',
  );
  lines.push(
    "  true today, with no value: 'Kept with this run.' No placeholder, no guess, no promised setting.",
  );
  lines.push('  The check lists it for the owner; a date or number on that layer is a problem.');
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
  const codeWidth = Math.max(...checkCodes.map((entry) => entry.code.length)) + 2;
  for (const entry of checkCodes)
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
  return lines;
}
