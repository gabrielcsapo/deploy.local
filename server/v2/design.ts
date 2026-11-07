import { gitString, tryGitText } from '../git.ts';
import { mkdtemp, readFile as readDiskFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deployDataPath } from '../data-directory.ts';
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
import { keyedSlots, withRepositoryWrites } from '../workspace/repository-lock.ts';
import {
  gitEnvironment,
  gitRead as readGitOutput,
  repositoryGit,
} from '../workspace/repository-git.ts';
import { db, event, get, id, list, now, save } from '../workspace/store.ts';
import { queueTask } from '../workspace/task-workspace.ts';
import { readJson, sendJson } from './attachments.ts';
import { createInboxItem, registerInboxSource, syncInbox } from './inbox.ts';
import { fail } from '../errors.ts';
import { queuePushTrigger } from '../workspace/pipeline-triggers.ts';
import { queueMessage, queuedMessage } from '../workspace/queued-message.ts';
import {
  validReviewDrawing,
  reviewAreas,
  reviewCrop,
  reviewWidths,
  screenName,
} from '../../shared/v2/design-review.ts';
import type {
  DesignRect,
  DesignReview,
  DesignReviewPin,
  DesignReviewPreview,
  DesignReviewScreen,
  DesignReviewSummary,
  InboxItem,
} from '../../shared/v2/contracts.ts';
import {
  changeSummary,
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
 *
 * All Git here is awaited, so the server keeps answering while it runs. Reads name a commit, which
 * never changes, so they need no lock and see one consistent state. Anything that reads a ref,
 * builds on it and moves it holds withRepositoryWrites from the first read to the last write.
 */

// A review or a canvas full of boards asks for hundreds of files at once, and starting that many
// Git processes in one go stalls the server by itself (scripts/perf/design-event-loop.ts: 312 took
// 265 ms). 32 per repository removes the stall; 8 also did, but made a canvas take twice as long.
const gitSlots = keyedSlots(32);
const gitRead = (repo: string, args: string[]) => gitSlots(repo, () => readGitOutput(repo, args));
const reviewGit = (repo: string, args: string[]) => gitSlots(repo, () => tryGitText(repo, args));
const pickerSlots = keyedSlots(8);

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
async function resolveCommit(owner: string, projectId: string, repo: string, url: URL) {
  const taskId = url.searchParams.get('task');
  let ref = url.searchParams.get('ref') || 'HEAD';
  if (taskId) {
    const task = get('task', owner, taskId);
    if (task.projectId !== projectId) fail('That task belongs to another project', 404);
    const branch = `refs/heads/${currentTaskBranch(task)}`;
    ref = (await gitRead(repo, ['rev-parse', '--verify', '--quiet', branch]))
      ? branch
      : task.baseRevision;
  }
  if (!validRef(ref)) fail('Invalid ref');
  const commit = await gitRead(repo, [
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
    return await gitSlots(repo, () =>
      repositoryGit(repo, ['show', `${commit}:${path}`], { limit }),
    );
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
async function componentUsage(repo: string, commit: string) {
  const out = await gitRead(repo, [
    'grep',
    '-o',
    '-I',
    'data-component="[a-z0-9-]*"',
    commit,
    '--',
    'design/boards',
  ]);
  const usage: Record<string, string[]> = {};
  for (const line of (out ?? '').split('\n')) {
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
async function instanceWrites(repo: string, target: string, from: string, paths: string[]) {
  if (!paths.includes(libraryPath)) return [];
  const library = parseLibrary(await gitRead(repo, ['show', `${from}:${libraryPath}`]));
  if (!library) return [];
  const [onTarget, onFrom] = await Promise.all([
    componentUsage(repo, target),
    componentUsage(repo, from),
  ]);
  const boards = new Set([
    ...Object.values(onTarget).flat(),
    ...Object.values(onFrom)
      .flat()
      .filter((board) => paths.includes(`design/boards/${board}`)),
  ]);
  const writes = await Promise.all(
    [...boards].map(async (board) => {
      const path = `design/boards/${board}`;
      const html = await gitRead(repo, ['show', `${paths.includes(path) ? from : target}:${path}`]);
      if (!html) return null;
      const synced = syncInstances(html, library);
      // gitRead trims the file's last newline; put it back.
      return synced !== html ? { path, content: `${synced}\n` } : null;
    }),
  );
  return writes.filter((write) => write !== null);
}

/**
 * Files the branch changed that main also changed since the branch started, merged: canvas.json
 * entry by entry, anything else line by line. Approving writes these instead of the branch's copy,
 * so it never undoes what main gained meanwhile. Edits to the same lines stop the approval.
 */
async function mergedWrites(
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
    gitRead(repo, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
  const writes: { path: string; content: string }[] = [];
  for (const path of input.paths) {
    const [base, target, from] = await Promise.all(
      [input.base, input.target, input.from].map((commit) => blob(commit, path)),
    );
    if (target === base || from === base || target === from || !target || !from) continue;
    const [baseText, targetText, fromText] = await Promise.all(
      [input.base, input.target, input.from].map((commit) => showFile(repo, commit, path)),
    );
    if (path === 'design/canvas.json') {
      const [was, main, branch] = [baseText, targetText, fromText].map((text) => {
        try {
          return JSON.parse(text || 'null') as Canvas | null;
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
    const dir = await mkdtemp(join(tmpdir(), 'design-merge-'));
    try {
      const [ours, old, theirs] = ['main', 'base', 'branch'].map((name) => join(dir, name));
      await Promise.all([
        writeFile(ours, targetText),
        writeFile(old, baseText),
        writeFile(theirs, fromText),
      ]);
      // merge-file exits with the number of conflicts, so any failure stops the approval.
      const merged = await gitSlots(repo, () =>
        repositoryGit(dir, ['merge-file', '-p', ours, old, theirs]),
      ).catch(() => null);
      if (merged === null)
        fail(
          `${input.main} changed ${path.replace(/^design\//, '')} since ${input.branch} started, on the same lines. Ask for changes so the branch is brought up to date, then approve again.`,
          409,
        );
      writes.push({ path, content: merged.toString() });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return writes;
}
/** A file's whole text at a commit, last newline kept. */
async function showFile(repo: string, commit: string, path: string) {
  try {
    return (
      await gitSlots(repo, () =>
        repositoryGit(repo, ['show', `${commit}:${path}`], { limit: 16 * 1024 * 1024 }),
      )
    ).toString();
  } catch {
    return '';
  }
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

async function designBranches(repo: string) {
  const out = await gitRead(repo, [
    'for-each-ref',
    '--sort=-committerdate',
    '--count=40',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(committername)',
    'refs/heads/design/',
  ]);
  const main = (await gitRead(repo, ['symbolic-ref', '--short', 'HEAD'])) || 'main';
  return Promise.all(
    (out ? out.split('\n') : []).map(async (line) => {
      const [name, commit, updatedAt, by] = line.split('\t');
      // Edits: the branch's own commits since it left main.
      const edits = Number(
        (await gitRead(repo, ['rev-list', '--count', `${main}..${commit}`])) ?? 0,
      );
      return { name, commit, updatedAt, by, edits };
    }),
  );
}

function branchSlug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Call with withRepositoryWrites held: it picks a free name, then takes it. */
async function createBranch(repo: string, name: string, commit: string) {
  const slug = branchSlug(name);
  if (!slug) fail('Give the design branch a name');
  let branch = `design/${slug}`;
  for (
    let n = 2;
    await gitRead(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    n++
  )
    branch = `design/${slug}-${n}`;
  if (
    (await gitRead(repo, [
      'update-ref',
      `refs/heads/${branch}`,
      commit,
      '0'.repeat(commit.length),
    ])) === null
  )
    fail('Could not create the design branch', 500);
  return { name: branch, commit };
}

/**
 * Commit `paths` as they are in `from` on top of `target`, and move `branch` to it unless someone
 * moved it first. Call with withRepositoryWrites held, from before `target` was read.
 */
async function copyPaths(
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
  const dir = await mkdtemp(join(tmpdir(), 'design-copy-'));
  const env = {
    ...gitEnvironment(),
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: input.by,
    GIT_AUTHOR_EMAIL: `${input.by}@deploy.local`,
    GIT_COMMITTER_NAME: input.by,
    GIT_COMMITTER_EMAIL: `${input.by}@deploy.local`,
  };
  const git = (args: string[], input?: string) =>
    gitString(repo, args, {
      prefix: ['-c', 'core.hooksPath=/dev/null'],
      env,
      timeout: 30000,
      input,
      fallback: `git ${args[0]} failed`,
      trim: 'both',
    });
  try {
    await git(['read-tree', input.target]);
    for (const path of input.paths) {
      const entry = await git(['ls-tree', input.from, '--', path]);
      if (entry) {
        const [mode, , oid] = entry.split('\t')[0].split(' ');
        await git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
        // update-index --force-remove needs a work tree; the project's repository may be bare.
      } else await git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path]);
    }
    for (const write of input.writes ?? []) {
      const oid = await git(['hash-object', '-w', '--stdin'], write.content);
      await git(['update-index', '--add', '--cacheinfo', `100644,${oid},${write.path}`]);
    }
    const commit = await git([
      'commit-tree',
      await git(['write-tree']),
      '-p',
      input.target,
      '-m',
      input.message,
    ]);
    if (
      (await gitRead(repo, ['update-ref', `refs/heads/${input.branch}`, commit, input.target])) ===
      null
    )
      fail(`${input.branch} moved meanwhile; try again`, 409);
    return commit;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The design branch an edit lands on. Editing main (or any non-design ref) starts a design
 * branch, so main only changes through review; `expect` guards against editing a stale branch.
 * Call with withRepositoryWrites held, and keep holding it until the edit is committed.
 */
async function editBranch(repo: string, body: any, name: string) {
  let branch = String(body?.ref || 'HEAD');
  if (!validRef(branch)) fail('Invalid ref');
  if (!branch.startsWith('design/')) {
    const from = await gitRead(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${branch}^{commit}`,
    ]);
    if (!from) fail(`No commit named ${branch} in this project`, 404);
    branch = (await createBranch(repo, `${name} edits`, from!)).name;
  }
  const head = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}^{commit}`,
  ]);
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
async function mainBranch(repo: string) {
  return (await gitRead(repo, ['symbolic-ref', '--short', 'HEAD'])) || 'main';
}

/** What a design branch or a design task would change on main, and where it starts from. */
async function proposalFor(owner: string, project: any, input: { ref?: string; task?: string }) {
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
  const commit = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}^{commit}`,
  ]);
  if (!commit) fail(`Nothing is committed on ${branch} yet`, 409);
  const main = await mainBranch(repo);
  const head = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${main}^{commit}`,
  ]);
  if (!head) fail(`${main} has no commits`, 409);
  const base = (await gitRead(repo, ['merge-base', head!, commit!])) || head!;
  const paths = (
    (await gitRead(repo, [
      'diff',
      '--name-only',
      '--no-renames',
      base,
      commit!,
      '--',
      'design/',
    ])) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  if (!paths.length) fail(`${branch} changes nothing in design/`, 409);
  return { branch, commit: commit!, base, paths, taskId, main, name };
}

// Inbox IDs travel as one URL path segment, so the branch's slashes become tildes.
const branchKey = (branch: string) => branch.replaceAll('/', '~');
function designItemId(projectId: string, branch: string, commit: string) {
  return `design:${projectId}:${branchKey(branch)}:${commit.slice(0, 12)}`;
}

/** Ask for approval in Waiting on you. The same branch at the same commit asks only once. */
/** Links per commit: a commit never changes, so its links are worked out once. */
const linkCache = new Map<string, (BoardLink & { from: string })[]>();

/** The canvas at a commit, for the line a proposal shows; null when it has none. */
async function canvasAt(repo: string, commit: string): Promise<Canvas | null> {
  try {
    return JSON.parse((await gitRead(repo, ['show', `${commit}:design/canvas.json`])) ?? 'null');
  } catch {
    return null;
  }
}

function optionalWords(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim().length > max) fail(`Use at most ${max} characters`);
  return value.trim() || null;
}

function validateChangeWords(value: unknown): Record<string, Record<string, string>> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    fail('changeWords must name boards and layers');
  const result: Record<string, Record<string, string>> = {};
  for (const [board, layers] of Object.entries(value)) {
    if (!boardPattern.test(board) || !layers || typeof layers !== 'object' || Array.isArray(layers))
      fail('changeWords must name boards and layers');
    result[board] = {};
    for (const [layer, words] of Object.entries(layers)) {
      if (!layerPattern.test(layer)) fail('Invalid layer');
      const text = optionalWords(words, 500);
      if (text) result[board][layer] = text;
    }
  }
  return result;
}

function proposalProposer(owner: string, taskId: string | null): DesignReviewSummary['proposer'] {
  const task = taskId ? list('task', owner).find((entry) => entry.id === taskId) : null;
  const run = taskId
    ? list('run', owner)
        .filter((entry) => entry.taskId === taskId)
        .at(-1)
    : null;
  const agentId = task?.agentId ?? run?.agentId;
  const agent = agentId ? list('agent', owner).find((entry) => entry.id === agentId) : null;
  return {
    id: agent?.id ?? null,
    name: agent?.name ?? (task ? task.title : 'You'),
    avatar: agent?.avatar ?? null,
  };
}

function reviewRow(owner: string, projectId: string, itemId: unknown) {
  const row = list('v2-inbox-native', owner).find(
    (entry) =>
      entry.id === itemId &&
      entry.context?.source === 'design' &&
      entry.context.projectId === projectId,
  );
  if (!row) fail('No such design review', 404);
  if (!row.item.actions.some((action: { id: string }) => action.id === 'update')) {
    row.item.actions.push({ id: 'update', label: 'Ask to update' });
    save('v2-inbox-native', owner, row);
  }
  return row;
}

function canvasConflicts(base: Canvas | null, target: Canvas | null, from: Canvas | null) {
  const conflicts: string[] = [];
  // Canvas changes merge field by field. Only conflicting edits to the same note/placement block review.
  for (const field of ['boards', 'notes'] as const) {
    for (const key of new Set([
      ...Object.keys(base?.[field] ?? {}),
      ...Object.keys(from?.[field] ?? {}),
    ])) {
      const a = JSON.stringify(base?.[field]?.[key]),
        b = JSON.stringify(target?.[field]?.[key]),
        c = JSON.stringify(from?.[field]?.[key]);
      if (a !== b && a !== c && b !== c) conflicts.push(field === 'boards' ? key : `note:${key}`);
    }
  }
  return conflicts;
}

const conflictPaths = (paths: string[], changed: string[]) =>
  paths.filter((path) => path !== 'design/canvas.json' && changed.includes(path));
const conflictName = (path: string) =>
  path.replace(/^design\/boards\//, '').replace(/^design\//, '');
const reviewBoardPaths = (context: any) =>
  (context.paths as string[]).filter((path) => path.startsWith('design/boards/'));

/** Compare proposal edits with main by screen, not by main's commit ID. No repository writes.
 * An inbox decision rechecks this with withRepositoryWrites held, immediately before merging. */
export async function reviewMain(repo: string, context: any) {
  const main = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${context.main}^{commit}`,
  ]);
  if (!main) fail('Main could not be checked. Try again.', 409);
  const diff = await gitRead(repo, [
    'diff',
    '--name-only',
    '--no-renames',
    context.base,
    main!,
    '--',
    'design/',
  ]);
  if (diff === null) fail('Main could not be checked. Try again.', 409);
  const changed = diff.split('\n');
  const overlapping = conflictPaths(context.paths, changed);
  const conflicts: string[] = [];
  if (overlapping.length) {
    const [mainTree, fromTree] = await Promise.all([
      reviewTree(repo, main!),
      reviewTree(repo, context.commit),
    ]);
    conflicts.push(
      ...overlapping.filter((path) => mainTree.get(path) !== fromTree.get(path)).map(conflictName),
    );
  }
  if (changed.includes('design/canvas.json') && context.paths.includes('design/canvas.json')) {
    const [base, target, from] = await Promise.all([
      canvasAt(repo, context.base),
      canvasAt(repo, main!),
      canvasAt(repo, context.commit),
    ]);
    conflicts.push(...canvasConflicts(base, target, from));
  }
  return { main: main!, conflicts: [...new Set(conflicts)], updated: changed.some(Boolean) };
}

function reviewLineage(owner: string, context: any): string[] {
  const result: string[] = [];
  let previous = context.previousItemId;
  while (previous && !result.includes(previous)) {
    result.push(previous);
    previous = list('v2-inbox-native', owner).find((row) => row.id === previous)?.context
      .previousItemId;
  }
  return result;
}

function reviewPins(owner: string, context: any): DesignReviewPin[] {
  const lineage = new Set([
    designItemId(context.projectId, context.branch, context.commit),
    ...reviewLineage(owner, context),
  ]);
  return list('design-comment', owner)
    .filter(
      (row) =>
        row.projectId === context.projectId &&
        lineage.has(row.reviewItemId) &&
        row.position &&
        !row.deletedAt,
    )
    .map((row) => ({
      id: row.id,
      number: row.number,
      board: row.board,
      noteId: row.position.noteId ?? null,
      width: row.position.width,
      revision: row.position.revision,
      ...(row.drawing ? { drawing: row.drawing } : {}),
      x: row.position.x,
      y: row.position.y,
      text: row.text,
      author: row.author,
      resolved: Boolean(row.resolved),
      reply: row.reply ?? null,
      createdAt: row.createdAt,
    }))
    .sort((a, b) => a.number - b.number);
}

/**
 * A cheap summary: no Chromium or screenshot work on the landing page. `status` is main as the
 * caller already read it, so one review never compares against two different mains.
 */
async function reviewSummary(
  owner: string,
  project: any,
  row: any,
  status?: Awaited<ReturnType<typeof reviewMain>>,
): Promise<DesignReviewSummary> {
  const { context, item } = row;
  const repo = project.repositoryPath;
  const [{ conflicts }, baseTree, fromTree] = await Promise.all([
    status ?? reviewMain(repo, context),
    reviewTree(repo, context.base),
    reviewTree(repo, context.commit),
  ]);
  const paths = reviewBoardPaths(context);
  const counts = { screens: paths.length, changed: 0, new: 0, removed: 0 };
  for (const path of paths)
    counts[!baseTree.has(path) ? 'new' : !fromTree.has(path) ? 'removed' : 'changed']++;
  return {
    id: item.id,
    title: item.title,
    summary: context.summary ?? null,
    projectId: project.id,
    project: project.name ?? project.id,
    branch: context.branch,
    createdAt: item.createdAt,
    proposer: context.proposer ?? proposalProposer(owner, context.taskId),
    counts,
    stale: conflicts.length > 0,
    conflicts,
  };
}

async function reviewTree(repo: string, commit: string) {
  const tree = new Map<string, string>();
  const text = await reviewGit(repo, ['ls-tree', '-r', '-z', commit, '--', 'design/']);
  for (const entry of (text ?? '').split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, , sha] = entry.slice(0, tab).split(' ');
    tree.set(entry.slice(tab + 1), sha);
  }
  return tree;
}

// Preview requests follow the metadata read. Reuse immutable screen metadata instead of
// repeating every git read for each thumbnail/width. Progress and main checks are never cached.
const reviewScreens = new Map<string, DesignReviewScreen[]>();
const reviewScreenKey = (repo: string, row: any) =>
  `${repo}:${row.id}:${row.context.base}:${row.context.previousCommit ?? ''}`;
// A page opening asks for many previews at once, and they all want the same screens.
const reviewScreensLoading = new Map<string, Promise<DesignReviewScreen[]>>();
function loadReviewScreens(owner: string, project: any, row: any) {
  const key = reviewScreenKey(project.repositoryPath, row);
  const screens = reviewScreens.get(key);
  if (screens) return screens;
  let loading = reviewScreensLoading.get(key);
  if (!loading) {
    loading = designReview(owner, project, row)
      .then((review) => review.boards)
      .finally(() => reviewScreensLoading.delete(key));
    reviewScreensLoading.set(key, loading);
  }
  return loading;
}

export async function designReview(owner: string, project: any, row: any): Promise<DesignReview> {
  const { context, item } = row;
  const repo = project.repositoryPath;
  const status = await reviewMain(repo, context);
  const comparison = context.previousCommit ?? context.base;
  const [canvas, beforeCanvas, originalCanvas] = await Promise.all([
    canvasAt(repo, context.commit),
    canvasAt(repo, comparison),
    canvasAt(repo, context.base),
  ]);
  const pages = canvas ? sections(canvas) : [];
  const oldPages = originalCanvas ? sections(originalCanvas) : [];
  // Insert removed boards at their old position relative to surviving neighbours.
  const order = [...(canvas?.order ?? Object.keys(canvas?.boards ?? {}))];
  const oldOrder = originalCanvas?.order ?? Object.keys(originalCanvas?.boards ?? {});
  for (let index = oldOrder.length - 1; index >= 0; index--) {
    const file = oldOrder[index];
    if (order.includes(file)) continue;
    const next = oldOrder.slice(index + 1).find((entry) => order.includes(entry));
    order.splice(next ? order.indexOf(next) : order.length, 0, file);
  }
  const lineage = reviewLineage(owner, context);
  const previousPaths = lineage.flatMap(
    (id) => reviewRow(owner, project.id, id).context.paths as string[],
  );
  const paths = [...new Set([...(context.paths as string[]), ...previousPaths])].filter((path) =>
    path.startsWith('design/boards/'),
  );
  const seen = list('design-review-seen', owner);
  // Asked at most once: it is the same answer for every board.
  let designSystemDiff: Promise<string | null> | undefined;
  const boards: DesignReviewScreen[] = await Promise.all(
    paths.map(async (path) => {
      const file = path.slice('design/boards/'.length);
      const [was, after, original] = await Promise.all([
        showFile(repo, comparison, path),
        showFile(repo, context.commit, path),
        showFile(repo, context.base, path),
      ]);
      const changedSinceReview =
        !context.previousCommit ||
        was !== after ||
        (await (designSystemDiff ??= gitRead(repo, [
          'diff',
          '--name-only',
          comparison,
          context.commit,
          '--',
          'design/ds/',
        ]))) !== '';
      const before = context.previousCommit && !changedSinceReview ? original : was;
      const boardNotes = await showFile(
        repo,
        after ? context.commit : comparison,
        `design/notes/${file.replace(/\.html$/, '.md')}`,
      );
      let wasSeen = false;
      for (const entry of seen) {
        if (entry.board !== file) continue;
        wasSeen =
          entry.itemId === item.id ||
          (!changedSinceReview &&
            lineage.includes(entry.itemId) &&
            (await showFile(repo, entry.revision, path)) === after);
        if (wasSeen) break;
      }
      const placed =
        canvas?.boards[file] ?? beforeCanvas?.boards[file] ?? originalCanvas?.boards[file];
      const page =
        pages.find((entry) => entry.boards.includes(file)) ??
        oldPages.find((entry) => entry.boards.includes(file));
      const changes =
        before && after
          ? layerChanges(before, after).map((change) => ({
              layer: change.layer,
              words:
                context.changeWords?.[file]?.[change.layer] ??
                layerLabel(
                  change.layer,
                  (
                    layerSnippet(change.change === 'removed' ? before : after, change.layer) ?? ''
                  ).replace(/<[^>]+>/g, ' '),
                ),
            }))
          : [];
      return {
        file,
        title: placed?.title ?? screenName(file),
        w: placed?.w ?? 1440,
        h: Math.max(placed?.h ?? 900, beforeCanvas?.boards[file]?.h ?? 0),
        widths: reviewWidths(placed?.w ?? 1440),
        page: page?.title ?? null,
        pageId: page?.id ?? null,
        index: page ? page.boards.indexOf(file) + 1 : null,
        count: page?.boards.length ?? null,
        notes: boardNotes.slice(0, 2000) || null,
        added: !before,
        removed: !after,
        status: !before ? 'new' : !after ? 'removed' : 'changed',
        before: context.previousCommit && !changedSinceReview ? context.base : comparison,
        after: context.commit,
        changes,
        lines: changes.map((change) => change.words),
        changedSinceReview,
        seen: wasSeen,
        conflict: status.conflicts.includes(file),
      };
    }),
  );
  const pageOrder = [...new Set([...pages.map((p) => p.id), ...oldPages.map((p) => p.id)])];
  boards.sort(
    (a, b) =>
      pageOrder.indexOf(a.pageId ?? '') - pageOrder.indexOf(b.pageId ?? '') ||
      order.indexOf(a.file) - order.indexOf(b.file),
  );
  const groups: DesignReview['groups'] = [];
  for (const board of boards) {
    let group = groups.find((entry) => entry.id === board.pageId);
    if (!group) {
      group = { id: board.pageId, title: board.page, boards: [] };
      groups.push(group);
    }
    group.boards.push(board.file);
  }
  const notes = noteChanges(beforeCanvas, canvas).map((change) => {
    const note = canvas?.notes?.[change.id];
    return { ...change, page: note ? (sectionAt(pages, note)?.title ?? null) : null };
  });
  const screenKey = reviewScreenKey(repo, row);
  reviewScreens.set(screenKey, boards);
  if (reviewScreens.size > 128) reviewScreens.delete(reviewScreens.keys().next().value!);
  const [mainTime, summary] = await Promise.all([
    status.updated ? gitRead(repo, ['show', '-s', '--format=%cI', status.main]) : null,
    reviewSummary(owner, project, row, status),
  ]);
  return {
    ...summary,
    item,
    task: context.taskId
      ? (list('task', owner).find((entry) => entry.id === context.taskId)?.title ?? null)
      : null,
    before: comparison,
    after: context.commit,
    main: status.main,
    updatedWithMainAt: mainTime,
    round: context.round ?? 1,
    previousItemId: context.previousItemId ?? null,
    boards,
    groups,
    notes,
    pins: reviewPins(owner, context),
  };
}

async function mutateReviewPin(owner: string, project: any, method: string, body: any) {
  // A transaction cannot wait for Git, so the review is read first; it names commits and so stays
  // true. Whether the review still waits, and its pins, can change meanwhile, so they are read in it.
  const waiting = reviewRow(owner, project.id, body?.item);
  if (waiting.item.state !== 'waiting') fail('This review is no longer waiting', 409);
  const review = await designReview(owner, project, waiting);
  return db
    .transaction(() => {
      const row = reviewRow(owner, project.id, body?.item);
      if (row.item.state !== 'waiting') fail('This review is no longer waiting', 409);
      if (method !== 'POST') {
        const pin = reviewPins(owner, row.context).find((pin) => pin.id === body?.id);
        if (!pin) fail('No such pin', 404);
        if (body.drawing !== undefined) fail('A saved drawing cannot change its revision or paths');
        const saved = get('design-comment', owner, pin!.id);
        const text = body.text === undefined ? saved.text : optionalWords(body.text, 4000);
        if (!text) fail('A pin needs text');
        if (body.resolved !== undefined && typeof body.resolved !== 'boolean')
          fail('Invalid resolved state');
        save('design-comment', owner, {
          ...saved,
          text,
          resolved: body.resolved ?? saved.resolved,
          resolvedAt: body.resolved === undefined ? saved.resolvedAt : body.resolved ? now() : null,
          ...(method === 'DELETE' ? { deletedAt: now() } : {}),
          updatedAt: now(),
        });
      } else {
        const text = optionalWords(body.text, 4000);
        const board = review.boards.find((entry) => entry.file === body.board);
        const note = body.noteId && review.notes.find((entry) => entry.id === body.noteId);
        const revision = body.revision;
        const allowedRevisions = board
          ? [board.before, board.after]
          : [review.before, review.after];
        if (!text || (!board && !note) || !allowedRevisions.includes(revision))
          fail('Name the screen or note and revision for this pin');
        const width = Number(body.width),
          x = Number(body.x),
          y = Number(body.y);
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(width) ||
          x < 0 ||
          y < 0 ||
          !(board ? board.widths : [1440, 700, 390]).includes(width) ||
          x > width ||
          y > (board?.h ?? 100000)
        )
          fail('Invalid pin coordinates');
        if (body.drawing !== undefined) {
          const drawing = body.drawing;
          if (
            !board ||
            note ||
            !validReviewDrawing(drawing) ||
            drawing.nativeWidth !== width ||
            drawing.nativeHeight !== board.h ||
            revision !== board[drawing.side] ||
            Math.abs(drawing.anchor.x * width - x) > 0.01 ||
            Math.abs(drawing.anchor.y * drawing.nativeHeight - y) > 0.01
          )
            fail('Invalid pin drawing');
        }
        const existing = list('design-comment', owner).filter(
          (entry) =>
            entry.projectId === project.id &&
            [row.id, ...reviewLineage(owner, row.context)].includes(entry.reviewItemId),
        );
        save('design-comment', owner, {
          id: id(),
          projectId: project.id,
          reviewItemId: row.id,
          board: board?.file ?? 'canvas.json',
          layer: null,
          text,
          author: owner,
          commit: revision,
          number: Math.max(0, ...existing.map((entry) => entry.number ?? 0)) + 1,
          position: { width, revision, x, y, noteId: note ? note.id : null },
          ...(body.drawing ? { drawing: body.drawing } : {}),
          resolved: false,
          createdAt: now(),
        });
      }
      return { pins: reviewPins(owner, row.context) };
    })
    .immediate();
}

export async function proposeDesign(
  owner: string,
  project: any,
  input: {
    ref?: string;
    task?: string;
    title?: string;
    summary?: string;
    changeWords?: Record<string, Record<string, string>>;
  },
) {
  const title = optionalWords(input.title, 200);
  const summary = optionalWords(input.summary, 4000);
  const changeWords = validateChangeWords(input.changeWords);
  // With the lock, a proposal never replaces one that is being approved at that moment.
  return withRepositoryWrites(project.repositoryPath, async () => {
    const proposal = await proposalFor(owner, project, input);
    const canvas = proposal.paths.includes('design/canvas.json');
    const [before, after] = canvas
      ? await Promise.all([
          canvasAt(project.repositoryPath, proposal.base),
          canvasAt(project.repositoryPath, proposal.commit),
        ])
      : [null, null];
    return recordProposal(owner, project, proposal, canvas, before, after, {
      title,
      summary,
      changeWords,
    });
  });
}

/** The proposal's rows and events, all in one turn of the event loop. */
function recordProposal(
  owner: string,
  project: any,
  proposal: Awaited<ReturnType<typeof proposalFor>>,
  canvas: boolean,
  before: Canvas | null,
  after: Canvas | null,
  words: {
    title: string | null;
    summary: string | null;
    changeWords: Record<string, Record<string, string>>;
  },
) {
  const { title, summary, changeWords } = words;
  const history = list('v2-inbox-native', owner)
    .filter(
      (row) =>
        row.context?.projectId === project.id &&
        row.context?.branch === proposal.branch &&
        row.item.state === 'answered' &&
        ['changes', 'update'].includes(row.item.answer?.actionId),
    )
    .sort((a, b) => b.item.answer.at.localeCompare(a.item.answer.at));
  const previous = history[0];
  const proposer = proposalProposer(owner, proposal.taskId);

  const boards = proposal.paths
    .filter((path) => path.startsWith('design/boards/'))
    .map((path) => path.slice('design/boards/'.length).replace(/\.html$/, ''));
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
    title: title ?? previous?.item.title ?? screenName(proposal.name.replaceAll('-', ' ')),
    text: changeSummary(proposal.branch, { boards, notes, marks, others }),
    from: proposer.id ?? owner,
    projectId: project.id,
    ...(proposal.taskId ? { taskId: proposal.taskId } : {}),
    createdAt: now(),
    state: 'waiting',
    actions: [
      { id: 'approve', label: 'Approve design', primary: true },
      { id: 'changes', label: 'Ask for changes' },
      { id: 'update', label: 'Ask to update' },
    ],
  };
  // A newer commit replaces the request for the same branch.
  const stale = `design:${project.id}:${branchKey(proposal.branch)}:`;
  for (const row of list('v2-inbox-native', owner))
    if (row.id.startsWith(stale) && row.id !== item.id && row.item.state === 'waiting') {
      const withdrawn = { ...row.item, state: 'withdrawn' as const };
      save('v2-inbox-native', owner, { ...row, item: withdrawn });
      // Clients rebuild Waiting on you from events, so they must hear about it.
      event(owner, project.id, null, 'v2.inbox', { item: withdrawn });
    }
  return createInboxItem(owner, item, {
    source: 'design',
    projectId: project.id,
    ...proposal,
    summary,
    changeWords,
    proposer,
    previousItemId: previous?.id ?? null,
    previousCommit: previous?.context.commit ?? null,
    round: (previous?.context.round ?? 0) + 1,
  });
}

/**
 * The Git half of a decision: whether main still allows it and, for approving, the commit on main.
 * It runs before the answer's transaction, with the lock held through both, so the answer's checks
 * still hold when it records the decision and a second answer finds this one already made.
 */
async function prepareDecision(
  owner: string,
  repo: string,
  item: InboxItem,
  body: any,
  context: any,
) {
  const status = await reviewMain(repo, context);
  if (body.actionId !== 'update' && status.conflicts.length)
    fail('These screens conflict with main. Ask to update before deciding.', 409);
  if (body.actionId === 'update' && !status.conflicts.length)
    fail('This proposal has no conflicts with main. Refresh the review.', 409);
  if (body.actionId !== 'approve') return { conflicts: status.conflicts };
  // Use exactly the commit checked above; update-ref below rejects a concurrent main move.
  const target = status.main;
  const merged = await mergedWrites(repo, {
    base: context.base,
    target,
    from: context.commit,
    paths: context.paths,
    main: context.main,
    branch: context.branch,
  });
  const instances = await instanceWrites(repo, target, context.commit, context.paths);
  const commit = await copyPaths(repo, {
    target,
    from: context.commit,
    paths: context.paths,
    writes: [...merged, ...instances],
    branch: context.main,
    message: `${item.title.replace(/^Approve /, 'Approve ').replace(/\?$/, '')} from ${context.branch}`,
    by: owner,
  });
  return { conflicts: status.conflicts, commit };
}

// Approving keeps the existing merge path. Asking sends all unresolved pins and general
// feedback in the inbox answer transaction, while keeping the board comments in history.
function decideDesign(
  owner: string,
  item: InboxItem,
  body: any,
  context: any,
  prepared?: Awaited<ReturnType<typeof prepareDecision>>,
) {
  if (!prepared) throw new Error('Answer design reviews with answerInboxAsync');
  const project = requireRepository(owner, context.projectId);
  const status = prepared;
  if (body.actionId === 'approve') {
    const commit = prepared.commit!;
    save('project', owner, {
      ...get('project', owner, project.id),
      head: commit,
      updatedAt: now(),
    });
    queuePushTrigger(owner, project.id, `refs/heads/${context.main}`, commit);
    return;
  }
  if (!['changes', 'update'].includes(body.actionId)) return;
  const pins = reviewPins(owner, context).filter((pin) => !pin.resolved);
  const note = String(body.note ?? '').trim();
  const content =
    body.actionId === 'update'
      ? `Please rebase ${context.branch} onto ${context.main}, update the conflicting screens (${status.conflicts.join(', ')}), and propose again with a summary.`
      : [
          note,
          ...pins.map(
            (pin) =>
              `Pin ${pin.number} · ${pin.board}${pin.noteId ? ` · note ${pin.noteId}` : ''} · ${pin.width}px · ${pin.revision} · (${pin.x}, ${pin.y})\n${pin.text}${pin.drawing ? ' (drawn on the screen)' : ''}`,
          ),
        ]
          .filter(Boolean)
          .join('\n\n');
  if (!content) fail('Add a pin or describe what should change');
  if (note)
    save('design-comment', owner, {
      id: id(),
      projectId: project.id,
      board:
        context.paths.find((path: string) => path.startsWith('design/boards/'))?.slice(14) ??
        'canvas.json',
      layer: null,
      text: note,
      commit: context.commit,
      author: owner,
      resolved: false,
      createdAt: now(),
    });
  // The inbox answer transaction makes sending all unresolved pins exactly once per round.
  if (context.taskId) {
    const queued = queuedMessage(owner, context.taskId);
    if (queued?.status === 'queued') {
      save('queued-message', owner, { ...queued, content: `${queued.content}\n\n${content}` });
      event(owner, context.taskId, null, 'message.queued', { status: 'queued' });
    } else queueMessage(owner, context.taskId, { content });
  }
  save('design-review-feedback', owner, {
    id: item.id,
    projectId: project.id,
    taskId: context.taskId,
    content,
    pins: pins.map((pin) => pin.id),
    createdAt: now(),
  });
}

registerInboxSource('design', decideDesign, async ({ owner, body, context, check, answer }) => {
  check();
  const repo = requireRepository(owner, context.projectId).repositoryPath as string;
  return withRepositoryWrites(repo, async () =>
    // Checked again: another answer may have held the lock while this one waited for it.
    answer(await prepareDecision(owner, repo, check(), body, context)),
  );
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
    position: row.position ?? null,
    number: row.number ?? null,
    reply: row.reply ?? null,
  };
}

function comments(owner: string, projectId: string, board?: string | null) {
  return list('design-comment', owner)
    .filter(
      (row: any) =>
        row.projectId === projectId && !row.deletedAt && (!board || row.board === board),
    )
    .map(presentComment);
}

// Renders are keyed by commit, so a cached one never goes stale.
type BoardRender = { png: Buffer; boxes: Record<string, DesignRect>; textBoxes?: DesignRect[] };
const renders = new Map<string, BoardRender>();
const rendering = new Map<string, Promise<BoardRender>>();
const renderLimit = 64;
// Renders also stay on disk, so a restart doesn't make a review draw every screen again.
const renderFiles = 600;
let rendersWritten = 0;
const renderPath = (key: string) =>
  join(deployDataPath('design-renders'), createHash('sha256').update(key).digest('hex'));
async function readRender(key: string): Promise<BoardRender | null> {
  try {
    const path = renderPath(key);
    return {
      png: await readDiskFile(`${path}.png`),
      ...JSON.parse(await readDiskFile(`${path}.json`, 'utf8')),
    };
  } catch {
    return null;
  }
}
function writeRender(key: string, rendered: BoardRender) {
  try {
    const path = renderPath(key);
    mkdirSync(deployDataPath('design-renders'), { recursive: true });
    writeFileSync(`${path}.png`, rendered.png);
    writeFileSync(
      `${path}.json`,
      JSON.stringify({ boxes: rendered.boxes, textBoxes: rendered.textBoxes }),
    );
    if (++rendersWritten % 50 === 0) pruneRenders();
  } catch {
    // A full or read-only disk only costs a redraw later.
  }
}
function pruneRenders() {
  const directory = deployDataPath('design-renders');
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.png'))
    .map((name) => ({ name, at: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { name } of files.slice(renderFiles)) {
    rmSync(join(directory, name), { force: true });
    rmSync(join(directory, name.replace(/\.png$/, '.json')), { force: true });
  }
}

// One Chromium draws every board, a few at a time, and closes after a minute without work.
const drawLimit = 3;
let drawing = 0;
const drawQueue: (() => void)[] = [];
let chromiumLaunch: Promise<import('playwright').Browser> | null = null;
let chromiumIdle: ReturnType<typeof setTimeout> | undefined;
async function withBoardChromium<T>(
  executablePath: string,
  work: (browser: import('playwright').Browser) => Promise<T>,
): Promise<T> {
  if (drawing >= drawLimit) await new Promise<void>((resolve) => drawQueue.push(resolve));
  drawing++;
  clearTimeout(chromiumIdle);
  try {
    let browser = chromiumLaunch && (await chromiumLaunch.catch(() => null));
    if (!browser?.isConnected()) {
      const { chromium } = await import('playwright');
      chromiumLaunch = chromium.launch({ executablePath });
      browser = await chromiumLaunch.catch((error) => {
        chromiumLaunch = null;
        throw error;
      });
    }
    return await work(browser);
  } finally {
    drawing--;
    drawQueue.shift()?.();
    if (!drawing) {
      chromiumIdle = setTimeout(() => {
        const launched = chromiumLaunch;
        chromiumLaunch = null;
        void launched?.then((browser) => browser.close()).catch(() => {});
      }, 60_000);
      chromiumIdle.unref?.();
    }
  }
}

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

/** Pixel density affects only the PNG; layout and review geometry stay in CSS pixels. */
export function previewScale(url: URL): number {
  const scale = Number(url.searchParams.get('scale') ?? 1);
  if (!Number.isFinite(scale) || scale < 1 || scale > 3) fail('Scale must be 1 to 3');
  return scale;
}

export async function renderBoard(
  repo: string,
  commit: string,
  board: string,
  width: number,
  height?: number,
  scale = 1,
) {
  return (await renderBoardLayout(repo, commit, board, width, height, scale)).png;
}

export async function renderBoardLayout(
  repo: string,
  commit: string,
  board: string,
  width: number,
  height?: number,
  scale = 1,
  draw: typeof drawBoard = drawBoard,
): Promise<BoardRender> {
  const key = `${repo}:${commit}:${board}:${width}:${height ?? 'board'}:${scale}`;
  const cached = renders.get(key);
  if (cached) return cached;
  const pending = rendering.get(key);
  if (pending) return pending;
  const stored = draw === drawBoard ? await readRender(key) : null;
  const job = stored
    ? Promise.resolve(stored)
    : draw(repo, commit, board, width, height, scale).then((rendered) => {
        if (draw === drawBoard) writeRender(key, rendered);
        return rendered;
      });
  rendering.set(key, job);
  try {
    const rendered = await job;
    renders.set(key, rendered);
    if (renders.size > renderLimit) renders.delete(renders.keys().next().value!);
    return rendered;
  } finally {
    rendering.delete(key);
  }
}

async function drawBoard(
  repo: string,
  commit: string,
  board: string,
  width: number,
  height?: number,
  scale = 1,
): Promise<BoardRender> {
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
  return withBoardChromium(executablePath, async (browser) => {
    const context = await browser.newContext({
      viewport: { width, height: height ?? placed.h },
      deviceScaleFactor: scale,
      javaScriptEnabled: false,
    });
    try {
      await context.route('**/*', (route) =>
        /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(route.request().url())
          ? route.continue()
          : route.abort(),
      );
      const tab = await context.newPage();
      await tab.setContent(page, { waitUntil: 'load', timeout: 15000 });
      await tab.evaluate(() => document.fonts.ready);
      const { boxes, textBoxes } = await tab.evaluate(() => {
        const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
        const textBoxes = [];
        for (const element of document.querySelectorAll<HTMLElement>('[data-layer]')) {
          const rect = element.getBoundingClientRect();
          if (
            !rect.width ||
            !rect.height ||
            rect.right <= 0 ||
            rect.bottom <= 0 ||
            rect.x >= innerWidth ||
            rect.y >= innerHeight ||
            getComputedStyle(element).visibility === 'hidden'
          )
            continue;
          const box = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
          boxes[element.dataset.layer!] = box;
          if (
            ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) ||
            Array.from(element.childNodes).some(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            )
          )
            textBoxes.push(box);
        }
        return { boxes, textBoxes };
      });
      const png = await tab.screenshot();
      return { png, boxes, textBoxes };
    } finally {
      await context.close();
    }
  });
}

/** Progressive review payload; the screenshot and rectangles come from the same render. */
export async function reviewPreview(
  repo: string,
  projectId: string,
  board: DesignReviewScreen,
  width: number,
  render: typeof renderBoardLayout = renderBoardLayout,
  scale = 1,
): Promise<DesignReviewPreview> {
  const before = board.added
    ? null
    : await render(repo, board.before, board.file, width, board.h, scale);
  const after = board.removed
    ? null
    : await render(repo, board.after, board.file, width, board.h, scale);
  const areas = reviewAreas(board.changes, before?.boxes ?? {}, after?.boxes ?? {}, width, board.h);
  const url = (revision: string) =>
    `/api/v2/projects/${encodeURIComponent(projectId)}/design/render?ref=${revision}&board=${encodeURIComponent(board.file)}&width=${width}&height=${board.h}&scale=${scale}`;
  return {
    width,
    height: board.h,
    before: before ? url(board.before) : null,
    after: after ? url(board.after) : null,
    areas,
    crop: reviewCrop(
      width,
      board.h,
      areas.flatMap((area) => (area.after || area.before ? [area.after ?? area.before!] : [])),
      after?.textBoxes,
    ),
  };
}

/**
 * Draw a new proposal's screens in the background, one at a time, at the densities the web
 * (2×) and iPhone (3×) ask for, so the first look at it is as fast as the second.
 */
async function warmReview(owner: string, project: any, repo: string, itemId: string) {
  try {
    const row = reviewRow(owner, project.id, itemId);
    for (const board of (await designReview(owner, project, row)).boards)
      for (const scale of [2, 3])
        await reviewPreview(repo, project.id, board, board.widths[0], renderBoardLayout, scale);
  } catch {
    // Warming is only a head start; the review draws whatever is missing when it opens.
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
export async function designTool(scope: { owner: string; taskId: string }, args: any) {
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
          save('design-comment', scope.owner, {
            ...row,
            resolved: args.resolved !== false,
            resolvedAt: args.resolved === false ? null : now(),
            reply: optionalWords(args.reply, 1000) ?? row.reply ?? null,
          }),
        ),
      };
    }
    case 'propose': {
      const item = await proposeDesign(scope.owner, project, {
        task: task.id,
        title: args.title,
        summary: args.summary,
        changeWords: args.changeWords,
      });
      setImmediate(() => void warmReview(scope.owner, project, project.repositoryPath, item.id));
      return { item };
    }
    default:
      fail('action must be presence, comments, comment, resolve or propose');
  }
}

export async function designApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname === '/api/v2/design/reviews' && req.method === 'GET') {
    const projectId = url.searchParams.get('project');
    const rows = list('v2-inbox-native', owner).filter(
      (row) =>
        row.context?.source === 'design' &&
        row.item.state === 'waiting' &&
        (!projectId || row.context.projectId === projectId),
    );
    const proposals: DesignReviewSummary[] = [];
    for (const row of rows)
      proposals.push(
        await reviewSummary(owner, requireRepository(owner, row.context.projectId), row),
      );
    proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sendJson(res, { proposals });
  }
  // Every project and how many boards its design has on main, for the project picker.
  if (url.pathname === '/api/v2/design/projects' && req.method === 'GET') {
    const projects = list('project', owner).filter((row: any) => row.repositoryPath);
    const designs = await Promise.all(
      projects.map((row: any) =>
        // Each project is its own repository, so the Git limit per repository does not bound this.
        pickerSlots('picker', async () => {
          let boards = 0;
          try {
            boards = Object.keys(
              (
                await readCanvas(
                  row.repositoryPath,
                  `refs/heads/${await mainBranch(row.repositoryPath)}`,
                )
              )?.boards ?? {},
            ).length;
          } catch {
            // A canvas that is not valid JSON counts as no design.
          }
          return {
            id: row.id,
            name: row.name ?? row.id,
            description: row.description ?? null,
            boards,
          };
        }),
      ),
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
    const { ref, commit } = await resolveCommit(owner, project.id, repo, url);
    const canvas = await readCanvas(repo, commit);
    const open = comments(owner, project.id).filter((comment) => !comment.resolved);
    return sendJson(res, {
      ref,
      commit,
      canvas,
      branches: await designBranches(repo),
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
    const branch = await withRepositoryWrites(repo, async () => {
      const commit = await gitRead(repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${from}^{commit}`,
      ]);
      if (!commit) fail(`No commit named ${from} in this project`, 404);
      return createBranch(repo, String(body?.name ?? ''), commit!);
    });
    return sendJson(res, { branch }, 201);
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
    const { commit } = await resolveCommit(owner, project.id, repo, url);
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
    const { commit } = await resolveCommit(owner, project.id, repo, url);
    const base = url.searchParams.get('base') || 'HEAD';
    if (!validRef(base)) fail('Invalid base');
    const baseCommit = await gitRead(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${base}^{commit}`,
    ]);
    if (!baseCommit) fail(`No commit named ${base} in this project`, 404);
    const mergeBase = (await gitRead(repo, ['merge-base', baseCommit, commit])) || baseCommit;
    const out = await gitRead(repo, [
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
    const { commit } = await resolveCommit(owner, project.id, repo, url);
    const board = String(url.searchParams.get('board') ?? '');
    if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
    const width = Number(url.searchParams.get('width') ?? 1440);
    if (!Number.isInteger(width) || width < 320 || width > 2560) fail('Width must be 320 to 2560');
    const height = url.searchParams.has('height')
      ? Number(url.searchParams.get('height'))
      : undefined;
    if (height !== undefined && (!Number.isInteger(height) || height < 64 || height > 20000))
      fail('Height must be 64 to 20000');
    const png = await renderBoard(repo, commit, board, width, height, previewScale(url));
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
      const { ref, commit } = await resolveCommit(owner, project.id, repo, url);
      const library = parseLibrary((await readFile(repo, commit, libraryPath))?.toString());
      const component = library?.components.find((item) => item.id === componentId);
      if (!component) fail(`The design system has no component ${componentId}`, 404);
      const used = (await componentUsage(repo, commit))[componentId] ?? [];
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
    const { ref, commit } = await resolveCommit(owner, project.id, repo, url);
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
    const commit = await gitRead(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    if (!commit) fail(`No commit named ${ref} in this project`, 404);
    const library = parseLibrary((await readFile(repo, commit!, libraryPath))?.toString());
    return sendJson(res, {
      commit,
      library,
      usage: library ? await componentUsage(repo, commit!) : {},
    });
  }

  // Direct edits from the properties panel and the canvas, committed to a design branch.
  if (sub === '/edit' && req.method === 'POST') {
    const body = await readJson(req);
    const board = String(body?.board ?? '');
    if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
    const edits = body?.edits;
    if (!Array.isArray(edits) || !edits.length || edits.length > 50) fail('Send 1 to 50 edits');
    const result = await withRepositoryWrites(repo, async () => {
      const { branch, head } = await editBranch(repo, body, board.replace(/\.html$/, ''));
      const html = await readFile(repo, head, `design/boards/${board}`);
      if (!html) fail(`design/boards/${board} is missing on ${branch}`, 404);
      const main = await gitRead(repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${await mainBranch(repo)}^{commit}`,
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
      if (next === html.toString()) return { branch, commit: head, layers: [] as string[] };
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
      const commit = await copyPaths(repo, {
        target: head,
        from: head,
        paths: [],
        branch,
        message: `Edit ${board.replace(/\.html$/, '')}: ${kinds.slice(0, 4).join(', ')}`,
        by: owner,
        writes: [{ path: `design/boards/${board}`, content: next }],
      });
      return { branch, commit, layers };
    });
    return sendJson(res, result);
  }

  // The canvas itself: new boards from the frame tool, and sticky notes.
  if (sub === '/canvas' && req.method === 'POST') {
    const body = await readJson(req);
    const result = await withRepositoryWrites(repo, async () => {
      const op = body?.op;
      const { branch, head } = await editBranch(repo, body, op === 'board' ? 'new board' : 'notes');
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
      const commit = await copyPaths(repo, {
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
      return { branch, commit, made: made! };
    });
    return sendJson(res, result);
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
    const result = await withRepositoryWrites(repo, async () => {
      const agent = await gitRead(repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${agentRef}^{commit}`,
      ]);
      if (!agent) fail('The agent has not committed any design changes yet', 409);
      let into = String(body?.into || 'HEAD');
      if (!validRef(into)) fail('Invalid branch');
      if (!into.startsWith('design/')) {
        const from = await gitRead(repo, [
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${into}^{commit}`,
        ]);
        if (!from) fail(`No commit named ${into} in this project`, 404);
        into = (await createBranch(repo, task.title.replace(/^Design:\s*/, ''), from!)).name;
      }
      const target = await gitRead(repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${into}^{commit}`,
      ]);
      if (!target) fail(`No design branch named ${into}`, 404);
      const base = task.design.commit as string;
      const changed = (
        (await gitRead(repo, [
          'diff',
          '--name-only',
          '--no-renames',
          base,
          agent!,
          '--',
          'design/',
        ])) ?? ''
      )
        .split('\n')
        .filter(Boolean);
      const paths: string[] = Array.isArray(body?.paths) ? body.paths.map(String) : changed;
      if (!paths.length) fail('Choose at least one change to accept');
      if (paths.some((path) => !changed.includes(path)))
        fail('Only the agent’s design changes can be accepted');
      const commit = await copyPaths(repo, {
        target: target!,
        from: agent!,
        paths,
        branch: into,
        message: `Accept ${paths.length === 1 ? paths[0].replace(/^design\//, '') : `${paths.length} design changes`} from ${task.title}`,
        by: owner,
      });
      return { branch: into, commit, accepted: paths };
    });
    return sendJson(res, result);
  }

  // Ask for approval of a design branch or a design task, in Waiting on you.
  if (sub === '/propose' && req.method === 'POST') {
    const body = await readJson(req);
    const item = await proposeDesign(owner, project, {
      ref: body?.ref,
      task: body?.task,
      title: body?.title,
      summary: body?.summary,
      changeWords: body?.changeWords,
    });
    setImmediate(() => void warmReview(owner, project, repo, item.id));
    return sendJson(res, { item }, 201);
  }

  // Agents working on this design right now.
  if (sub === '/presence' && req.method === 'GET')
    return sendJson(res, { agents: livePresence(owner, project.id) });

  if (sub === '/review' && req.method === 'GET') {
    const row = reviewRow(owner, project.id, url.searchParams.get('item'));
    const review = await designReview(owner, project, row);
    if (url.searchParams.get('previews') === 'all') {
      for (const board of review.boards) {
        board.previews = {};
        for (const width of board.widths)
          board.previews[width] = await reviewPreview(repo, project.id, board, width);
      }
    }
    return sendJson(res, review);
  }

  if (sub === '/review/preview' && req.method === 'GET') {
    const row = reviewRow(owner, project.id, url.searchParams.get('item'));
    const boards = await loadReviewScreens(owner, project, row);
    const board = boards.find((entry) => entry.file === url.searchParams.get('board'));
    const width = Number(url.searchParams.get('width'));
    if (!board || !board.widths.includes(width)) fail('Name a screen and one of its widths');
    return sendJson(
      res,
      await reviewPreview(repo, project.id, board!, width, undefined, previewScale(url)),
    );
  }

  if (sub === '/review/seen' && req.method === 'POST') {
    const body = await readJson(req);
    const row = reviewRow(owner, project.id, body?.item);
    const review = await designReview(owner, project, row);
    const board = review.boards.find((entry) => entry.file === body?.board);
    if (!board || body?.revision !== review.after)
      fail('Name a screen at this proposal revision', 409);
    save('design-review-seen', owner, {
      id: `${row.id}:${board!.file}`,
      itemId: row.id,
      board: board!.file,
      revision: review.after,
      seenAt: now(),
    });
    return sendJson(res, { seen: true });
  }

  if (sub === '/review/pins' && ['POST', 'PATCH', 'DELETE'].includes(req.method!)) {
    const body = await readJson(req, req.method === 'POST' ? 1024 * 1024 : 128 * 1024);
    return sendJson(res, await mutateReviewPin(owner, project, req.method!, body));
  }

  if (sub === '/proposals' && req.method === 'GET') {
    const prefix = `design:${project.id}:`;
    // Each request also names the boards it would change, so the canvas can mark them In review.
    // The canvas polls this every 10 s and it lists every proposal ever made, so it reads no git:
    // counts and conflicts, which do, come from /api/v2/design/reviews for what still waits.
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
