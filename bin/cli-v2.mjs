import * as contracts from './cli-contracts.mjs';
import { stripVTControlCharacters } from 'node:util';

// Presentation and compatibility helpers shared by the source and bundled CLI.
export const HELP = `deploy — ship and run apps on computers you own

Usage  deploy [command] [app] [flags]

Ship
  deploy                 Ship this folder to its project
  plan [app]             Show what would change, without shipping
  rollback [app]          Move a whole project back to its last release
  releases [app]          List a project's releases

Watch
  status                 What is running, what is failing, what needs you
  logs [app]             Stream logs (--build for the last build)
  open [app]             Open the app in your browser
  ssh [app]              Open a shell inside the app

Decide
  inbox                  Answer what is waiting on you
                         inbox <id> <action> --yes to answer in scripts
                         inbox wait <id or title> until it is answered

Design
  design start "<title>" Start a design change on a branch from main
  design check           Draw what you changed beside main
  design propose         Ask for review
  design feedback        Read the answer and the notes  (--wait)
  design resolve <n>     Answer a note when it is done

Agents
  task "<what to do>"     Start a task (--on <computer>)
  tasks                  Tasks and what they are doing

Apps and computers
  discover [search]      Browse apps you can install
  install <app>          Install an app from Discover
  remove [app]           Remove an app (asks first)
  computers              Computers and what each one is doing
  computer join          Make this computer a worker

Packages
  packages               List private packages
  packages trust         Install without signing in
  packages login         Sign in to publish
  packages use           Install this project through deploy.local
  packages use --off     Remove the project's registry setting
  packages publish       Publish this npm package or Cargo crate (--tag next, --dry-run, --claim)
  packages copies        Show copies kept for your projects
  packages copies fetch  Fetch missing packages for your projects
  packages deprecate     Deprecate <name>@<range> "<message>"
  packages yank          Yank <crate>@<version> (--undo to restore)

Account   login · logout · whoami · upgrade · version

Flags    --json  machine output       -y, --yes  skip confirmations
         -u, --url  coordinator       -h, --help help for any command

[app] defaults to the project in this folder. More: deploy help advanced`;

export function cliError(message, next = 'deploy --help', exitCode = 1) {
  return Object.assign(new Error(message), { next, exitCode });
}

export function suggestCommand(input, commands) {
  function distance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++)
        next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
      row = next;
    }
    return row[b.length];
  }
  return commands
    .map((name) => ({ name, distance: distance(input, name) }))
    .filter((item) => item.distance <= 2)
    .sort((a, b) => a.distance - b.distance)[0]?.name;
}

export function liveStatus(deployments, fleet, inbox) {
  const nodes = Array.isArray(fleet) ? fleet : fleet.nodes || [];
  const computers = nodes.map((node) => ({
    id: node.id,
    name: node.name || node.hostname || node.id,
    status:
      node.status ||
      (node.online === true ? 'online' : node.online === false ? 'offline' : 'unavailable'),
    role: node.kind === 'coordinator' ? 'Coordinator' : 'Run apps',
    apps: [],
  }));
  for (const deployment of deployments) {
    const state = deployment.health?.state;
    const status = deployment.status;
    const health =
      state === 'failing' || ['failed', 'error', 'unhealthy', 'crashloop'].includes(status)
        ? 'Failing'
        : state === 'warning'
          ? 'Needs attention'
          : state === 'healthy' || status === 'healthy'
            ? 'Healthy'
            : ['stopped', 'exited'].includes(status)
              ? 'Stopped'
              : status === 'running'
                ? 'Running'
                : ['building', 'starting', 'deploying', 'backing-up', 'restoring'].includes(status)
                  ? 'Releasing'
                  : 'Unavailable';
    const computerId =
      deployment.activeNodeId ||
      deployment.nodeId ||
      deployment.desiredNodeId ||
      nodes.find((node) => node.kind === 'coordinator')?.id;
    let computer = computers.find((node) => node.id === computerId);
    if (!computer) {
      computer = {
        id: computerId || null,
        name: 'Computer unavailable',
        status: 'unavailable',
        apps: [],
      };
      computers.push(computer);
    }
    computer.apps.push({
      name: deployment.name,
      status: status || 'unknown',
      health,
      summary:
        deployment.health?.summary || (health === 'Running' ? 'Health checks unavailable' : ''),
    });
  }
  const apps = computers.flatMap((computer) => computer.apps);
  return {
    computers,
    running: apps.filter((app) => ['running', 'healthy'].includes(app.status)),
    failing: apps.filter((app) => app.health === 'Failing'),
    waiting: inbox?.filter((item) => item.state === 'waiting') || [],
    inboxSupported: inbox !== null,
  };
}

export function printLive(status) {
  console.log(`Live · ${status.running.length} running · ${status.failing.length} failing`);
  for (const computer of status.computers) {
    console.log(
      `\n${computer.name}  ${computer.status}${computer.role ? ` · ${computer.role}` : ''}`,
    );
    for (const app of computer.apps)
      console.log(`  ● ${app.name}  ${app.health}${app.summary ? `  ${app.summary}` : ''}`);
  }
  if (!status.computers.length)
    console.log('\nNo apps running. Next: deploy (in a project folder)');
  if (status.waiting.length)
    console.log(`\n! ${status.waiting.length} waiting on you  · deploy inbox`);
  else
    console.log(
      status.inboxSupported
        ? '\nNothing waiting on you.'
        : '\nWaiting on you: unavailable on this coordinator.',
    );
}

export async function readInbox(api) {
  try {
    const result = await contracts.inbox(api);
    const items = Array.isArray(result) ? result : result.items;
    if (!Array.isArray(items))
      throw cliError('The inbox response was not recognized.', 'deploy upgrade');
    return items.filter((item) => item.state === 'waiting');
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function confirmChange(message, yes, prompt) {
  if (yes) return true;
  if (!process.stdin.isTTY)
    throw cliError(
      `${message}\nConfirmation required; nothing changed.`,
      'repeat the command with --yes',
      2,
    );
  return /^y(es)?$/i.test((await prompt(`${message} [y/N] `)).trim());
}

export async function runInbox(api, args, options, prompt) {
  const items = await readInbox(api);
  if (items === null)
    throw cliError("This deploy.local doesn't support the inbox yet", 'deploy upgrade', 2);
  let unresolved = new Set();
  if (items.some((item) => item.id.startsWith('design:')) && (!options.json || args.length)) {
    try {
      const reviews = await api('/api/design/reviews');
      unresolved = new Set(
        (reviews.proposals ?? []).filter((review) => review.stale).map((review) => review.id),
      );
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const resolveMessage = (id) =>
    `Resolve the conflicting screens in the review: /dashboard/inbox?item=${encodeURIComponent(id)}`;
  if (args.length) {
    const item = items.find((item) => item.id === args[0]);
    if (!item) throw cliError('That item is no longer waiting on you.', 'deploy inbox', 2);
    const action = item.actions.find((action) => action.id === args[1]);
    if (!action) throw cliError('Choose one of this item’s actions.', 'deploy inbox --json', 2);
    if (unresolved.has(item.id) && ['approve', 'changes'].includes(action.id))
      throw cliError(resolveMessage(item.id), 'open the review', 2);
    if (
      !(await confirmChange(
        `${item.title}\n${action.confirm || action.label}`,
        options.yes,
        prompt,
      ))
    )
      return { cancelled: true };
    return contracts.answerInbox(api, item.id, action.id);
  }
  if (options.json) return { items };
  if (!items.length) console.log('Nothing waiting on you.');
  for (const item of items) {
    console.log(`\n! ${item.title}  · ${item.from}\n  ${item.text}`);
    if (unresolved.has(item.id)) console.log(`  ${resolveMessage(item.id)}`);
    console.log(
      `  ${item.actions.map((action, i) => `[${i + 1}] ${action.label}`).join('  ')}  [s] Skip  [q] Quit`,
    );
    if (!process.stdin.isTTY) {
      console.log(`  Answer: deploy inbox ${item.id} <action> --yes`);
      for (const action of item.actions) console.log(`    ${action.id}: ${action.label}`);
      continue;
    }
    const choice = (await prompt('  › ')).trim();
    if (choice === 'q') break;
    const action = item.actions[Number(choice) - 1];
    if (!action) continue;
    if (unresolved.has(item.id) && ['approve', 'changes'].includes(action.id)) {
      console.log(`  ${resolveMessage(item.id)}`);
      continue;
    }
    if (action.confirm && !(await confirmChange(action.confirm, options.yes, prompt))) continue;
    const result = await contracts.answerInbox(api, item.id, action.id);
    const answered = result.item || result;
    console.log(
      `  ✓ Answered${answered.answer?.by ? ` by ${answered.answer.by} on ${answered.answer.on}` : ''}. Next: deploy status`,
    );
  }
}

const listed = (result) => (Array.isArray(result) ? result : (result?.items ?? []));

/** One item by its ID, or by words from its title when only one item has them. */
function pickItem(items, ref) {
  const exact = items.filter((item) => item.id === ref);
  if (exact.length) return exact;
  const words = ref.toLowerCase();
  return items.filter((item) => String(item.title).toLowerCase().includes(words));
}

/**
 * Wait until one inbox item is answered, so a script or an agent outside deploy.local can go on
 * when the owner decides. Returns the answered item, or `{ waiting }` when the time runs out.
 */
export async function waitInbox(api, ref, options = {}, clock = {}) {
  if (!ref)
    throw cliError('Name the item to wait for: its ID or words from its title.', 'deploy inbox', 2);
  const seconds = options.seconds ?? 600;
  const sleep = clock.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = clock.now ?? Date.now;
  const deadline = now() + seconds * 1000;
  let announced = false;
  for (;;) {
    const found = pickItem(listed(await contracts.inbox(api)), ref);
    const answered = pickItem(listed(await contracts.answeredInbox(api)), ref);
    // Answered between the two reads: the answer wins.
    const waiting = found.filter((item) => !answered.some((done) => done.id === item.id));
    const matches = waiting.concat(answered);
    if (matches.length > 1 && !matches.some((item) => item.id === ref))
      throw cliError(
        `More than one item matches “${ref}”:\n${matches
          .map((item) => `  ${item.id}  ${item.title}`)
          .join('\n')}`,
        'deploy inbox wait <id>',
        2,
      );
    if (!waiting.length && answered.length)
      return { item: answered.find((item) => item.id === ref) ?? answered[0] };
    if (!waiting.length)
      throw cliError(`Nothing in the inbox matches “${ref}”.`, 'deploy inbox', 2);
    if (!announced && !options.json) console.log(`Waiting on you: ${waiting[0].title}`);
    announced = true;
    if (now() >= deadline) return { waiting: waiting[0] };
    await sleep(Math.min(3000, Math.max(0, deadline - now())));
  }
}

export function failureLines(output) {
  const lines = stripVTControlCharacters(String(output || ''))
    .split('\n')
    .filter((line) => line.trim());
  const relevant = lines.filter((line) =>
    /error|failed|exception|does not exist|^\s+at /i.test(line),
  );
  return (relevant.length ? relevant : lines).slice(-6);
}

export function releaseSteps(state, detail) {
  return [
    {
      name: 'prepare',
      state: state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'done',
      detail,
    },
    {
      name: 'verify',
      state: 'skipped',
      detail: 'Separate verification is not reported by this coordinator',
    },
    { name: 'activate', state: state === 'live' ? 'done' : 'waiting' },
    {
      name: 'watch',
      state: 'skipped',
      detail: 'Extended watch is not reported; check deploy status',
    },
  ];
}

export function printRelease(release) {
  for (const step of release.steps || []) {
    const marker =
      step.state === 'done'
        ? '✓'
        : step.state === 'failed'
          ? '✗'
          : step.state === 'running'
            ? '·'
            : '–';
    const label = step.name[0].toUpperCase() + step.name.slice(1);
    console.log(`  ${marker} ${label}  ${step.state}${step.detail ? ` · ${step.detail}` : ''}`);
  }
  for (const line of release.errors || []) console.log(`    ${line}`);
  const outcome =
    release.state === 'live'
      ? '✓ Released'
      : release.state === 'rolled-back'
        ? '✓ Rolled back'
        : release.state === 'failed'
          ? '✗ Release failed'
          : 'Release still running';
  console.log(
    `\n${outcome} ${release.name || release.projectId}${release.id ? ` · ${release.id}` : ''}`,
  );
  if (release.url && release.state === 'live') console.log(`  ${release.url}`);
  console.log(
    `  Next: deploy ${release.state === 'failed' ? 'logs --build' : release.state === 'running' ? 'status' : 'logs'}`,
  );
}

// Only status reads are retried. A successful read resets the outage window; the caller's
// deadline still covers the entire wait, including an upload becoming a release.
function releasePoller(
  timeoutMs,
  { now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {},
) {
  const deadline = now() + timeoutMs;
  return {
    remaining: () => Math.max(0, deadline - now()),
    expired: () => now() >= deadline,
    pastDeadline: () => now() > deadline,
    pause: () => sleep(Math.min(1000, Math.max(0, deadline - now()))),
    async read(request) {
      let failedAt;
      for (;;) {
        try {
          return await request();
        } catch (error) {
          // Authentication, missing receipts and other client errors need attention, not retries.
          if (error.status !== undefined && (error.status < 500 || error.status >= 600))
            throw error;
          failedAt ??= now();
          if (now() >= deadline) return undefined;
          if (now() - failedAt >= 120_000) throw error;
          await sleep(Math.min(1000, deadline - now(), 120_000 - (now() - failedAt)));
          if (now() >= deadline) return undefined;
        }
      }
    },
  };
}

// Follow the durable build receipt, not an old running container during a new upload.
export async function followDeploy(api, name, accepted, timeoutMs = Infinity, watch = {}) {
  const poll = releasePoller(timeoutMs, watch);
  if (accepted.release || accepted.releaseId)
    return followRelease(
      api,
      accepted.release || { id: accepted.releaseId, state: 'running', steps: [] },
      timeoutMs,
      watch,
    );
  if (accepted.projectRelease && accepted.buildLogId) {
    do {
      const result = await poll.read(() => contracts.uploadRelease(api, accepted.buildLogId));
      if (result?.release) return followRelease(api, result.release, poll.remaining(), watch);
      if (poll.expired())
        return { name, state: 'running', steps: [], buildLogId: accepted.buildLogId };
      await poll.pause();
    } while (!poll.pastDeadline());
    return { name, state: 'running', steps: [], buildLogId: accepted.buildLogId };
  }
  const path = `/api/deployments/${encodeURIComponent(name)}`;
  if (!accepted.buildLogId)
    return {
      name,
      state: 'running',
      steps: releaseSteps('running', 'Accepted; no build receipt was supplied'),
    };
  do {
    const result = await poll.read(() => api(`${path}/build-logs`));
    const build = result?.logs?.find((entry) => entry.id === accepted.buildLogId);
    if (build?.status === 'complete' || typeof build?.success === 'boolean') {
      const state = build.success ? 'live' : 'failed';
      return {
        name,
        state,
        buildLogId: build.id,
        steps: releaseSteps(
          state,
          build.success ? 'Build and startup completed' : 'Build or startup failed',
        ),
        ...(build.success ? {} : { errors: failureLines(build.output) }),
      };
    }
    if (poll.expired()) break;
    await poll.pause();
  } while (!poll.pastDeadline());
  return {
    name,
    state: 'running',
    buildLogId: accepted.buildLogId,
    steps: releaseSteps('running', 'Still running on the coordinator; stopped waiting'),
  };
}

/** A release is in people's hands once Activate is done; Watch only keeps checking its health. */
export function releaseActivated(release) {
  return (
    release.state === 'live' ||
    (release.state === 'running' &&
      (release.steps || []).some((step) => step.name === 'activate' && step.state === 'done'))
  );
}

/**
 * Follows a release until it settles. `watch.onChange` hears every read, so a terminal can show
 * each step as it happens; `watch.untilActivated` stops once the release is switched on instead
 * of sitting through the ten minutes of Watch.
 */
export async function followRelease(api, accepted, timeoutMs = Infinity, watch = {}) {
  let release = accepted.release || accepted;
  const poll = releasePoller(timeoutMs, watch);
  while (release.state === 'running') {
    const response = await poll.read(() => contracts.release(api, release.id));
    if (!response) break;
    release = response.release || response;
    watch.onChange?.(release);
    if (release.state !== 'running' || poll.expired()) break;
    if (watch.untilActivated && releaseActivated(release)) break;
    await poll.pause();
  }
  return release;
}

export function elapsed(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/** One step line: a mark, what happened, and how long it took. */
export function stepLine(mark, label, detail = '') {
  return `  ${mark} ${detail ? label.padEnd(30) : label}${detail}`.trimEnd();
}

const STEP_WORDS = {
  prepare: ['Preparing release', 'Prepared release', 'Prepare failed'],
  verify: ['Verifying', 'Verified', 'Verify failed'],
  activate: ['Activating', 'Activated', 'Activate failed'],
};

/**
 * Prints a release step by step while it runs: one line per finished step, and on a terminal the
 * running step with its time so far. Watch is not a line: it runs after the release is in use.
 */
export function releaseReporter({ write, live = false, now = () => Date.now() }) {
  const printed = new Set();
  let running = '';
  const span = (step) =>
    step.startedAt
      ? elapsed((step.endedAt ? Date.parse(step.endedAt) : now()) - Date.parse(step.startedAt))
      : '';
  const clear = () => {
    if (running) write('\r\x1b[2K');
    running = '';
  };
  return {
    update(release) {
      for (const step of release.steps || []) {
        const words = STEP_WORDS[step.name];
        if (!words || printed.has(step.name)) continue;
        if (step.state === 'done') {
          clear();
          write(`${stepLine('✓', words[1], span(step))}\n`);
          printed.add(step.name);
        } else if (step.state === 'failed') {
          clear();
          const [headline, ...rest] = String(step.detail || '')
            .trim()
            .split('\n')
            .filter(Boolean);
          write(`${stepLine('✗', headline ? `${words[2]}: ${headline}` : words[2])}\n`);
          for (const line of rest.slice(0, 6)) write(`      ${line}\n`);
          printed.add(step.name);
        } else if (step.state === 'running' && live) {
          const line = stepLine('·', words[0], span(step));
          if (line !== running) write(`\r\x1b[2K${line}`);
          running = line;
        }
      }
    },
    /** The closing lines: the result, where it is, and what to do next. */
    finish(release, { url, startedAt } = {}) {
      clear();
      const id = String(release.id || '').slice(0, 7);
      const took = startedAt ? ` in ${elapsed(now() - startedAt)}` : '';
      if (releaseActivated(release)) {
        if (release.state === 'running')
          write('    deploy.local checks health for 10 minutes after this\n');
        write(`\n✓ Released ${id}${took}\n`);
        if (url) write(`  ${url}\n`);
        write('  Next: deploy logs · deploy rollback\n');
      } else if (release.state === 'failed') {
        const untouched = (release.steps || []).some(
          (step) => step.name === 'activate' && step.state === 'skipped',
        );
        write(
          untouched
            ? '\n✗ Nothing changed. Every app stayed on its previous release.\n'
            : `\n✗ Release ${id} failed.\n`,
        );
        write('  Next: deploy logs --build\n');
      } else {
        write(`\nRelease ${id} is still running; stopped waiting.\n  Next: deploy status\n`);
      }
    },
  };
}

export async function followRollback(api, project, accepted, timeoutMs = Infinity, watch = {}) {
  let rollback = accepted.rollback || accepted;
  const poll = releasePoller(timeoutMs, watch);
  for (;;) {
    const steps = rollback.steps || [];
    const state = steps.some((step) => step.state === 'failed')
      ? 'failed'
      : steps.length && steps.every((step) => ['done', 'skipped'].includes(step.state))
        ? 'rolled-back'
        : 'running';
    if (state !== 'running' || poll.expired()) return { ...rollback, state };
    const response = await poll.read(() => contracts.rollbacks(api, project));
    if (!response) return { ...rollback, state };
    const found = (response.rollbacks || response).find((entry) => entry.id === rollback.id);
    if (!found)
      throw cliError('The rollback receipt is unavailable.', `deploy releases ${project}`);
    rollback = found;
    if (!rollback.steps.some((step) => ['running', 'waiting'].includes(step.state))) continue;
    await poll.pause();
  }
}

// The caller owns certificate trust, request transport and ~/.deployrc persistence.
export async function browserLogin({
  request,
  serverUrl,
  openBrowser,
  save,
  print = console.log,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
}) {
  const post = (path, body) =>
    request(`${serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const pending = await contracts.startLogin(post);
  const verification = new URL(pending.verificationUri);
  if (verification.origin !== new URL(serverUrl).origin)
    throw cliError('The sign-in address does not match this computer.', 'deploy login --password');
  print(`Sign in in your browser: ${verification.href}\n  Code ${pending.userCode}  waiting…`);
  try {
    await openBrowser(verification.href);
  } catch {
    print('Open the address above to continue.');
  }
  const deadline = now() + Math.min(pending.expiresIn, 300) * 1000;
  while (now() < deadline) {
    await sleep(Math.max(1, pending.interval || 2) * 1000);
    const result = await contracts.pollLogin(post, pending.deviceCode);
    if (result.state === 'denied') throw cliError('Sign-in was denied.', 'deploy login');
    if (result.state === 'approved' && result.username && result.token) {
      await save({ username: result.username, token: result.token, url: serverUrl });
      print(`✓ Signed in as ${stripVTControlCharacters(result.username)}`);
      return result;
    }
    if (result.state !== 'pending')
      throw cliError('The sign-in response was not recognized.', 'deploy login --password');
  }
  throw cliError('The sign-in code expired.', 'deploy login');
}
