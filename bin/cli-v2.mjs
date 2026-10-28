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

Agents
  task "<what to do>"     Start a task (--on <computer>, --agent scout)
  tasks                  Tasks and what they are doing

Apps and computers
  discover [search]      Browse apps you can install
  install <app>          Install an app from Discover
  remove [app]           Remove an app (asks first)
  computers              Computers and what each one is doing
  computer join          Make this computer a worker

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
    const result = await api('/api/v2/inbox?state=waiting');
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
  if (args.length) {
    const item = items.find((item) => item.id === args[0]);
    if (!item) throw cliError('That item is no longer waiting on you.', 'deploy inbox', 2);
    const action = item.actions.find((action) => action.id === args[1]);
    if (!action) throw cliError('Choose one of this item’s actions.', 'deploy inbox --json', 2);
    if (
      !(await confirmChange(
        `${item.title}\n${action.confirm || action.label}`,
        options.yes,
        prompt,
      ))
    )
      return { cancelled: true };
    return api(`/api/v2/inbox/${encodeURIComponent(item.id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ actionId: action.id, on: 'cli' }),
    });
  }
  if (options.json) return { items };
  if (!items.length) console.log('Nothing waiting on you.');
  for (const item of items) {
    console.log(`\n! ${item.title}  · ${item.from}\n  ${item.text}`);
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
    if (action.confirm && !(await confirmChange(action.confirm, options.yes, prompt))) continue;
    const result = await api(`/api/v2/inbox/${encodeURIComponent(item.id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ actionId: action.id, on: 'cli' }),
    });
    const answered = result.item || result;
    console.log(
      `  ✓ Answered${answered.answer?.by ? ` by ${answered.answer.by} on ${answered.answer.on}` : ''}. Next: deploy status`,
    );
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

// Follow the durable build receipt, not an old running container during a new upload.
export async function followDeploy(api, name, accepted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const path = `/api/deployments/${encodeURIComponent(name)}`;
  if (!accepted.buildLogId)
    return {
      name,
      state: 'running',
      steps: releaseSteps('running', 'Accepted; no build receipt was supplied'),
    };
  do {
    const result = await api(`${path}/build-logs`);
    const build = result.logs?.find((entry) => entry.id === accepted.buildLogId);
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
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return {
    name,
    state: 'running',
    buildLogId: accepted.buildLogId,
    steps: releaseSteps('running', 'Still running on the coordinator; stopped waiting'),
  };
}
