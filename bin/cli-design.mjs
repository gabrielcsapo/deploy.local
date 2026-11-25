// deploy design start | check | propose | feedback | resolve: a design change from a terminal.
// The caller supplies the transport, Git and the terminal (see `deps` below), so the contract
// tests drive every command without a server, a repository or a terminal.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import * as contracts from './cli-contracts.mjs';
import { cliError } from './cli-v2.mjs';
import { WORKTREE, designFile, worktreeGit } from './design-check-local.mjs';
import { checkDesign } from '../server/features/design/board-check.ts';
import { parseBoardMeta, setBoardMetaHeight } from '../shared/v2/design-board-meta.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LABEL = 33;

/** `deploy design --help`, `deploy design -h` and `deploy help design`. */
export const DESIGN_HELP = `deploy design — change what people see, and get it approved first

Usage  deploy design <command> [flags]

  start "<title>"          Start a design change on a branch from main
  propose                  Check it, push it and ask for review
  feedback                 Read the answer and the notes
  resolve <n> "<reply>"    Answer a note when it is done

While you draw
  dev                      Open the Design page on this folder, as you save
  check                    Draw what you changed beside main, once

Flags
  --project <name>         The project, when origin is elsewhere
  --wait                   feedback: stay until there is an answer
  --title, --summary, --look-at
                           propose: answer its questions up front
  --drop-instances         check: put carried boards back as on main
  --json                   Print the result as JSON

How a canvas and a board are written:  design/README.md`;

/** The README start writes into a project that had no design: how a canvas and a board are written. */
export const DESIGN_README = `# Design

This folder is the app's design: one board per screen, reviewed
on deploy.local's Design page before anything is built.

## canvas.json
{ "title", "boards": { "<Name>.html": { "x", "y", "w", "h", "title" } },
  "order": ["<Name>.html"], "notes": { "<id>": { "x", "y", "text" } } }
Web boards are 1440 wide and are checked at 700 too. Phone boards
are 390. Place boards apart on the canvas.

## boards/<Name>.html
One standalone page per board, sized by
<meta name="design-board" content="width=1440,height=900">
No scripts and no remote images. Pictures, such as a screenshot of
the running app, sit beside the boards in boards/captures.
Every element someone might point at carries a data-layer ID,
unique in its board. deploy design check adds them. Keep them.

## Style
The board's own <style>, or design/ds if this project has one.

## Changing the design
deploy design start "<title>", then deploy design dev to see
the boards on the Design page as you save. deploy design propose
asks for review, and deploy design feedback --wait hears back.
`;

/** A project's first board: a standalone page, styled by its own <style>. */
export function firstBoard(title = 'Board', width = 1440, height = 900) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="design-board" content="width=${width},height=${height}">
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;background:#fff;color:#18181b;font-family:system-ui,sans-serif}
main{box-sizing:border-box;padding:64px}
h1{margin:0;font-size:32px;line-height:40px}
</style>
</head>
<body>
<main data-layer="page"><h1 data-layer="title">${title}</h1></main>
</body>
</html>
`;
}

/** "Harbor" from Harbor.html, as boards and review name a board. */
const screenName = (file) => String(file).replace(/\.html$/, '');

/**
 * Writes a first canvas, board and README into a folder whose design/ has no canvas yet, keeping
 * whatever is there. Returns the paths written, relative to design/.
 */
export function writeFirstDesign(folder, title) {
  const design = join(folder, 'design');
  mkdirSync(join(design, 'boards'), { recursive: true });
  const written = [];
  const put = (path, text) => {
    if (existsSync(join(design, path))) return;
    writeFileSync(join(design, path), text);
    written.push(path);
  };
  put(
    'canvas.json',
    `${JSON.stringify(
      {
        title,
        boards: { 'Board.html': { x: 0, y: 0, w: 1440, h: 900, title: 'Board' } },
        order: ['Board.html'],
        notes: {},
      },
      null,
      2,
    )}\n`,
  );
  put('boards/Board.html', firstBoard());
  put('README.md', DESIGN_README);
  return written;
}

/** The same name the server gives a design branch: lowercase words joined by hyphens. */
export function designSlug(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** "Sidebar by project" from design/sidebar-by-project. */
export function titleFromBranch(branch) {
  const words = branch
    .replace(/^(design|artifact)\//, '')
    .replace(/--.*$/, '')
    .replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The project a clone belongs to, from its deploy.local origin. The HTTPS address carries the
 * project's ID (…/api/git/<project>/…); the short ones carry its repository name
 * (ssh://git@deploy.local:2222/<name>.git, git@deploy.local:<name>.git,
 * https://deploy.local/<name>.git), which the coordinator accepts in place of the ID.
 */
export function projectFromRemote(url, serverUrl = 'https://deploy.local') {
  const text = String(url ?? '').trim();
  const byId = /\/api\/git\/([^/?#]+)/.exec(text);
  if (byId) return decodeURIComponent(byId[1].replace(/\.git$/, ''));
  let host;
  let path;
  const short = text.includes('://') ? null : /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(text);
  if (short) [, host, path] = short;
  else
    try {
      const parsed = new URL(text);
      // A web address names a repository only as <name>.git; SSH may leave the ending off.
      if (parsed.protocol !== 'ssh:' && !/\.git$/i.test(parsed.pathname)) return null;
      host = parsed.hostname;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  if (!['deploy.local', hostOf(serverUrl).replace(/:\d+$/, '')].includes(host.toLowerCase()))
    return null;
  const name = path.replace(/^(?:~\/|\/)/, '').replace(/\.git$/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : null;
}

/** "4 min" from milliseconds; "just now" under a minute. */
export function since(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Colour only for a terminal that wants it: never piped, never with NO_COLOR or --json. */
export function painter(enabled) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  return {
    ok: wrap('32'),
    bad: wrap('31'),
    ask: wrap('33'),
    run: wrap('35'),
    dim: wrap('2'),
    bold: wrap('1'),
  };
}

/** One step: a mark, what happened, and a quieter detail in its own column. */
function stepLine(paint, mark, label, detail = '') {
  const colour = { '✓': paint.ok, '✗': paint.bad, '!': paint.ask }[mark] ?? paint.run;
  if (!detail) return `${colour(mark)} ${label}`;
  const padded = label.length >= LABEL ? `${label} ` : label.padEnd(LABEL);
  return `${colour(mark)} ${padded}${paint.dim(detail)}`;
}

/**
 * Runs one design command. Returns `{ exitCode, json }`; throws cliError for usage and failures.
 * deps: api, git(args, cwd) → stdout (throws on failure), cwd, computer, write(text), color,
 * interactive, prompt(question), now(), sleep(ms), exists(path), serverUrl, home, spinner,
 * serveDesign({ root, project, branch, main, deployUrl, onSave }) → { url, stopped }.
 */
export async function runDesign(sub, args, options, deps) {
  const paint = painter(deps.color && !options.json);
  const out = (line = '') => {
    if (!options.json) deps.write(`${line}\n`);
  };
  const step = (mark, label, detail) => out(stepLine(paint, mark, label, detail));
  const git = (gitArgs, cwd = deps.cwd, env) => deps.git(gitArgs, cwd, env);
  const tryGit = (gitArgs, cwd) => {
    try {
      return git(gitArgs, cwd);
    } catch {
      return null;
    }
  };
  const root = () => {
    const top = tryGit(['rev-parse', '--show-toplevel']);
    if (!top)
      throw cliError('This folder is not a Git checkout of a project.', 'cd into a project', 2);
    return top;
  };
  const project = (top) => {
    const id =
      options.project ||
      projectFromRemote(tryGit(['remote', 'get-url', 'origin'], top), deps.serverUrl);
    if (!id)
      throw cliError(
        'This folder is not a deploy.local project: its origin is not on deploy.local.',
        'deploy design <command> --project <id>',
        2,
      );
    return id;
  };
  const designApi = (id) => `/api/projects/${encodeURIComponent(id)}/design`;
  const mainName = (top) =>
    (tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], top) ?? 'origin/main').replace(
      /^origin\//,
      '',
    );
  const designBranch = (top) => {
    const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], top);
    if (!branch || !/^(design|artifact)\//.test(branch))
      throw cliError(
        `This folder is on ${branch ?? 'no branch'}, not a design branch.`,
        'deploy design start "<title>"',
        2,
      );
    return branch;
  };

  /** A spinner line for how far the drawing is, which the result replaces. */
  const drawingProgress = (where) => {
    const live = deps.spinner && !options.json;
    let showing = false;
    let spun = 0;
    return {
      progress: ({ drawn, total }) => {
        if (!live) return;
        const label =
          total === null ? 'Reading the changes' : `Drawing ${drawn} of ${plural(total, 'board')}`;
        deps.write(`\r\x1b[2K${stepLine(paint, SPINNER[spun++ % SPINNER.length], label, where)}`);
        showing = true;
      },
      clear: () => {
        if (showing) deps.write('\r\x1b[2K');
      },
    };
  };

  /**
   * Checks the design as this folder has it. On the computer when a browser starts here: main is
   * this checkout's own origin/main, read with git show, and nothing is written inside .git.
   * Otherwise deploy.local draws it from a private commit of the working copy, made with an index
   * and objects outside .git and pushed to a ref the check removes. New layer IDs come back into
   * the boards, carried boards are put back (with drop), measured heights are written (with fix),
   * and Before and After are written into output/design/pairs.
   */
  const check = async (top, { quiet = false, drop = false, fix = false } = {}) => {
    if (!existsSync(join(top, 'design')))
      throw cliError('This project has no design yet.', 'deploy design start "<title>"', 1);
    const opened = deps.openLocalDrawing
      ? await deps.openLocalDrawing(top)
      : { reason: 'this terminal has no browser' };
    let run;
    try {
      run = opened.drawing
        ? await checkHere(top, opened, drop)
        : await checkOnServer(top, drop, opened.reason);
    } finally {
      await opened.close?.();
    }
    const { result, sent, cleanup } = run;
    const fixed = [];
    try {
      // New elements' layer IDs go into the boards here, unless a board changed since it was read.
      for (const [file, html] of Object.entries(result.layers ?? {})) {
        const path = join(top, 'design', 'boards', file);
        const was = sent(file);
        if (
          was !== null &&
          existsSync(path) &&
          readFileSync(path, 'utf8').trimEnd() === was.trimEnd()
        )
          writeFileSync(path, html.endsWith('\n') ? html : `${html}\n`);
      }
      if (result.named) fixed.push(`${plural(result.named, 'layer ID')} given`);
      // Boards carried only for a shared part's instances go back to main's.
      for (const { commit: from, files } of result.restore ?? [])
        for (const file of files) {
          const bytes = designFile(top, from, `boards/${file}`);
          if (bytes !== null) writeFileSync(join(top, 'design', 'boards', file), bytes);
        }
      // Heights the canvas and the board disagree on: measured, and written into both with fix.
      const heights = Object.entries(result.heights ?? {});
      if (fix && heights.length) {
        const canvasPath = join(top, 'design', 'canvas.json');
        const canvas = JSON.parse(readFileSync(canvasPath, 'utf8'));
        for (const [file, height] of heights) {
          const path = join(top, 'design', 'boards', file);
          const html = readFileSync(path, 'utf8');
          const width = canvas.boards?.[file]?.w ?? parseBoardMeta(html).width ?? 1440;
          writeFileSync(path, setBoardMetaHeight(html, height, width));
          if (canvas.boards?.[file]) canvas.boards[file].h = height;
          fixed.push(`${screenName(file)} is ${height} px tall in its meta and canvas.json`);
        }
        writeFileSync(canvasPath, `${JSON.stringify(canvas, null, 2)}\n`);
        const done = new Set(heights.map(([file]) => file));
        result.problems = result.problems.filter(
          (problem) => !(problem.code === 'height_differs' && done.has(problem.file)),
        );
        for (const board of result.boards)
          board.problems = result.problems
            .filter((problem) => problem.file === board.file)
            .map((problem) => problem.short);
      }
      const pairs = join(top, 'output', 'design', 'pairs');
      mkdirSync(pairs, { recursive: true });
      for (const picture of result.pictures ?? [])
        if (/^[A-Za-z0-9_-]+-\d+-(light|dark)\.png$/.test(picture.name))
          writeFileSync(join(pairs, picture.name), Buffer.from(picture.png, 'base64'));
    } finally {
      cleanup?.();
    }
    const {
      pictures: _pictures,
      layers: _layers,
      restore: _restore,
      heights: _heights,
      ...shown
    } = result;
    const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], top) ?? 'HEAD';
    const outcome = {
      ...shown,
      notes: shown.notes ?? [],
      fixed,
      where: run.where,
      legacy: /^(design|artifact)\//.test(branch),
    };
    if (!quiet) printCheck(outcome, run);
    return outcome;
  };

  /** The check on this computer: the folder's files against this checkout's origin/main. */
  const checkHere = async (top, opened, drop) => {
    const main = mainName(top);
    const base = tryGit(['rev-parse', '--verify', '--quiet', `origin/${main}^{commit}`], top);
    if (!base)
      throw cliError(`This checkout has no origin/${main} to compare with.`, 'git fetch origin', 1);
    const reader = worktreeGit({ top, git: deps.git });
    const { progress, clear } = drawingProgress('beside main, here');
    let result;
    try {
      result = await checkDesign(
        {
          commit: WORKTREE,
          base,
          baseRef: `origin/${main}`,
          drop,
          systemFile: (path) => deps.designSystem?.(path)?.toString() ?? null,
        },
        reader,
        opened.drawing,
        deps.now,
        progress,
      );
    } finally {
      clear();
    }
    return {
      result,
      where: 'computer',
      base: { ref: `origin/${main}`, commit: base },
      browser: opened.executable,
      missingFonts: [...(opened.missingFonts ?? [])],
      sent: (file) => reader.sent.get(`design/boards/${file}`) ?? null,
    };
  };

  /**
   * The check on deploy.local, when no browser starts here. The working copy of design/ is
   * committed beside HEAD with an index and objects in a temporary folder (Git reads this
   * checkout's objects through GIT_ALTERNATE_OBJECT_DIRECTORIES), so nothing is written inside
   * .git, and pushed to a private ref that the check removes.
   */
  const checkOnServer = async (top, drop, reason) => {
    const id = project(top);
    const scratch = mkdtempSync(join(tmpdir(), 'deploy-design-check-'));
    const cleanup = () => rmSync(scratch, { recursive: true, force: true });
    try {
      mkdirSync(join(scratch, 'objects'), { recursive: true });
      const env = {
        GIT_INDEX_FILE: join(scratch, 'index'),
        GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: resolve(
          top,
          git(['rev-parse', '--git-path', 'objects'], top),
        ),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_AUTHOR_NAME: 'deploy design check',
        GIT_AUTHOR_EMAIL: 'design-check@deploy.local',
        GIT_COMMITTER_NAME: 'deploy design check',
        GIT_COMMITTER_EMAIL: 'design-check@deploy.local',
      };
      git(['read-tree', 'HEAD'], top, env);
      git(['add', '-A', '--', 'design/'], top, env);
      const tree = git(['write-tree'], top, env);
      const commit = git(
        ['commit-tree', tree, '-p', 'HEAD', '-m', 'deploy design check'],
        top,
        env,
      );
      const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], top) ?? 'head';
      const ref = `refs/design-check/${designSlug(branch.replace(/^(design|artifact)\//, '')) || 'head'}-${commit.slice(0, 12)}`;
      try {
        git(['push', '--quiet', 'origin', `${commit}:${ref}`], top, env);
      } catch {
        throw cliError("Could not send this folder's design to origin.", 'git push origin', 4);
      }
      const { progress, clear } = drawingProgress('beside main, on deploy.local');
      let result;
      try {
        result = await contracts.checkDesign(
          api(deps),
          designApi(id),
          { ref, drop },
          { sleep: deps.sleep, progress },
        );
      } catch (error) {
        try {
          git(['push', '--quiet', 'origin', '--delete', ref], top, env);
        } catch {
          // deploy.local removes it after a check it finished.
        }
        if (error?.status === undefined && !error?.exitCode)
          throw cliError(
            `Can't reach ${hostOf(deps.serverUrl)} to draw it.`,
            'deploy browser install',
            4,
          );
        throw error;
      } finally {
        clear();
      }
      const shown = new Map();
      return {
        result: { notes: [], heights: {}, ...result },
        where: 'deploy.local',
        reason,
        sent: (file) => {
          if (!shown.has(file))
            shown.set(file, tryGitEnv(['show', `${commit}:design/boards/${file}`], top, env));
          return shown.get(file);
        },
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  };
  const tryGitEnv = (gitArgs, cwd, env) => {
    try {
      return git(gitArgs, cwd, env);
    } catch {
      return null;
    }
  };

  const printFinding = (mark, finding) => {
    step(mark, finding.label, finding.detail);
    if (finding.fix)
      out(`  ${paint.dim(`${finding.code ? `${finding.code} · ` : ''}fix: ${finding.fix}`)}`);
  };
  const printProblems = (result) => {
    for (const problem of result.problems) printFinding('✗', problem);
  };
  const fixLine = (result) => {
    const titles = [
      ...new Set(
        result.problems.map(
          (problem) => result.boards.find((board) => board.file === problem.file)?.title,
        ),
      ),
    ].filter(Boolean);
    out();
    out(
      `${paint.bad(plural(result.problems.length, 'problem'))}. Fix ${titles.length ? titles.join(', ') : 'it'}, then:`,
    );
    // A part's carried boards are fixed by the check itself, and so are heights.
    const carried = result.problems.some((problem) => problem.file?.startsWith('part:'));
    const heights = result.problems.some((problem) => problem.code === 'height_differs');
    out(`  deploy design check${carried ? ' --drop-instances' : ''}${heights ? ' --fix' : ''}`);
  };
  const printCheck = (result, run) => {
    if (run.where === 'computer')
      step(
        '✓',
        'Checked on this computer',
        `against ${run.base.ref} ${run.base.commit.slice(0, 7)}`,
      );
    else step('!', 'Drawn by deploy.local', `no browser here: ${run.reason}`);
    if (run.missingFonts?.length)
      step('!', 'Fonts drawn in a fallback', 'the design system fonts did not download');
    if (result.dropped)
      step(
        '✓',
        `Restored ${plural(result.dropped, 'board')} to main`,
        'landing draws their instances',
      );
    step('✓', `Named ${plural(result.named, 'new element')}`, 'layer IDs kept on the rest');
    for (const line of result.fixed.filter((entry) => !/layer ID/.test(entry)))
      step('✓', 'Fixed', line);
    step(
      '✓',
      `Drew ${plural(result.drawn, 'board')} beside main`,
      `${[...result.widths, ...result.schemes].join(' · ')}   ${result.seconds} s`,
    );
    printProblems(result);
    if (result.boards.length) {
      const width = Math.max(5, ...result.boards.map((board) => board.title.length)) + 3;
      out();
      out(`  ${'Board'.padEnd(width)}${'What changed'}`);
      for (const board of result.boards)
        out(
          `  ${board.title.padEnd(width)}${[board.words, ...new Set(board.problems)].map((text, at) => (at ? paint.bad(text) : text)).join(' · ')}`,
        );
    }
    if (result.notes.length) {
      out();
      out(`${plural(result.notes.length, 'note')} · these block nothing`);
      for (const note of result.notes) printFinding('!', note);
    }
    out();
    out(`Before and after, side by side:  ${paint.bold(result.pairs)}`);
    if (result.problems.length) fixLine(result);
    else {
      out();
      if (result.legacy) {
        out(
          result.dropped
            ? 'No problems. Commit the restored boards, then ask for review with:'
            : 'No problems. Ask for review with:',
        );
        out('  deploy design propose');
      } else {
        out('No problems. Next: commit the boards with the code they picture:');
        out('  git commit -am "…"');
      }
    }
  };

  /** The --json envelope every check prints. */
  const envelope = (result) => {
    const ok = result.problems.length === 0;
    const heights = result.problems.some((problem) => problem.code === 'height_differs');
    return {
      ok,
      code: ok ? 'clean' : 'problems',
      message: ok
        ? `No problems${result.notes.length ? `, ${plural(result.notes.length, 'note')}` : ''}`
        : `${plural(result.problems.length, 'problem')}${result.notes.length ? `, ${plural(result.notes.length, 'note')}` : ''}`,
      fix: ok ? null : `Fix each problem, then run deploy design check${heights ? ' --fix' : ''}`,
      problems: result.problems,
      notes: result.notes,
      fixed: result.fixed,
      next: ok
        ? result.legacy
          ? 'deploy design propose'
          : 'git commit -am "…"'
        : `deploy design check${heights ? ' --fix' : ''}`,
      checked: true,
      ...result,
    };
  };

  switch (sub) {
    case 'start': {
      const title = args.join(' ').trim();
      if (!title)
        throw cliError('Name the design change.', 'deploy design start "Sidebar by project"', 2);
      const slug = designSlug(title);
      if (!slug)
        throw cliError('Use letters or numbers in the title.', 'deploy design start "…"', 2);
      const top = root();
      const id = project(top);
      // Ask the coordinator about the project before anything is made here.
      let known;
      try {
        known = await contracts.designFeedback(api(deps), designApi(id), `design/${slug}`);
      } catch (error) {
        if (error?.status !== 404) throw error;
        throw cliError(
          `${hostOf(deps.serverUrl)} has no project "${id}".`,
          'deploy design start "<title>" --project <name>',
          1,
        );
      }
      const projectName = known?.project ?? id;
      step('✓', 'Project', projectName);
      const main = mainName(top);
      if (tryGit(['fetch', '--quiet', 'origin', main], top) === null)
        throw cliError(`Could not fetch ${main} from origin.`, 'git fetch origin');
      const commit = git(['rev-parse', `origin/${main}`], top);
      const committed = Number(git(['show', '-s', '--format=%ct', commit], top)) * 1000;
      const branch = `design/${slug}`;
      const folder = resolve(dirname(top), `${basename(top)}-${slug}`);
      const shown = `../${basename(folder)}`;
      if (
        tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], top) ||
        tryGit(['ls-remote', '--heads', 'origin', branch], top)
      )
        throw cliError(`${branch} already exists.`, 'deploy design start with another title', 1);
      if (deps.exists(folder))
        throw cliError(`${shown} already exists.`, `cd ${shown}, or remove it first`, 1);
      const age = since(deps.now() - committed);
      step(
        '✓',
        `Fetched ${main}`,
        `${commit.slice(0, 7)} · ${age === 'just now' ? age : `${age} old`}`,
      );
      // Commits on main here that origin lacks are not in the new branch until they are pushed.
      const ahead = Number(
        tryGit(['rev-list', '--count', `origin/${main}..refs/heads/${main}`], top) ?? 0,
      );
      if (ahead > 0)
        step(
          '!',
          `${main} here is ${plural(ahead, 'commit')} ahead`,
          'origin does not have them yet',
        );
      git(
        ['worktree', 'add', '--quiet', '--no-track', '-b', branch, folder, `origin/${main}`],
        top,
      );
      // The branch's name is cut to 48 letters; its description keeps the title for propose.
      tryGit(['config', `branch.${branch}.description`, title], top);
      step('✓', 'Branch', branch);
      step('✓', 'Folder', shown);
      // A project with no design gets its first canvas, a board and a README saying how they are written.
      const first =
        tryGit(['cat-file', '-e', `origin/${main}:design/canvas.json`], top) === null
          ? writeFirstDesign(folder, projectName)
          : [];
      if (first.length) step('✓', 'First design', first.join(' · '));
      let working;
      try {
        working = await contracts.designWorking(api(deps), designApi(id), {
          branch,
          computer: deps.computer,
        });
      } catch (error) {
        // Nothing has been drawn yet, so a start the coordinator refused leaves nothing behind.
        tryGit(['worktree', 'remove', '--force', folder], top);
        tryGit(['branch', '-D', branch], top);
        throw error;
      }
      out();
      out(`${paint.bold(title)} is yours on ${deps.computer}.`);
      out('It shows on the Design page as being worked on.');
      if (ahead > 0) {
        out();
        out(`To draw from your newer ${main}:`);
        out(paint.dim(`  git push origin ${main}`));
        out(paint.dim(`  git -C ${shown} merge origin/${main}`));
      }
      if (first.length) {
        out();
        out('This project had no design. How one is written:');
        out(paint.dim('  design/README.md'));
      }
      out();
      out(`Edit the boards in ${paint.bold('design/boards')}. To see them as you save:`);
      out(paint.dim(`  cd ${shown}`));
      out(paint.dim('  deploy design dev'));
      return {
        exitCode: 0,
        json: {
          project: id,
          branch,
          folder,
          main: { name: main, commit, ahead },
          firstDesign: first,
          working: working.working,
        },
      };
    }

    case 'check': {
      const top = root();
      const result = await check(top, {
        drop: Boolean(options['drop-instances']),
        fix: Boolean(options.fix),
      });
      return { exitCode: result.problems.length ? 1 : 0, json: envelope(result) };
    }

    case 'propose': {
      const top = root();
      const id = project(top);
      const branch = designBranch(top);
      const asked = async (label, flag, fallback) => {
        if (options[flag] !== undefined) return String(options[flag]).trim();
        if (!deps.interactive) return fallback;
        const answer = (await deps.prompt(`${label} (${fallback}): `)).trim();
        return answer || fallback;
      };
      const result = await check(top, { quiet: true });
      // The title given to start, else the first commit's subject, else the branch name in full.
      const firstSubject = (
        tryGit(['log', '--reverse', '--format=%s', `origin/${mainName(top)}..HEAD`], top) ?? ''
      )
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean);
      const title = await asked(
        'Title',
        'title',
        tryGit(['config', '--get', `branch.${branch}.description`], top)?.trim() ||
          firstSubject ||
          titleFromBranch(branch),
      );
      const summary = await asked(
        'Summary',
        'summary',
        tryGit(['log', '-1', '--format=%s'], top) ?? '',
      );
      const lookAtText = await asked(
        'Look at',
        'look-at',
        result.boards.map((board) => board.title).join(', '),
      );
      const lookAt = lookAtText
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!title || !summary)
        throw cliError(
          'A proposal needs a title and a summary.',
          'deploy design propose --title "…" --summary "…"',
          2,
        );
      out(`${paint.dim('Title    ')} ${title}`);
      out(`${paint.dim('Summary  ')} ${summary}`);
      out(`${paint.dim('Look at  ')} ${lookAt.join(', ')}`);
      out();
      if (result.problems.length) {
        step(
          '✗',
          `Checked ${plural(result.boards.length, 'board')}`,
          plural(result.problems.length, 'problem'),
        );
        printProblems(result);
        fixLine(result);
        return { exitCode: 1, json: { proposed: false, check: result } };
      }
      step('✓', `Checked ${plural(result.boards.length, 'board')}`, 'no problems');
      if (tryGit(['status', '--porcelain', '--', '.'], top))
        throw cliError(
          'This folder has changes that are not committed.',
          'git commit -am "…", then deploy design propose',
          1,
        );
      if (tryGit(['push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${branch}`], top) === null)
        throw cliError(`Could not push ${branch} to origin.`, `git push -u origin ${branch}`);
      step('✓', 'Pushed', branch);
      const { item } = await contracts.proposeDesign(api(deps), designApi(id), {
        ref: branch,
        title,
        summary,
        lookAt,
      });
      const feedback = await contracts.designFeedback(api(deps), designApi(id), branch);
      const boards = feedback.review?.boards ?? result.boards.length;
      step('!', `Waiting on ${feedback.owner}`, `${item.title} · ${plural(boards, 'board')}`);
      out(`  ${paint.dim(`${hostOf(deps.serverUrl)}/dashboard/inbox · Waiting on you`)}`);
      out();
      out('Hear back with:');
      out('  deploy design feedback --wait');
      return { exitCode: 0, json: { proposed: true, item, title, summary, lookAt, check: result } };
    }

    case 'feedback': {
      const top = root();
      const id = project(top);
      const branch = designBranch(top);
      const read = () =>
        options.wait
          ? contracts.waitDesignFeedback(api(deps), designApi(id), branch, deps.computer)
          : contracts.designFeedback(api(deps), designApi(id), branch);
      let spun = 0;
      let showing = '';
      const live = deps.spinner && !options.json;
      for (;;) {
        const feedback = await read();
        const review = feedback.review;
        if (!review)
          throw cliError('Nothing on this branch is proposed yet.', 'deploy design propose', 1);
        const answer = review.answer;
        const landing = review.landing;
        const approved = answer?.actionId === 'approve';
        const waiting = review.state === 'waiting' || (approved && landing?.state === 'pending');
        if (review.state === 'withdrawn')
          throw cliError('A newer proposal replaced this one.', 'deploy design propose', 1);
        if (waiting) {
          const label =
            approved && landing?.state === 'pending'
              ? `${feedback.owner} approved it`
              : `Waiting on ${feedback.owner}`;
          const line = stepLine(
            paint,
            SPINNER[spun % SPINNER.length],
            label,
            since(deps.now() - Date.parse(review.proposedAt)),
          );
          if (!options.wait) {
            out(stepLine(paint, '!', label, since(deps.now() - Date.parse(review.proposedAt))));
            out();
            out('Hear back with:');
            out('  deploy design feedback --wait');
            return { exitCode: 3, json: feedback };
          }
          if (live) {
            if (line !== showing) deps.write(`\r\x1b[2K${line}`);
          } else if (!showing) out(line);
          showing = line;
          spun++;
          await deps.sleep(live ? 1000 : 3000);
          continue;
        }
        if (showing && live) deps.write('\n');
        const round = `round ${review.round}`;
        if (answer && ['changes', 'update'].includes(answer.actionId)) {
          const ago = since(deps.now() - Date.parse(answer.at));
          if (answer.actionId === 'update') {
            step('!', `${feedback.owner} asked you to update`, `${round} · ${ago}`);
            out(`  ${paint.dim('main changed the same screens since this branch started.')}`);
            out();
            out('Bring main into this branch, then propose again:');
            out(`  git merge origin/${mainName(top)}`);
            out('  deploy design propose');
            return { exitCode: 0, json: feedback };
          }
          step('!', `${feedback.owner} asked for changes`, `${round} · ${ago}`);
          if (review.note) out(`  "${review.note}"`);
          if (review.pins.length) {
            const places = review.pins.map((pin) =>
              [pin.boardTitle, pin.layerName].filter(Boolean).join(' · '),
            );
            const number = Math.max(...review.pins.map((pin) => String(pin.number).length));
            const place = Math.max(...places.map((text) => text.length)) + 3;
            out();
            review.pins.forEach((pin, index) =>
              out(
                `  ${String(pin.number).padEnd(number)}  ${places[index].padEnd(place)}${pin.text}`,
              ),
            );
            out();
            out('Answer each note when it is done, then propose again:');
            out(`  deploy design resolve ${review.pins[0].number} "What you did"`);
          } else {
            out();
            out('Change the boards, then propose again:');
          }
          out('  deploy design propose');
          return { exitCode: 0, json: feedback };
        }
        if (approved && landing?.state === 'failed') {
          step('✗', `${feedback.owner} approved it`, `${round} · it could not reach main`);
          return { exitCode: 1, json: feedback };
        }
        if (approved && landing?.state === 'landed') {
          step(
            '✓',
            `${feedback.owner} approved it`,
            `${round} · on main as ${String(landing.commit ?? '').slice(0, 7)}`,
          );
          const cleaned = cleanUp(top, branch, landing.branch);
          return { exitCode: 0, json: { ...feedback, cleaned } };
        }
        throw cliError('The answer on this proposal was not recognized.', 'deploy upgrade');
      }
    }

    case 'resolve': {
      const number = Number(args[0]);
      const reply = args.slice(1).join(' ').trim();
      if (!Number.isInteger(number) || number < 1 || !reply)
        throw cliError(
          'Name the note by its number and say what you did.',
          'deploy design resolve 1 "Bold again"',
          2,
        );
      const top = root();
      const id = project(top);
      const branch = designBranch(top);
      const { comment } = await contracts.resolveDesignNote(api(deps), designApi(id), {
        branch,
        pin: number,
        reply,
      });
      step('✓', `Note ${number} is done`, `"${comment.reply}"`);
      out();
      out('When every note is done, propose again:');
      out('  deploy design propose');
      return { exitCode: 0, json: { comment } };
    }

    case 'dev': {
      const top = root();
      if (!existsSync(join(top, 'design', 'canvas.json')))
        throw cliError('This folder has no design yet.', 'deploy design start "<title>"', 1);
      const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], top) ?? 'HEAD';
      // The project by the name of its main checkout, which a design folder sits beside.
      const mainFolder = (tryGit(['worktree', 'list', '--porcelain'], top) ?? '')
        .split('\n')[0]
        .replace(/^worktree /, '');
      const clock = (at) => new Date(at).toTimeString().slice(0, 8);
      const page = await deps.serveDesign({
        root: top,
        project: basename(mainFolder || top),
        branch,
        main: `origin/${mainName(top)}`,
        deployUrl: deps.serverUrl,
        onSave: ({ file, problems }) => {
          const name = screenName(file);
          const named = name.length >= 7 ? `${name}  ` : name.padEnd(9);
          if (!problems.length) {
            out(paint.dim(`  ${clock(deps.now())}  ${named}saved`));
            return;
          }
          for (const problem of problems)
            out(
              `${paint.bad('✗')} ${clock(deps.now())}  ${named}${problem.short} · ${problem.detail}`,
            );
        },
      });
      step('✓', 'Design page for this folder', page.url);
      out(paint.dim('  The same page as on deploy.local, on your files. It follows each save.'));
      out(paint.dim('  Comments, review and agents are on deploy.local.'));
      out();
      await page.stopped;
      out();
      out('Stopped. Ask for review with:');
      out(paint.dim('  deploy design propose'));
      return { exitCode: 0, json: { url: page.url, stopped: true } };
    }

    default:
      throw cliError(
        sub ? `Unknown design command "${sub}".` : 'Choose a design command.',
        'deploy design --help',
        2,
      );
  }

  /** After landing: the branch here and this folder go, unless either still holds something. */
  function cleanUp(top, branch, server) {
    if (server && !server.removed) {
      out(
        `  ${paint.dim(`Kept ${branch} on origin and here: ${server.kept ?? 'it holds more'}.`)}`,
      );
      return { branch: false, folder: false };
    }
    const common = resolve(top, git(['rev-parse', '--git-common-dir'], top));
    const own = resolve(top, git(['rev-parse', '--git-dir'], top));
    const main = git(['worktree', 'list', '--porcelain'], top)
      .split('\n')[0]
      .replace(/^worktree /, '');
    if (common === own) {
      out(`  ${paint.dim(`${branch} is checked out in this folder; switch away to remove it.`)}`);
      return { branch: false, folder: false };
    }
    if (tryGit(['status', '--porcelain'], top)) {
      out(
        `  ${paint.dim(`Kept this folder and ${branch}: it has changes that are not committed.`)}`,
      );
      return { branch: false, folder: false };
    }
    git(['worktree', 'remove', top], main);
    tryGit(['branch', '-D', branch], main);
    step('✓', `Removed ${branch}`, 'on origin and here');
    const home =
      deps.home && main.startsWith(`${deps.home}/`) ? `~/${relative(deps.home, main)}` : main;
    step('✓', 'Removed its folder', `cd ${home}`);
    return { branch: true, folder: true, main };
  }
}

const api = (deps) => deps.api;
const hostOf = (url) =>
  String(url ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
