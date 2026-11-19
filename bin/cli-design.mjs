// deploy design start | check | propose | feedback | resolve: a design change from a terminal.
// The caller supplies the transport, Git and the terminal (see `deps` below), so the contract
// tests drive every command without a server, a repository or a terminal.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import * as contracts from './cli-contracts.mjs';
import { cliError } from './cli-v2.mjs';

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
  capture <url> <Board>    Put the running app on a board

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
No scripts and no remote images. Pictures sit beside the boards,
in boards/captures: deploy design capture puts the running app there.
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

/** The widths a board is drawn and checked at: web boards at 1440 and 700, phone boards at their own. */
export const boardWidths = (width = 1440) => (width <= 500 ? [width] : [1440, 700]);

/** A board whose picture is the running app, captured at its widths into boards/captures. */
export function captureBoard(name, width, height) {
  const picture = (at) => `captures/${name}-${at}.png`;
  const image =
    width <= 500
      ? `<img data-layer="capture" src="${picture(width)}" alt="${name} as the app runs">`
      : `<picture data-layer="capture"><source media="(max-width: 1000px)" srcset="${picture(700)}"><img data-layer="capture-image" src="${picture(1440)}" alt="${name} as the app runs"></picture>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="design-board" content="width=${width},height=${height}">
<title>${name}</title>
<style>
body{margin:0;background:#fff}
img{display:block;width:100%;height:auto}
</style>
</head>
<body>
${image}
</body>
</html>
`;
}

/** A canvas with a new board placed to the right of every other board. */
export function placeBoard(canvas, file, board) {
  const boards = canvas.boards ?? {};
  const right = Object.values(boards).reduce(
    (edge, placed) => Math.max(edge, Number(placed.x ?? 0) + Number(placed.w ?? 0) + 160),
    0,
  );
  return {
    ...canvas,
    boards: { ...boards, [file]: { x: right, y: 0, ...board } },
    order: [...(canvas.order ?? Object.keys(boards)).filter((entry) => entry !== file), file],
  };
}

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
 * capture(url, widths, height) → one PNG per width, or null when there is no Chromium here.
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

  /**
   * deploy.local draws and checks the design as this folder has it: the working copy of design/,
   * committed beside HEAD without touching the branch or the index, goes to a private ref that
   * the check removes. New layer IDs come back into the boards here, carried boards are put
   * back (with drop), and Before and After are written into output/design/pairs.
   */
  const check = async (top, { quiet = false, drop = false } = {}) => {
    const id = project(top);
    if (!existsSync(join(top, 'design')))
      throw cliError('This project has no design yet.', 'deploy design start "<title>"', 1);
    tryGit(['fetch', '--quiet', 'origin', mainName(top)], top);
    const index = resolve(top, git(['rev-parse', '--git-path', 'deploy-design-check.index'], top));
    const env = {
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: 'deploy design check',
      GIT_AUTHOR_EMAIL: 'design-check@deploy.local',
      GIT_COMMITTER_NAME: 'deploy design check',
      GIT_COMMITTER_EMAIL: 'design-check@deploy.local',
    };
    let commit;
    try {
      git(['read-tree', 'HEAD'], top, env);
      git(['add', '-A', '--', 'design/'], top, env);
      const tree = git(['write-tree'], top, env);
      commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', 'deploy design check'], top, env);
    } finally {
      rmSync(index, { force: true });
    }
    const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], top) ?? 'head';
    const ref = `refs/design-check/${designSlug(branch.replace(/^(design|artifact)\//, '')) || 'head'}-${commit.slice(0, 12)}`;
    if (tryGit(['push', '--quiet', 'origin', `${commit}:${ref}`], top) === null)
      throw cliError("Could not send this folder's design to origin.", 'git push origin', 1);
    let result;
    try {
      result = await contracts.checkDesign(api(deps), designApi(id), { ref, drop });
    } catch (error) {
      tryGit(['push', '--quiet', 'origin', '--delete', ref], top);
      throw error;
    }
    // New elements' layer IDs go into the boards here, unless a board changed since it was sent.
    for (const [file, html] of Object.entries(result.layers ?? {})) {
      const path = join(top, 'design', 'boards', file);
      const sent = tryGit(['show', `${commit}:design/boards/${file}`], top);
      if (sent !== null && existsSync(path) && readFileSync(path, 'utf8').trimEnd() === sent)
        writeFileSync(path, html.endsWith('\n') ? html : `${html}\n`);
    }
    // Boards carried only for a shared part's instances go back to main's.
    for (const { commit: from, files } of result.restore ?? [])
      for (let at = 0; at < files.length; at += 100)
        git(
          [
            'checkout',
            from,
            '--',
            ...files.slice(at, at + 100).map((file) => `design/boards/${file}`),
          ],
          top,
        );
    const pairs = join(top, 'output', 'design', 'pairs');
    mkdirSync(pairs, { recursive: true });
    for (const picture of result.pictures ?? [])
      if (/^[A-Za-z0-9_-]+-\d+-(light|dark)\.png$/.test(picture.name))
        writeFileSync(join(pairs, picture.name), Buffer.from(picture.png, 'base64'));
    const { pictures: _pictures, layers: _layers, restore: _restore, ...shown } = result;
    if (!quiet) printCheck(shown);
    return shown;
  };
  const printProblems = (result) => {
    for (const problem of result.problems) step('✗', problem.label, problem.detail);
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
    // A part's carried boards are fixed by the check itself.
    const carried = result.problems.some((problem) => problem.file?.startsWith('part:'));
    out(`  deploy design check${carried ? ' --drop-instances' : ''}`);
  };
  const printCheck = (result) => {
    if (result.dropped)
      step(
        '✓',
        `Restored ${plural(result.dropped, 'board')} to main`,
        'landing draws their instances',
      );
    step('✓', `Named ${plural(result.named, 'new element')}`, 'layer IDs kept on the rest');
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
          `  ${board.title.padEnd(width)}${[board.words, ...board.problems.map((p) => paint.bad(p))].join(' · ')}`,
        );
    }
    out();
    out(`Before and after, side by side:  ${paint.bold(result.pairs)}`);
    if (result.problems.length) fixLine(result);
    else {
      out();
      out(
        result.dropped
          ? 'No problems. Commit the restored boards, then ask for review with:'
          : 'No problems. Ask for review with:',
      );
      out('  deploy design propose');
    }
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
      const result = await check(top, { drop: Boolean(options['drop-instances']) });
      return { exitCode: result.problems.length ? 1 : 0, json: { checked: true, ...result } };
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
      const title = await asked('Title', 'title', titleFromBranch(branch));
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

    case 'capture': {
      const [address, boardArg] = args;
      const name = String(boardArg ?? '').replace(/\.html$/, '');
      if (!address || !/^[A-Za-z0-9_-]+$/.test(name))
        throw cliError(
          'Name the running app and the board.',
          'deploy design capture localhost:5173 Harbor',
          2,
        );
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`;
      const top = root();
      const design = join(top, 'design');
      const canvasPath = join(design, 'canvas.json');
      let canvas;
      try {
        canvas = existsSync(canvasPath) ? JSON.parse(readFileSync(canvasPath, 'utf8')) : null;
      } catch {
        throw cliError('design/canvas.json is not valid JSON.', 'fix design/canvas.json', 1);
      }
      if (!canvas)
        throw cliError('This project has no design yet.', 'deploy design start "<title>"', 1);
      const file = `${name}.html`;
      const boardPath = join(design, 'boards', file);
      const placed = canvas.boards?.[file];
      const isNew = !existsSync(boardPath);
      const width = Number(placed?.w ?? 1440);
      const height = Number(placed?.h ?? 900);
      const widths = boardWidths(width);
      const started = deps.now();
      const pictures = await deps.capture(url, widths, height);
      if (!pictures)
        throw cliError(
          'Chromium is not installed here, so the app was not captured.',
          'deploy browser install',
          1,
        );
      const seconds = Math.max(1, Math.round((deps.now() - started) / 1000));
      step('✓', 'Captured the running app', `${widths.join(' · ')}   ${seconds} s`);
      const captures = join(design, 'boards', 'captures');
      mkdirSync(captures, { recursive: true });
      const saved = widths.map((at, index) => {
        writeFileSync(join(captures, `${name}-${at}.png`), pictures[index]);
        return `design/boards/captures/${name}-${at}.png`;
      });
      step('✓', `Saved ${plural(saved.length, 'picture')}`, saved[0]);
      if (isNew) {
        writeFileSync(boardPath, captureBoard(name, width, height));
        if (!placed)
          writeFileSync(
            canvasPath,
            `${JSON.stringify(placeBoard(canvas, file, { w: width, h: height, title: name }), null, 2)}\n`,
          );
        step('✓', 'New board', `design/boards/${file}`);
      }
      out();
      out(`${paint.bold(name)} shows the app as it runs. Draw the change over it.`);
      return {
        exitCode: 0,
        json: { board: `design/boards/${file}`, new: isNew, url, widths, pictures: saved, seconds },
      };
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
