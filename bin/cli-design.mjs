// deploy design start | check | propose | feedback | resolve: a design change from a terminal.
// The caller supplies the transport, Git and the terminal (see `deps` below), so the contract
// tests drive every command without a server, a repository or a terminal.
import { basename, dirname, relative, resolve } from 'node:path';
import * as contracts from './cli-contracts.mjs';
import { cliError } from './cli-v2.mjs';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LABEL = 33;

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
 * interactive, prompt(question), now(), sleep(ms), exists(path), runCheck(root, args) →
 * { code, stdout } or null when the project has no design check, serverUrl, home, spinner.
 */
export async function runDesign(sub, args, options, deps) {
  const paint = painter(deps.color && !options.json);
  const out = (line = '') => {
    if (!options.json) deps.write(`${line}\n`);
  };
  const step = (mark, label, detail) => out(stepLine(paint, mark, label, detail));
  const git = (gitArgs, cwd = deps.cwd) => deps.git(gitArgs, cwd);
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

  /** Runs the project's own check and returns its result, or null when it has none. */
  const check = async (top, { quiet = false, drop = false } = {}) => {
    tryGit(['fetch', '--quiet', 'origin', mainName(top)], top);
    const ran = await deps.runCheck(top, [
      '--base',
      `origin/${mainName(top)}`,
      // Boards carried only for a shared part's instances go back to main's.
      ...(drop ? ['--drop-instances'] : []),
    ]);
    if (!ran) return null;
    let result;
    try {
      result = JSON.parse(String(ran.stdout).trim().split('\n').at(-1));
    } catch {
      throw cliError('The design check did not report a result.', 'node scripts/design-check.mjs');
    }
    if (result.error) throw cliError(result.error, 'git fetch origin', 2);
    if (!quiet) printCheck(result);
    return result;
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
      try {
        await contracts.designFeedback(api(deps), designApi(id), `design/${slug}`);
      } catch (error) {
        if (error?.status !== 404) throw error;
        throw cliError(
          `${hostOf(deps.serverUrl)} has no project "${id}".`,
          'deploy design start "<title>" --project <name>',
          1,
        );
      }
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
      git(
        ['worktree', 'add', '--quiet', '--no-track', '-b', branch, folder, `origin/${main}`],
        top,
      );
      step('✓', 'Branch', branch);
      step('✓', 'Folder', shown);
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
      out();
      out(`Edit the boards in ${paint.bold('design/boards')}, then:`);
      out(`  cd ${shown}`);
      out('  deploy design check');
      return {
        exitCode: 0,
        json: {
          project: id,
          branch,
          folder,
          main: { name: main, commit },
          working: working.working,
        },
      };
    }

    case 'check': {
      const top = root();
      const result = await check(top, { drop: Boolean(options['drop-instances']) });
      if (!result) {
        out('This project has no design check (scripts/design-check.mjs), so nothing was drawn.');
        out();
        out('Ask for review with:');
        out('  deploy design propose');
        return { exitCode: 0, json: { checked: false } };
      }
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
        (result?.boards ?? []).map((board) => board.title).join(', '),
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
      if (result && result.problems.length) {
        step(
          '✗',
          `Checked ${plural(result.boards.length, 'board')}`,
          plural(result.problems.length, 'problem'),
        );
        printProblems(result);
        fixLine(result);
        return { exitCode: 1, json: { proposed: false, check: result } };
      }
      if (result) step('✓', `Checked ${plural(result.boards.length, 'board')}`, 'no problems');
      else out('This project has no design check (scripts/design-check.mjs); not checked.');
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
      const boards = feedback.review?.boards ?? result?.boards.length ?? 0;
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

    default:
      throw cliError(
        sub ? `Unknown design command "${sub}".` : 'Choose a design command.',
        'deploy design start | check | propose | feedback | resolve',
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
