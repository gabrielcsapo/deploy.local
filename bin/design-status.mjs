// `deploy design status` and `deploy design guide`: where to start a board and how to work here,
// read from the project's own files (design/, its design system and README) and from Git, which
// is only read. Nothing here calls deploy.local, so both work offline and in a sandbox.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardPlatform, parseBoardMeta, platformWidths } from '../shared/v2/design-board-meta.ts';
import { reviewWidths } from '../shared/v2/design-review.ts';
import {
  boardQuestions,
  checkCodes,
  readTokens,
  screenBase,
  screenFamily,
} from '../server/design/board-quality.ts';

const readOnly = { GIT_OPTIONAL_LOCKS: '0' };

/** A file under design/: the project's own, else deploy.local's design system for ds/ paths. */
function designText(top, path, designSystem) {
  const full = join(top, 'design', path);
  if (existsSync(full)) return readFileSync(full, 'utf8');
  return path.startsWith('ds/') ? (designSystem?.(path)?.toString() ?? null) : null;
}

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
    if (board.meta.replaces && board.meta.replaces !== board.file)
      replacedBy.set(board.meta.replaces, board.file);
  let library = null;
  try {
    library = JSON.parse(
      designText(top, 'ds/deploy-local/components/library.json', designSystem) ?? 'null',
    );
  } catch {
    library = null;
  }
  const tokens = readTokens(
    designText(top, 'ds/deploy-local/tokens.json', designSystem),
    designText(top, 'ds/deploy-local/tokens.css', designSystem),
  );
  let tokensJson = null;
  try {
    tokensJson = JSON.parse(designText(top, 'ds/deploy-local/tokens.json', designSystem) ?? 'null');
  } catch {
    tokensJson = null;
  }
  return { files, boards, canvas, replacedBy, library, tokens, tokensJson };
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
        source,
        sourceOn: source ? design.boards.get(source)?.platform : null,
        templates: templates.map((component) => component.id),
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
      if (board.source)
        lines.push(
          `  ${label('Source')}${board.source} (${board.sourceOn}): draw this one from it and put source=${board.source} in its head`,
        );
      if (board.startFrom.length)
        lines.push(`  ${label('Start from')}${board.startFrom.join(', ')}`);
      if (board.templates.length)
        lines.push(`  ${label('Templates')}${board.templates.join(', ')}`);
      if (!board.source && !board.startFrom.length)
        lines.push(`  ${label('Start from')}no board of this screen; use a page template`);
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
  const target = first.exists && !first.current ? first.replacedBy : first.file;
  lines.push(
    first.exists && !first.current
      ? `Next  edit design/boards/${target} instead (${first.file} was replaced), then deploy design check --fix`
      : first.exists
        ? `Next  edit design/boards/${target}, then deploy design check --fix`
        : `Next  create design/boards/${target}${first.source ? ` from ${first.source}` : ''}, add it to canvas.json, then deploy design check --fix`,
  );
  return lines;
}

/** `deploy design guide`: how to work on this project's design, from its own files. */
export function guideLines({ top, designSystem }) {
  const design = readDesign(top, designSystem);
  const lines = [];
  const section = (title) => {
    if (lines.length) lines.push('');
    lines.push(title);
  };
  section('Platforms and sizes');
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
    '  A board says what it is in its head: <meta name="design-board" content="width=390,height=844; platform=phone; source=Inbox.html">',
  );
  lines.push(
    '  Also schemes=light dark, title=…, replaces=<Old>.html. Its height in the head and in canvas.json must agree.',
  );

  const groups = design.tokensJson?.type?.groups ?? [];
  if (groups.length) {
    section('Type scale (px, size/line height)');
    for (const group of groups)
      for (const style of group.styles ?? [])
        lines.push(
          `  ${`${style.name}`.padEnd(14)}${`${Number.parseFloat(style.fontSize)}/${Number.parseFloat(style.lineHeight)}`.padEnd(8)}${String(style.fontWeight ?? 400).padEnd(5)}${(style.usage ?? '').split('. ')[0]}`,
        );
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
    section('Components (design/ds/deploy-local/components/library.json)');
    const width = Math.max(...components.map((component) => component.id.length)) + 2;
    const icons = components.filter((component) => component.group === 'Icons and art');
    for (const component of components.filter((entry) => entry.group !== 'Icons and art'))
      lines.push(
        `  ${component.id.padEnd(width)}${(component.description ?? component.name).split('. ')[0].replace(/\.$/, '')}`,
      );
    if (icons.length)
      lines.push(
        `  ${'icons'.padEnd(width)}${icons.map((component) => component.id.replace(/^icon-/, '')).join(', ')}`,
      );
  }
  const readme = designText(top, 'README.md') ?? '';
  const fixtures = /fixture names[^:]*:\s*([^\n]+)/i.exec(readme)?.[1];
  if (fixtures) {
    section('Fixtures (use these names, never invented ones)');
    lines.push(`  ${fixtures.trim().replace(/\.$/, '')}`);
  }
  section('When the product does not say');
  lines.push(
    '  Mark the layer with data-question="How long are kept files kept?" and show no value.',
  );
  lines.push('  The check lists it for the owner; a date or number on that layer is a problem.');
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
  lines.push(
    '  3. deploy design check --fix        draws it beside main here; fixes what has one answer',
  );
  lines.push('  4. fix every problem, read the notes and the pairs in output/design/pairs');
  lines.push('  5. git commit, with the code the board pictures');
  return lines;
}
