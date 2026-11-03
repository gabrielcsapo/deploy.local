import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homeOf, readReleaseConfig } from './self-update-host.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEdits,
  boardLinks,
  type BoardLink,
  layerChanges,
  layerIds,
  layerSnippet,
  syncInstances,
  type Library,
} from '../design/board-html.ts';
import { currentTaskBranch } from '../workspace/follow-up.ts';
import { requireRepository } from '../workspace/repositories.ts';
import { gitEnvironment, gitSync, repositoryGit } from '../workspace/repository-git.ts';
import { get, id, list, now, save } from '../workspace/store.ts';
import { queueTask } from '../workspace/task-workspace.ts';
import { readJson, sendJson } from './attachments.ts';
import { createInboxItem, fail, registerInboxSource, syncInbox } from './inbox.ts';
import { queuePushTrigger } from '../workspace/pipeline-triggers.ts';
import { startRun } from '../workspace/service.ts';
import type { InboxItem } from '../../shared/v2/contracts.ts';
import {
  changeSummary,
  describeChange,
  layerLabel,
  markChanges,
  markColors,
  mergeCanvas,
  noteChanges,
  sectionAt,
  sections,
  type Canvas,
} from '../../shared/v2/design.ts';

/**
 * The Design page reads a project's design/ folder (canvas.json, boards/*.html, ds/) from any ref:
 * main, a design branch, or the branch an agent's task commits to. Boards are served per commit
 * with scripts disabled, so the page can read their layers but nothing in them runs.
 */

const fileTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};
// Boards may load the design system's CSS beside them and Google Fonts; nothing else, and no script.
const boardPolicy = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-same-origin',
].join('; ');

const commitPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const boardPattern = /^[A-Za-z0-9_-]+\.html$/;
const layerPattern = /^[a-z0-9-]{1,64}$/;

function validRef(ref: string) {
  return (
    ref.length > 0 &&
    ref.length <= 250 &&
    !ref.startsWith('-') &&
    !ref.includes('..') &&
    ![...ref].some((c) => c.charCodeAt(0) <= 32)
  );
}

/** The commit a request means: `task` (the branch that task commits to), `ref`, or main. */
function resolveCommit(owner: string, projectId: string, repo: string, url: URL) {
  const taskId = url.searchParams.get('task');
  let ref = url.searchParams.get('ref') || 'HEAD';
  if (taskId) {
    const task = get('task', owner, taskId);
    if (task.projectId !== projectId) fail('That task belongs to another project', 404);
    const branch = `refs/heads/${currentTaskBranch(task)}`;
    ref = gitSync(repo, ['rev-parse', '--verify', '--quiet', branch]) ? branch : task.baseRevision;
  }
  if (!validRef(ref)) fail('Invalid ref');
  const commit = gitSync(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  if (!commit) fail(`No commit named ${ref} in this project`, 404);
  return { ref, commit };
}

async function readFile(repo: string, commit: string, path: string, limit = 2 * 1024 * 1024) {
  try {
    return await repositoryGit(repo, ['show', `${commit}:${path}`], { limit });
  } catch {
    return null;
  }
}

/** The design system's components, which Assets lists and boards hold instances of. */
const libraryPath = 'design/ds/deploy-local/components/library.json';
function parseLibrary(text: string | null | undefined): Library | null {
  if (!text) return null;
  try {
    const library = JSON.parse(text) as Library;
    return Array.isArray(library?.components) ? library : null;
  } catch {
    return null;
  }
}

/** Which boards hold instances of each component, at a commit. */
function componentUsage(repo: string, commit: string) {
  const out =
    gitSync(repo, [
      'grep',
      '-o',
      '-I',
      'data-component="[a-z0-9-]*"',
      commit,
      '--',
      'design/boards',
    ]) ?? '';
  const usage: Record<string, string[]> = {};
  for (const line of out.split('\n')) {
    const match = /^[^:]+:design\/boards\/([^:]+):data-component="([^"]+)"$/.exec(line);
    if (!match) continue;
    const boards = (usage[match[2]] ??= []);
    if (!boards.includes(match[1])) boards.push(match[1]);
  }
  return usage;
}

/**
 * Approving a change to the component library renders every instance on main again, so editing a
 * component on main updates every board that uses it. Boards the approval copies come from the
 * branch; the rest are as they are on main.
 */
function instanceWrites(repo: string, target: string, from: string, paths: string[]) {
  if (!paths.includes(libraryPath)) return [];
  const library = parseLibrary(gitSync(repo, ['show', `${from}:${libraryPath}`]));
  if (!library) return [];
  const boards = new Set([
    ...Object.values(componentUsage(repo, target)).flat(),
    ...Object.values(componentUsage(repo, from))
      .flat()
      .filter((board) => paths.includes(`design/boards/${board}`)),
  ]);
  const writes: { path: string; content: string }[] = [];
  for (const board of boards) {
    const path = `design/boards/${board}`;
    const html = gitSync(repo, ['show', `${paths.includes(path) ? from : target}:${path}`]);
    if (!html) continue;
    const synced = syncInstances(html, library);
    // gitSync trims the file's last newline; put it back.
    if (synced !== html) writes.push({ path, content: `${synced}\n` });
  }
  return writes;
}

/**
 * Files the branch changed that main also changed since the branch started, merged: canvas.json
 * entry by entry, anything else line by line. Approving writes these instead of the branch's copy,
 * so it never undoes what main gained meanwhile. Edits to the same lines stop the approval.
 */
function mergedWrites(
  repo: string,
  input: {
    base: string;
    target: string;
    from: string;
    paths: string[];
    main: string;
    branch: string;
  },
) {
  const blob = (commit: string, path: string) =>
    gitSync(repo, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
  const writes: { path: string; content: string }[] = [];
  for (const path of input.paths) {
    const [base, target, from] = [input.base, input.target, input.from].map((commit) =>
      blob(commit, path),
    );
    if (target === base || from === base || target === from || !target || !from) continue;
    const text = (commit: string) => showFile(repo, commit, path);
    if (path === 'design/canvas.json') {
      const [was, main, branch] = [input.base, input.target, input.from].map((commit) => {
        try {
          return JSON.parse(text(commit) || 'null') as Canvas | null;
        } catch {
          return null;
        }
      });
      if (was && main && branch) {
        writes.push({
          path,
          content: `${JSON.stringify(mergeCanvas(was, main, branch), null, 2)}\n`,
        });
        continue;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'design-merge-'));
    try {
      const [ours, old, theirs] = ['main', 'base', 'branch'].map((name) => join(dir, name));
      writeFileSync(ours, text(input.target));
      writeFileSync(old, text(input.base));
      writeFileSync(theirs, text(input.from));
      const merged = spawnSync('git', ['merge-file', '-p', ours, old, theirs], {
        encoding: 'utf8',
      });
      if (merged.status !== 0)
        fail(
          `${input.main} changed ${path.replace(/^design\//, '')} since ${input.branch} started, on the same lines. Ask for changes so the branch is brought up to date, then approve again.`,
          409,
        );
      writes.push({ path, content: merged.stdout });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return writes;
}
/** A file's whole text at a commit, last newline kept. */
function showFile(repo: string, commit: string, path: string) {
  const result = spawnSync('git', ['-C', repo, 'show', `${commit}:${path}`], {
    env: gitEnvironment(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : '';
}

async function readCanvas(repo: string, commit: string): Promise<Canvas | null> {
  const bytes = await readFile(repo, commit, 'design/canvas.json');
  if (!bytes) return null;
  try {
    const canvas = JSON.parse(bytes.toString()) as Canvas;
    return canvas && typeof canvas.boards === 'object' ? canvas : null;
  } catch {
    fail('design/canvas.json is not valid JSON', 422);
  }
}

function designBranches(repo: string) {
  const out = gitSync(repo, [
    'for-each-ref',
    '--sort=-committerdate',
    '--count=40',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(committername)',
    'refs/heads/design/',
  ]);
  const main = mainBranch(repo);
  return (out ? out.split('\n') : []).map((line) => {
    const [name, commit, updatedAt, by] = line.split('\t');
    // Edits: the branch's own commits since it left main.
    const edits = Number(gitSync(repo, ['rev-list', '--count', `${main}..${commit}`]) ?? 0);
    return { name, commit, updatedAt, by, edits };
  });
}

function branchSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function createBranch(repo: string, name: string, commit: string) {
  const slug = branchSlug(name);
  if (!slug) fail('Give the design branch a name');
  let branch = `design/${slug}`;
  for (let n = 2; gitSync(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); n++)
    branch = `design/${slug}-${n}`;
  if (
    gitSync(repo, ['update-ref', `refs/heads/${branch}`, commit, '0'.repeat(commit.length)]) ===
    null
  )
    fail('Could not create the design branch', 500);
  return { name: branch, commit };
}

/**
 * Commit `paths` as they are in `from` on top of `target`, and move `branch` to it unless someone
 * moved it first. Synchronous, so an inbox decision can apply it inside its answer.
 */
function copyPaths(
  repo: string,
  input: {
    target: string;
    from: string;
    paths: string[];
    branch: string;
    message: string;
    by: string;
    /** New contents for files, written alongside the copied paths. */
    writes?: { path: string; content: string }[];
  },
) {
  const dir = mkdtempSync(join(tmpdir(), 'design-copy-'));
  const env = {
    ...gitEnvironment(),
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: input.by,
    GIT_AUTHOR_EMAIL: `${input.by}@deploy.local`,
    GIT_COMMITTER_NAME: input.by,
    GIT_COMMITTER_EMAIL: `${input.by}@deploy.local`,
  };
  const git = (args: string[], input?: string) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
      env,
      encoding: 'utf8',
      timeout: 30000,
      input,
    });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
    return result.stdout.trim();
  };
  try {
    git(['read-tree', input.target]);
    for (const path of input.paths) {
      const entry = git(['ls-tree', input.from, '--', path]);
      if (entry) {
        const [mode, , oid] = entry.split('\t')[0].split(' ');
        git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
      } else git(['update-index', '--force-remove', '--', path]);
    }
    for (const write of input.writes ?? []) {
      const oid = git(['hash-object', '-w', '--stdin'], write.content);
      git(['update-index', '--add', '--cacheinfo', `100644,${oid},${write.path}`]);
    }
    const commit = git([
      'commit-tree',
      git(['write-tree']),
      '-p',
      input.target,
      '-m',
      input.message,
    ]);
    if (gitSync(repo, ['update-ref', `refs/heads/${input.branch}`, commit, input.target]) === null)
      fail(`${input.branch} moved meanwhile; try again`, 409);
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The design branch an edit lands on. Editing main (or any non-design ref) starts a design
 * branch, so main only changes through review; `expect` guards against editing a stale branch.
 */
function editBranch(repo: string, body: any, name: string) {
  let branch = String(body?.ref || 'HEAD');
  if (!validRef(branch)) fail('Invalid ref');
  if (!branch.startsWith('design/')) {
    const from = gitSync(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${branch}^{commit}`,
    ]);
    if (!from) fail(`No commit named ${branch} in this project`, 404);
    branch = createBranch(repo, `${name} edits`, from).name;
  }
  const head = gitSync(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (!head) fail(`No design branch named ${branch}`, 404);
  if (body?.expect && body.expect !== head && String(body.ref).startsWith('design/'))
    fail('This design branch changed since you loaded it; reload and edit again', 409);
  return { branch, head: head! };
}

/** A new, empty board styled by the design system, from the frame tool. */
function blankBoard(title: string, w: number, h: number) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="design-board" content="width=${w},height=${h}">
<title>${title}</title>
<link rel="stylesheet" href="../ds/deploy-local/tokens.css">
<link rel="stylesheet" href="../ds/deploy-local/components/bundle.css">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap">
<style>
body{margin:0;min-height:100vh;background:var(--paper);font-family:"Hanken Grotesk",system-ui,sans-serif}
</style>
</head>
<body>
</body>
</html>
`;
}

/** The branch a project's design is approved onto: the repository's default branch. */
function mainBranch(repo: string) {
  return gitSync(repo, ['symbolic-ref', '--short', 'HEAD']) || 'main';
}

/** What a design branch or a design task would change on main, and where it starts from. */
function proposalFor(owner: string, project: any, input: { ref?: string; task?: string }) {
  const repo = project.repositoryPath as string;
  let branch: string;
  let taskId: string | null = null;
  let name: string;
  if (input.task) {
    const task = get('task', owner, input.task);
    if (task.projectId !== project.id) fail('That task belongs to another project', 404);
    branch = currentTaskBranch(task);
    taskId = task.id;
    name = String(task.title).replace(/^Design:\s*/, '');
  } else {
    branch = String(input.ref ?? '');
    if (!branch.startsWith('design/') || !validRef(branch))
      fail('Propose a design branch, like design/title-size');
    name = branch.replace(/^design\//, '');
  }
  const commit = gitSync(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}^{commit}`,
  ]);
  if (!commit) fail(`Nothing is committed on ${branch} yet`, 409);
  const main = mainBranch(repo);
  const head = gitSync(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${main}^{commit}`]);
  if (!head) fail(`${main} has no commits`, 409);
  const base = gitSync(repo, ['merge-base', head, commit]) || head;
  const paths = (
    gitSync(repo, ['diff', '--name-only', '--no-renames', base, commit, '--', 'design/']) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  if (!paths.length) fail(`${branch} changes nothing in design/`, 409);
  return { branch, commit, base, paths, taskId, main, name };
}

// Inbox IDs travel as one URL path segment, so the branch's slashes become tildes.
const branchKey = (branch: string) => branch.replaceAll('/', '~');
function designItemId(projectId: string, branch: string, commit: string) {
  return `design:${projectId}:${branchKey(branch)}:${commit.slice(0, 12)}`;
}

/** Ask for approval in Waiting on you. The same branch at the same commit asks only once. */
/** Links per commit: a commit never changes, so its links are worked out once. */
const linkCache = new Map<string, (BoardLink & { from: string })[]>();

/** The canvas at a commit, read at once for the line a proposal shows; null when it has none. */
function canvasAt(repo: string, commit: string): Canvas | null {
  try {
    return JSON.parse(gitSync(repo, ['show', `${commit}:design/canvas.json`]) ?? 'null');
  } catch {
    return null;
  }
}

export function proposeDesign(owner: string, project: any, input: { ref?: string; task?: string }) {
  const proposal = proposalFor(owner, project, input);
  const boards = proposal.paths
    .filter((path) => path.startsWith('design/boards/'))
    .map((path) => path.slice('design/boards/'.length).replace(/\.html$/, ''));
  const canvas = proposal.paths.includes('design/canvas.json');
  const [before, after] = canvas
    ? [
        canvasAt(project.repositoryPath, proposal.base),
        canvasAt(project.repositoryPath, proposal.commit),
      ]
    : [null, null];
  const notes = canvas ? noteChanges(before, after) : [];
  const marks = canvas ? markChanges(before, after) : 0;
  // canvas.json carries the boards' places too; it counts as its own change only when nothing on it is named.
  const others = proposal.paths.filter(
    (path) =>
      !path.startsWith('design/boards/') &&
      !(path === 'design/canvas.json' && (notes.length || marks || boards.length)),
  ).length;
  const item: InboxItem = {
    id: designItemId(project.id, proposal.branch, proposal.commit),
    kind: 'other',
    title: `Approve the ${boards.length === 1 ? boards[0] : proposal.name} design?`,
    text: changeSummary(proposal.branch, { boards, notes, marks, others }),
    from: 'scout',
    projectId: project.id,
    ...(proposal.taskId ? { taskId: proposal.taskId } : {}),
    createdAt: now(),
    state: 'waiting',
    actions: [
      { id: 'approve', label: 'Approve design', primary: true },
      { id: 'changes', label: 'Ask for changes' },
    ],
  };
  // A newer commit replaces the request for the same branch.
  const stale = `design:${project.id}:${branchKey(proposal.branch)}:`;
  for (const row of list('v2-inbox-native', owner))
    if (row.id.startsWith(stale) && row.id !== item.id && row.item.state === 'waiting')
      save('v2-inbox-native', owner, { ...row, item: { ...row.item, state: 'withdrawn' } });
  return createInboxItem(owner, item, { source: 'design', projectId: project.id, ...proposal });
}

// Approving puts the proposal's design files on main; asking for changes records the note on
// the first changed board and, for an agent's task, sends it to the agent.
registerInboxSource('design', (owner, item, body, context) => {
  const project = requireRepository(owner, context.projectId);
  const repo = project.repositoryPath as string;
  if (body.actionId === 'approve') {
    const target = gitSync(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${context.main}^{commit}`,
    ]);
    if (!target) fail(`${context.main} has no commits`, 409);
    const commit = copyPaths(repo, {
      target,
      from: context.commit,
      paths: context.paths,
      writes: [
        ...mergedWrites(repo, {
          base: context.base,
          target,
          from: context.commit,
          paths: context.paths,
          main: context.main,
          branch: context.branch,
        }),
        ...instanceWrites(repo, target, context.commit, context.paths),
      ],
      branch: context.main,
      message: `${item.title.replace(/^Approve /, 'Approve ').replace(/\?$/, '')} from ${context.branch}`,
      by: owner,
    });
    save('project', owner, {
      ...get('project', owner, project.id),
      head: commit,
      updatedAt: now(),
    });
    queuePushTrigger(owner, project.id, `refs/heads/${context.main}`, commit);
    return;
  }
  if (body.actionId !== 'changes') return;
  const note = String(body.note ?? '').trim();
  const board = (context.paths as string[]).find((path) => path.startsWith('design/boards/'));
  if (board && note)
    save('design-comment', owner, {
      id: id(),
      projectId: project.id,
      board: board.slice('design/boards/'.length),
      layer: null,
      text: note,
      commit: context.commit,
      author: owner,
      resolved: false,
      createdAt: now(),
    });
  if (context.taskId && note) {
    try {
      const task = get('task', owner, context.taskId);
      startRun(owner, task.id, { revision: task.revision, content: note });
    } catch {
      // A busy agent still gets the note as a comment on the board.
    }
  }
});

function presentComment(row: any) {
  return {
    id: row.id,
    board: row.board,
    layer: row.layer ?? null,
    text: row.text,
    author: row.author,
    agent: row.taskId ? { taskId: row.taskId, title: row.agentTitle ?? 'Agent' } : null,
    commit: row.commit ?? null,
    resolved: Boolean(row.resolved),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  };
}

function comments(owner: string, projectId: string, board?: string | null) {
  return list('design-comment', owner)
    .filter((row: any) => row.projectId === projectId && (!board || row.board === board))
    .map(presentComment);
}

// Renders are keyed by commit, so a cached one never goes stale.
const renders = new Map<string, Buffer>();
const renderLimit = 64;

/** Render one board at a commit to PNG with headless Chromium on this computer. */
/**
 * The Chromium to draw boards with. The service may run as root while `pnpm audit:visual:install`
 * ran as the deploy account, so when root has no copy, use the same build from that account.
 */
export function boardBrowser(
  path: string,
  home = (() => {
    const config = readReleaseConfig();
    return config ? homeOf(config.user) : undefined;
  })(),
  exists: (path: string) => boolean = existsSync,
) {
  if (exists(path)) return path;
  const at = path.indexOf('/.cache/ms-playwright/');
  if (!home || at < 0) return null;
  const candidate = home + path.slice(at);
  return exists(candidate) ? candidate : null;
}

export async function renderBoard(repo: string, commit: string, board: string, width: number) {
  const key = `${commit}:${board}:${width}`;
  const cached = renders.get(key);
  if (cached) return cached;
  const canvas = await readCanvas(repo, commit);
  const placed = canvas?.boards[board];
  if (!placed) fail(`${board} is not on the canvas at this commit`, 404);
  const html = await readFile(repo, commit, `design/boards/${board}`);
  if (!html) fail(`design/boards/${board} is missing at this commit`, 404);
  // Inline the design system so the page needs nothing from this server.
  let page = html.toString();
  for (const match of page.matchAll(/<link rel="stylesheet" href="\.\.\/(ds\/[^"]+\.css)">/g)) {
    const css = await readFile(repo, commit, `design/${match[1]}`);
    page = page.replace(match[0], `<style>${css?.toString() ?? ''}</style>`);
  }
  const { chromium } = await import('playwright');
  const executablePath = boardBrowser(chromium.executablePath());
  if (!executablePath)
    fail('Rendering boards needs Chromium on the coordinator: run pnpm audit:visual:install', 503);
  const browser = await chromium.launch({ executablePath });
  try {
    const context = await browser.newContext({
      viewport: { width, height: placed.h },
      javaScriptEnabled: false,
    });
    await context.route('**/*', (route) =>
      /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(route.request().url())
        ? route.continue()
        : route.abort(),
    );
    const tab = await context.newPage();
    await tab.setContent(page, { waitUntil: 'load', timeout: 15000 });
    const png = await tab.screenshot();
    renders.set(key, png);
    if (renders.size > renderLimit) renders.delete(renders.keys().next().value!);
    return png;
  } finally {
    await browser.close();
  }
}

/** What an agent asked about a layer needs to know: the request, the element, and the rules. */
/** What an agent asked to change a design-system component is told. */
export function componentPrompt(input: {
  component: Library['components'][number];
  used: string[];
  text: string;
  ref: string;
  commit: string;
}) {
  return [
    `Design request about the ${input.component.name} component (\`${input.component.id}\` in \`${libraryPath}\`), starting from ${input.ref} at ${input.commit.slice(0, 8)}.`,
    '',
    input.text.trim(),
    '',
    'The component as it is now:',
    '```json',
    JSON.stringify(input.component, null, 2).slice(0, 6000),
    '```',
    '',
    input.used.length
      ? `Boards with instances of it: ${input.used.map((board) => `design/boards/${board}`).join(', ')}. Approving this change on main renders every instance again from the library, keeping each one's values.`
      : 'No board uses it yet.',
    '',
    'How to work:',
    `- Change the component's entry in ${libraryPath}: its html (with {{property}} placeholders), props, name or description. Keep its id.`,
    '- Use only the design system in design/ds (the dl-* classes and the tokens). Follow design/ds/README.md.',
    '- Commit as you go with deploy_checkpoint and deploy_commit. Do not build the change in the app: this task is the design only.',
    '- End by saying what you changed and why.',
  ].join('\n');
}

export function askPrompt(input: {
  board: string;
  layer: string | null;
  text: string;
  ref: string;
  commit: string;
  snippet: string | null;
  openComments: string[];
}) {
  const where = input.layer
    ? `the layer \`${input.layer}\` on the board \`design/boards/${input.board}\``
    : `the board \`design/boards/${input.board}\``;
  return [
    `Design request about ${where}, starting from ${input.ref} at ${input.commit.slice(0, 8)}.`,
    '',
    input.text.trim(),
    ...(input.snippet
      ? ['', 'The selected element as it is now:', '```html', input.snippet.slice(0, 4000), '```']
      : []),
    ...(input.openComments.length
      ? ['', 'Open comments on it:', ...input.openComments.map((text) => `- ${text}`)]
      : []),
    '',
    'How to work:',
    '- Change only files in design/. Keep every existing data-layer ID; after adding elements, run `node scripts/design-layers.mjs` on the boards you changed.',
    '- Use only the design system in design/ds (the dl-* classes and the tokens). Follow design/ds/README.md.',
    '- Render each board you change with `node design/tools/render.mjs <Board>` and look at every width before you finish.',
    '- Before you change a board or a layer, call deploy_design with action presence (board, layer, a short note) so the person watching sees where you work.',
    '- Commit as you go with deploy_checkpoint and deploy_commit, so the Design page shows your changes while you work. Do not build the change in the app: this task is the design only.',
    '- Read open comments with deploy_design action comments, and resolve the ones you addressed.',
    '- End by saying what you changed, board by board, and what you checked.',
  ].join('\n');
}

// Where agents are working right now, by owner and project. Presence is a hint for people
// watching, so it lives in memory and lapses after a minute without an update.
type Presence = {
  taskId: string;
  title: string;
  board: string;
  layer: string | null;
  note: string;
  at: number;
};
const presence = new Map<string, Map<string, Presence>>();
const presenceLife = 60_000;
function livePresence(owner: string, projectId: string) {
  const here = presence.get(`${owner}\0${projectId}`);
  if (!here) return [];
  const cutoff = Date.now() - presenceLife;
  for (const [taskId, entry] of here) if (entry.at < cutoff) here.delete(taskId);
  return [...here.values()];
}

/**
 * deploy_design: what an agent working on a project's design can do beyond editing files.
 * It reads and edits design/ in its own workspace and renders with design/tools/render.mjs;
 * this tool shows where it works, handles comments, and asks for review.
 */
export function designTool(scope: { owner: string; taskId: string }, args: any) {
  const task = get('task', scope.owner, scope.taskId);
  if (!task.projectId) fail('This conversation has no repository project');
  const project = requireRepository(scope.owner, task.projectId);
  const board = args.board == null ? null : String(args.board);
  const layer = args.layer == null ? null : String(args.layer);
  if (board !== null && !boardPattern.test(board))
    fail('board must be a file in design/boards, like Welcome.html');
  if (layer !== null && !layerPattern.test(layer)) fail('layer must be a data-layer ID');
  switch (args.action) {
    case 'presence': {
      const key = `${scope.owner}\0${project.id}`;
      const here = presence.get(key) ?? new Map<string, Presence>();
      presence.set(key, here);
      if (!board) {
        here.delete(task.id);
        return { presence: null };
      }
      const entry: Presence = {
        taskId: task.id,
        title: String(task.title ?? 'Agent').replace(/^Design:\s*/, ''),
        board,
        layer,
        note: String(args.note ?? '').slice(0, 200),
        at: Date.now(),
      };
      here.set(task.id, entry);
      return { presence: entry };
    }
    case 'comments':
      return {
        comments: comments(scope.owner, project.id, board).filter(
          (comment) => args.all || !comment.resolved,
        ),
      };
    case 'comment': {
      const text = String(args.text ?? '').trim();
      if (!board) fail('Name the board the comment is on');
      if (!text || text.length > 4000) fail('A comment needs 1 to 4000 characters');
      const row = save('design-comment', scope.owner, {
        id: id(),
        projectId: project.id,
        board,
        layer,
        text,
        commit: null,
        author: scope.owner,
        taskId: task.id,
        agentTitle: String(task.title ?? 'Agent'),
        resolved: false,
        createdAt: now(),
      });
      return { comment: presentComment(row) };
    }
    case 'resolve': {
      const row = get('design-comment', scope.owner, String(args.commentId ?? ''));
      if (row.projectId !== project.id) fail('Not found', 404);
      return {
        comment: presentComment(
          save('design-comment', scope.owner, { ...row, resolved: true, resolvedAt: now() }),
        ),
      };
    }
    case 'propose':
      return { item: proposeDesign(scope.owner, project, { task: task.id }) };
    default:
      fail('action must be presence, comments, comment, resolve or propose');
  }
}

export async function designApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  // Every project and how many boards its design has on main, for the project picker.
  if (url.pathname === '/api/v2/design/projects' && req.method === 'GET') {
    const projects = list('project', owner).filter((row: any) => row.repositoryPath);
    const designs = await Promise.all(
      projects.map(async (row: any) => {
        let boards = 0;
        try {
          boards = Object.keys((await readCanvas(row.repositoryPath, 'HEAD'))?.boards ?? {}).length;
        } catch {
          // A canvas that is not valid JSON counts as no design.
        }
        return { id: row.id, name: row.name, boards };
      }),
    );
    return sendJson(res, { projects: designs });
  }
  const route = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/design(\/.*)?$/);
  if (!route) return false;
  const projectId = decodeURIComponent(route[1]);
  const project = requireRepository(owner, projectId);
  const repo = project.repositoryPath as string;
  const sub = route[2] ?? '';

  if (sub === '' && req.method === 'GET') {
    const { ref, commit } = resolveCommit(owner, project.id, repo, url);
    const canvas = await readCanvas(repo, commit);
    const open = comments(owner, project.id).filter((comment) => !comment.resolved);
    return sendJson(res, {
      ref,
      commit,
      canvas,
      branches: designBranches(repo),
      openComments: open.length,
    });
  }

  // Board files are served at a commit, so relative links (../ds/…) resolve to the same commit.
  const file = sub.match(/^\/files\/([0-9a-f]+)\/((?:boards|ds)\/[A-Za-z0-9_./-]+)$/);
  if (file) {
    if (req.method !== 'GET' && req.method !== 'HEAD') fail('Method not allowed', 405);
    const [, commit, path] = file;
    if (!commitPattern.test(commit) || path.split('/').includes('..')) fail('Not found', 404);
    const type = fileTypes[path.split('.').pop()!];
    if (!type) fail('Not found', 404);
    const bytes = await readFile(repo, commit, `design/${path}`);
    if (!bytes) fail('Not found', 404);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': bytes.length,
      'Content-Security-Policy': boardPolicy,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  }

  if (sub === '/branches' && req.method === 'POST') {
    const body = await readJson(req);
    const from = String(body?.from || 'HEAD');
    if (!validRef(from)) fail('Invalid ref');
    const commit = gitSync(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${from}^{commit}`,
    ]);
    if (!commit) fail(`No commit named ${from} in this project`, 404);
    return sendJson(res, { branch: createBranch(repo, String(body?.name ?? ''), commit) }, 201);
  }

  if (sub === '/comments') {
    if (req.method === 'GET')
      return sendJson(res, {
        comments: comments(owner, project.id, url.searchParams.get('board')),
      });
    if (req.method === 'POST') {
      const body = await readJson(req);
      const board = String(body?.board ?? '');
      const layer = body?.layer == null ? null : String(body.layer);
      const text = String(body?.text ?? '').trim();
      if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
      if (layer !== null && !layerPattern.test(layer)) fail('Invalid layer');
      if (!text || text.length > 4000) fail('A comment needs 1 to 4000 characters');
      const commit =
        body?.commit && commitPattern.test(String(body.commit)) ? String(body.commit) : null;
      const row = save('design-comment', owner, {
        id: id(),
        projectId: project.id,
        board,
        layer,
        text,
        commit,
        author: owner,
        resolved: false,
        createdAt: now(),
      });
      return sendJson(res, { comment: presentComment(row) }, 201);
    }
    fail('Method not allowed', 405);
  }

  const comment = sub.match(/^\/comments\/([A-Za-z0-9-]+)$/);
  if (comment) {
    if (req.method !== 'PATCH') fail('Method not allowed', 405);
    const row = get('design-comment', owner, comment[1]);
    if (row.projectId !== project.id) fail('Not found', 404);
    const body = await readJson(req);
    if (typeof body?.resolved !== 'boolean') fail('Send resolved: true or false');
    const next = save('design-comment', owner, {
      ...row,
      resolved: body.resolved,
      resolvedAt: body.resolved ? now() : null,
    });
    return sendJson(res, { comment: presentComment(next) });
  }

  // What a branch or a task changed in design/, against main (or `base`).
  // Every link between boards at a commit, for Prototype's lines and Play: which layer of which
  // board opens which board. Sidebar links are marked; nearly every board repeats them.
  if (sub === '/links' && req.method === 'GET') {
    const { commit } = resolveCommit(owner, project.id, repo, url);
    const key = `${repo}:${commit}`;
    let links = linkCache.get(key);
    if (!links) {
      const canvas = await readCanvas(repo, commit);
      const files = Object.keys(canvas?.boards ?? {});
      const found = await Promise.all(
        files.map(async (file) => {
          const html = await readFile(repo, commit, `design/boards/${file}`);
          return html ? boardLinks(html.toString()).map((link) => ({ from: file, ...link })) : [];
        }),
      );
      links = found.flat();
      linkCache.set(key, links);
      if (linkCache.size > 20) linkCache.delete(linkCache.keys().next().value!);
    }
    return sendJson(res, { commit, links });
  }

  if (sub === '/changes' && req.method === 'GET') {
    const { commit } = resolveCommit(owner, project.id, repo, url);
    const base = url.searchParams.get('base') || 'HEAD';
    if (!validRef(base)) fail('Invalid base');
    const baseCommit = gitSync(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${base}^{commit}`,
    ]);
    if (!baseCommit) fail(`No commit named ${base} in this project`, 404);
    const mergeBase = gitSync(repo, ['merge-base', baseCommit, commit]) || baseCommit;
    const out = gitSync(repo, [
      'diff',
      '--name-status',
      '--no-renames',
      mergeBase,
      commit,
      '--',
      'design/',
    ]);
    const files = await Promise.all(
      (out ? out.split('\n') : []).map(async (line) => {
        const [code, path] = line.split('\t');
        const status = code === 'A' ? 'added' : code === 'D' ? 'removed' : 'changed';
        // A changed board also says what changed in it, layer by layer.
        if (status !== 'changed' || !/^design\/boards\/[^/]+\.html$/.test(path))
          return { status, path };
        const [before, after] = await Promise.all([
          readFile(repo, mergeBase, path),
          readFile(repo, commit, path),
        ]);
        return {
          status,
          path,
          layers: before && after ? layerChanges(before.toString(), after.toString()) : [],
        };
      }),
    );
    return sendJson(res, { base: mergeBase, commit, files });
  }

  if (sub === '/render' && req.method === 'GET') {
    const { commit } = resolveCommit(owner, project.id, repo, url);
    const board = String(url.searchParams.get('board') ?? '');
    if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
    const width = Number(url.searchParams.get('width') ?? 1440);
    if (!Number.isInteger(width) || width < 320 || width > 2560) fail('Width must be 320 to 2560');
    const png = await renderBoard(repo, commit, board, width);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.end(png);
    return true;
  }

  if (sub === '/ask' && req.method === 'POST') {
    const body = await readJson(req);
    const board = String(body?.board ?? '');
    const layer = body?.layer == null ? null : String(body.layer);
    const text = String(body?.text ?? '').trim();
    // Asking about a design-system component changes the component, and so every instance.
    if (body?.component != null) {
      const componentId = String(body.component);
      if (!text || text.length > 8000)
        fail('Say what you want changed, in at most 8000 characters');
      const { ref, commit } = resolveCommit(owner, project.id, repo, url);
      const library = parseLibrary((await readFile(repo, commit, libraryPath))?.toString());
      const component = library?.components.find((item) => item.id === componentId);
      if (!component) fail(`The design system has no component ${componentId}`, 404);
      const used = componentUsage(repo, commit)[componentId] ?? [];
      const task = queueTask(owner, {
        projectId: project.id,
        title: `Design: ${component!.name} component`,
        ref: commit,
        workerId: body?.workerId,
        model: body?.model,
        prompt: componentPrompt({ component: component!, used, text, ref, commit }),
      });
      save('task', owner, {
        ...get('task', owner, task.id),
        design: {
          board: used[0] ?? '',
          layer: null,
          component: componentId,
          ref,
          commit,
          text,
          askedAt: now(),
        },
      });
      return sendJson(
        res,
        { task: { id: task.id, title: task.title, branch: currentTaskBranch(task) } },
        201,
      );
    }
    if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
    if (layer !== null && !layerPattern.test(layer)) fail('Invalid layer');
    if (!text || text.length > 8000) fail('Say what you want changed, in at most 8000 characters');
    const { ref, commit } = resolveCommit(owner, project.id, repo, url);
    const html = await readFile(repo, commit, `design/boards/${board}`);
    if (!html) fail(`design/boards/${board} is missing at this commit`, 404);
    const snippet = layer ? layerSnippet(html.toString(), layer) : null;
    if (layer && !snippet) fail(`${board} has no layer ${layer}`, 404);
    const openComments = comments(owner, project.id, board)
      .filter((row) => !row.resolved && (!layer || row.layer === layer))
      .map((row) => row.text);
    const name = board.replace(/\.html$/, '');
    const task = queueTask(owner, {
      projectId: project.id,
      title: `Design: ${name}${layer ? ` › ${layer}` : ''}`,
      ref: commit,
      workerId: body?.workerId,
      model: body?.model,
      prompt: askPrompt({ board, layer, text, ref, commit, snippet, openComments }),
    });
    save('task', owner, {
      ...get('task', owner, task.id),
      design: { board, layer, ref, commit, text, askedAt: now() },
    });
    return sendJson(
      res,
      { task: { id: task.id, title: task.title, branch: currentTaskBranch(task) } },
      201,
    );
  }

  // Assets: the design system's components and where each is used, at a ref.
  if (sub === '/components' && req.method === 'GET') {
    const ref = url.searchParams.get('ref') || 'HEAD';
    if (!validRef(ref)) fail('Invalid ref');
    const commit = gitSync(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    if (!commit) fail(`No commit named ${ref} in this project`, 404);
    const library = parseLibrary((await readFile(repo, commit!, libraryPath))?.toString());
    return sendJson(res, { commit, library, usage: library ? componentUsage(repo, commit!) : {} });
  }

  // Direct edits from the properties panel and the canvas, committed to a design branch.
  if (sub === '/edit' && req.method === 'POST') {
    const body = await readJson(req);
    const board = String(body?.board ?? '');
    if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
    const edits = body?.edits;
    if (!Array.isArray(edits) || !edits.length || edits.length > 50) fail('Send 1 to 50 edits');
    const { branch, head } = editBranch(repo, body, board.replace(/\.html$/, ''));
    const html = await readFile(repo, head, `design/boards/${board}`);
    if (!html) fail(`design/boards/${board} is missing on ${branch}`, 404);
    const main = gitSync(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${mainBranch(repo)}^{commit}`,
    ]);
    const base = main ? await readFile(repo, main, `design/boards/${board}`) : null;
    const library = edits.some((edit: any) => edit.op === 'insert' && edit.component)
      ? parseLibrary((await readFile(repo, head, libraryPath))?.toString())
      : undefined;
    let next: string;
    try {
      next = applyEdits(html.toString(), edits, base?.toString(), library ?? undefined);
    } catch (error) {
      fail((error as Error).message);
    }
    if (next === html.toString()) return sendJson(res, { branch, commit: head, layers: [] });
    const before = new Set(layerIds(html.toString()));
    const layers = layerIds(next).filter((layer) => !before.has(layer));
    const kinds = [
      ...new Set(
        edits.map((edit: any) =>
          edit.op === 'style'
            ? edit.prop
            : edit.op === 'insert'
              ? (edit.shape?.kind ?? edit.component?.id)
              : edit.op,
        ),
      ),
    ];
    const commit = copyPaths(repo, {
      target: head,
      from: head,
      paths: [],
      branch,
      message: `Edit ${board.replace(/\.html$/, '')}: ${kinds.slice(0, 4).join(', ')}`,
      by: owner,
      writes: [{ path: `design/boards/${board}`, content: next }],
    });
    return sendJson(res, { branch, commit, layers });
  }

  // The canvas itself: new boards from the frame tool, and sticky notes.
  if (sub === '/canvas' && req.method === 'POST') {
    const body = await readJson(req);
    const op = body?.op;
    const { branch, head } = editBranch(repo, body, op === 'board' ? 'new board' : 'notes');
    const canvas = await readCanvas(repo, head);
    if (!canvas) fail('This design has no canvas.json', 404);
    const notes = (canvas!.notes ??= {}) as Record<string, any>;
    const at = (value: unknown) => {
      const n = Number(value);
      if (!Number.isFinite(n) || Math.abs(n) > 1e7) fail('A position is out of bounds');
      return Math.round(n);
    };
    const writes: { path: string; content: string }[] = [];
    let made: string;
    if (op === 'note') {
      const text = String(body.text ?? '').slice(0, 4000);
      if (body.id) {
        if (!notes[body.id]) fail(`No note named ${body.id}`, 404);
        notes[body.id] = {
          ...notes[body.id],
          text,
          ...(body.x !== undefined ? { x: at(body.x), y: at(body.y) } : {}),
        };
        made = body.id;
      } else {
        made = `note-${randomUUID().slice(0, 8)}`;
        notes[made] = { x: at(body.x), y: at(body.y), w: 240, h: 160, text };
      }
    } else if (op === 'mark') {
      // A pen mark on the canvas: drawn from its points, then changed a property at a time.
      const number = (value: unknown, low: number, high: number, name: string) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < low || n > high) fail(`${name} must be ${low} to ${high}`);
        return Math.round(n * 10) / 10;
      };
      if (body.id) {
        const mark = notes[body.id];
        if (mark?.kind !== 'mark') fail(`No mark named ${body.id}`, 404);
        if (body.x !== undefined) mark.x = at(body.x);
        if (body.y !== undefined) mark.y = at(body.y);
        if (body.w !== undefined) mark.w = number(body.w, 1, 20000, 'W');
        if (body.h !== undefined) mark.h = number(body.h, 1, 20000, 'H');
        if (body.rotate !== undefined) mark.rotate = number(body.rotate, -360, 360, 'Rotation');
        if (body.width !== undefined) mark.width = number(body.width, 0.5, 40, 'Stroke width');
        if (body.opacity !== undefined) mark.opacity = number(body.opacity, 0, 1, 'Opacity');
        if (body.stroke !== undefined) {
          if (!markColors.includes(String(body.stroke))) fail('Pick a stroke colour token');
          mark.stroke = String(body.stroke);
        }
        if (body.arrow !== undefined) mark.arrow = Boolean(body.arrow);
        if (body.hidden !== undefined) mark.hidden = Boolean(body.hidden);
        made = body.id;
      } else {
        const points = body.points;
        if (!Array.isArray(points) || points.length < 2 || points.length > 2000)
          fail('A mark needs 2 to 2000 points');
        const xy = (points as unknown[]).map((point) => {
          if (!Array.isArray(point)) fail('A point is [x, y]');
          return [at((point as number[])[0]), at((point as number[])[1])];
        });
        const left = Math.min(...xy.map(([x]) => x));
        const top = Math.min(...xy.map(([, y]) => y));
        const pw = Math.max(1, Math.max(...xy.map(([x]) => x)) - left);
        const ph = Math.max(1, Math.max(...xy.map(([, y]) => y)) - top);
        const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x - left} ${y - top}`).join(' ');
        made = `mark-${randomUUID().slice(0, 8)}`;
        notes[made] = {
          kind: 'mark',
          x: left,
          y: top,
          w: pw,
          h: ph,
          pw,
          ph,
          path,
          stroke: markColors.includes(String(body.stroke)) ? String(body.stroke) : 'danger',
          width: body.width !== undefined ? number(body.width, 0.5, 40, 'Stroke width') : 2.5,
        };
      }
    } else if (op === 'start') {
      // Where Play starts on a page; null goes back to the page's first board.
      const page = String(body.page ?? '');
      if (!/^section-[a-z0-9-]{1,60}$/.test(page)) fail('Name a page');
      const starts = ((canvas as any).starts ??= {}) as Record<string, string>;
      if (body.board === null) delete starts[page];
      else {
        if (!canvas!.boards[String(body.board)]) fail(`No board named ${body.board}`, 404);
        starts[page] = String(body.board);
      }
      made = page;
    } else if (op === 'remove-note') {
      if (!notes[body.id] || String(body.id).startsWith('section-')) fail('No such note', 404);
      delete notes[body.id];
      made = body.id;
    } else if (op === 'board') {
      const phone = body.kind === 'phone';
      const [w, h] = phone ? [390, 844] : [1440, 900];
      let n = 1;
      while (canvas!.boards[`Board${n}.html`]) n++;
      made = `Board${n}.html`;
      canvas!.boards[made] = { x: at(body.x), y: at(body.y), w, h, title: `Board ${n}` };
      if (Array.isArray((canvas as any).order)) (canvas as any).order.push(made);
      writes.push({ path: `design/boards/${made}`, content: blankBoard(`Board ${n}`, w, h) });
    } else fail('Unknown canvas edit');
    writes.push({ path: 'design/canvas.json', content: `${JSON.stringify(canvas, null, 2)}\n` });
    const commit = copyPaths(repo, {
      target: head,
      from: head,
      paths: [],
      branch,
      message:
        op === 'board'
          ? `Add ${made!.replace(/\.html$/, '')}`
          : op === 'mark'
            ? body.id
              ? 'Edit a mark on the canvas'
              : 'Draw a mark on the canvas'
            : 'Edit canvas notes',
      by: owner,
      writes,
    });
    return sendJson(res, { branch, commit, made: made! });
  }

  // The design tasks of this project, newest first, for the overlay and the menu.
  if (sub === '/asks' && req.method === 'GET') {
    const asks = list('task', owner)
      .filter((task: any) => task.projectId === project.id && task.design)
      .sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 20)
      .map((task: any) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        branch: currentTaskBranch(task),
        ...task.design,
      }));
    return sendJson(res, { asks });
  }

  // Accept an agent's design changes: copy its version of the chosen design files onto a design
  // branch. Accepting while viewing main starts a new design branch, so main only changes through review.
  if (sub === '/accept' && req.method === 'POST') {
    const body = await readJson(req);
    const task = get('task', owner, String(body?.task ?? ''));
    if (task.projectId !== project.id || !task.design)
      fail('That is not a design task of this project', 404);
    const agentRef = `refs/heads/${currentTaskBranch(task)}`;
    const agent = gitSync(repo, ['rev-parse', '--verify', '--quiet', `${agentRef}^{commit}`]);
    if (!agent) fail('The agent has not committed any design changes yet', 409);
    let into = String(body?.into || 'HEAD');
    if (!validRef(into)) fail('Invalid branch');
    if (!into.startsWith('design/')) {
      const from = gitSync(repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${into}^{commit}`,
      ]);
      if (!from) fail(`No commit named ${into} in this project`, 404);
      into = createBranch(repo, task.title.replace(/^Design:\s*/, ''), from).name;
    }
    const target = gitSync(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${into}^{commit}`,
    ]);
    if (!target) fail(`No design branch named ${into}`, 404);
    const base = task.design.commit as string;
    const changed = (
      gitSync(repo, ['diff', '--name-only', '--no-renames', base, agent, '--', 'design/']) ?? ''
    )
      .split('\n')
      .filter(Boolean);
    const paths: string[] = Array.isArray(body?.paths) ? body.paths.map(String) : changed;
    if (!paths.length) fail('Choose at least one change to accept');
    if (paths.some((path) => !changed.includes(path)))
      fail('Only the agent’s design changes can be accepted');
    const commit = copyPaths(repo, {
      target,
      from: agent,
      paths,
      branch: into,
      message: `Accept ${paths.length === 1 ? paths[0].replace(/^design\//, '') : `${paths.length} design changes`} from ${task.title}`,
      by: owner,
    });
    return sendJson(res, { branch: into, commit, accepted: paths });
  }

  // Ask for approval of a design branch or a design task, in Waiting on you.
  if (sub === '/propose' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(
      res,
      { item: proposeDesign(owner, project, { ref: body?.ref, task: body?.task }) },
      201,
    );
  }

  // Agents working on this design right now.
  if (sub === '/presence' && req.method === 'GET')
    return sendJson(res, { agents: livePresence(owner, project.id) });

  // Open design reviews of this project, newest first.
  // One design review, as the apps show it: the request, Before and After, and per changed board
  // its page, size, notes and the changes in a line each.
  if (sub === '/review' && req.method === 'GET') {
    const id = String(url.searchParams.get('item') ?? '');
    if (!id.startsWith(`design:${project.id}:`)) fail('Name a design review of this project', 404);
    const row = list('v2-inbox-native', owner).find((entry: any) => entry.id === id);
    const item = syncInbox(owner).find((entry) => entry.id === id);
    if (!row || !item) fail('No such design review', 404);
    const context = row!.context;
    const canvas = await readCanvas(repo, context.commit);
    const beforeCanvas = await readCanvas(repo, context.base);
    const pages = canvas ? sections(canvas) : [];
    const beforePages = beforeCanvas ? sections(beforeCanvas) : [];
    const boards = [];
    for (const path of (context.paths as string[]).filter((entry) =>
      entry.startsWith('design/boards/'),
    )) {
      const file = path.slice('design/boards/'.length);
      const before = (await readFile(repo, context.base, path))?.toString() ?? null;
      const after = (await readFile(repo, context.commit, path))?.toString() ?? null;
      const placed = canvas?.boards[file] ?? beforeCanvas?.boards[file];
      const page = (after ? pages : beforePages).find((section) => section.boards.includes(file));
      const changes = before && after ? layerChanges(before, after) : [];
      const notes = await readFile(
        repo,
        after ? context.commit : context.base,
        `design/notes/${file.replace(/\.html$/, '.md')}`,
      );
      boards.push({
        file,
        title: placed?.title ?? file.replace(/\.html$/, ''),
        w: placed?.w ?? 1440,
        h: placed?.h ?? 900,
        page: page?.title ?? null,
        index: page ? page.boards.indexOf(file) + 1 : null,
        count: page?.boards.length ?? null,
        added: !before,
        removed: !after,
        notes: notes ? notes.toString().slice(0, 2000) : null,
        lines: changes.slice(0, 12).map((change) => {
          const snippet = after ? layerSnippet(after, change.layer) : null;
          const own = snippet ? snippet.replace(/<[^>]+>/g, ' ') : '';
          return describeChange(change, layerLabel(change.layer, own));
        }),
      });
    }
    let task: string | null = null;
    try {
      task = context.taskId ? String(get('task', owner, context.taskId).title) : null;
    } catch {
      // A removed task leaves the review without its name.
    }
    // Canvas notes the branch rewrote, line by line, each with the page it sits on.
    const notes = (context.paths as string[]).includes('design/canvas.json')
      ? noteChanges(await readCanvas(repo, context.base), canvas).map((change) => {
          const note = canvas?.notes?.[change.id];
          const page = note ? sectionAt(pages, note)?.title : null;
          return { ...change, page: change.id.startsWith('section-') ? null : (page ?? null) };
        })
      : [];
    return sendJson(res, {
      item,
      task,
      branch: context.branch,
      before: context.base,
      after: context.commit,
      boards,
      notes,
    });
  }

  if (sub === '/proposals' && req.method === 'GET') {
    const prefix = `design:${project.id}:`;
    // Each request also names the boards it would change, so the canvas can mark them In review.
    const contexts = new Map(
      list('v2-inbox-native', owner)
        .filter((row: any) => row.id.startsWith(prefix))
        .map((row: any) => [row.id, row.context]),
    );
    const items = syncInbox(owner)
      .filter((item) => item.id.startsWith(prefix))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((item) => ({
        ...item,
        branch: contexts.get(item.id)?.branch ?? null,
        boards: ((contexts.get(item.id)?.paths ?? []) as string[])
          .filter((path) => path.startsWith('design/boards/'))
          .map((path) => path.slice('design/boards/'.length)),
      }));
    return sendJson(res, { proposals: items });
  }

  fail('Not found', 404);
}
