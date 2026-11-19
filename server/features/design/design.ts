import { dispatch, routes } from '../../kernel/routes.ts';
import {
  commitBytes,
  commitText,
  repositoryRefs,
  repositoryView,
  presentationCommit,
  optionalCommitText,
} from '../../workspace/repository-views.ts';
import { mergeBoard, type BoardChoice } from '../../design/board-merge.ts';
import { hasTools } from '../../workspace/tool-probes.ts';
import { approvedTaskDesign, reportDesignBuild } from './design-check.ts';
import { checkDesign, measureOverflow, type CheckDrawing } from './board-check.ts';
import { applyCanvasEdit, blankBoard } from '../../design/canvas-edit.ts';
import { reviewEvidence } from '../../design/review-evidence.ts';
import {
  groupReviewChanges,
  validReviewAnchor,
  type ReviewEvidence,
} from '../../../shared/v2/design-review.ts';
import { gitString, tryGitText } from '../../kernel/git.ts';
import { mkdtemp, readFile as readDiskFile, rm, utimes, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deployDataPath } from '../../kernel/files/data-directory.ts';
import { homeOf, readReleaseConfig } from '../../v2/self-update-host.ts';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import {
  applyEdits,
  boardLinks,
  type BoardLink,
  layerChanges,
  layerIds,
  layerSnippet,
  syncInstances,
  type Library,
} from '../../design/board-html.ts';
import { currentTaskBranch } from '../../workspace/follow-up.ts';
import { findRepository, requireRepository } from '../../workspace/repositories.ts';
import { keyedSlots, withRepositoryWrites } from '../../kernel/jobs/repository-lock.ts';
import {
  gitEnvironment,
  gitRead as readGitOutput,
  repositoryGit,
} from '../../workspace/repository-git.ts';
import { db, event, get, id, list, now, remove, save } from '../../workspace/store.ts';
import { queueTask } from '../../workspace/task-workspace.ts';
import { computers } from '../../workspace/coordination.ts';
import { assertWorkerRole } from '../../workspace/computer-role-policy.ts';
import { onlineTaskWorker } from '../../v2/task-computer.ts';
import { readJson, sendJson } from '../../v2/attachments.ts';
import { createInboxItem, documentReview, registerInboxSource, syncInbox } from '../../v2/inbox.ts';
import { fail } from '../../kernel/errors.ts';
import { queuePushTrigger } from '../../workspace/pipeline-triggers.ts';
import { queueMessage, queuedMessage } from '../../workspace/queued-message.ts';
import {
  validReviewDrawing,
  reviewAreas,
  reviewCrop,
  reviewWidths,
  screenName,
} from '../../../shared/v2/design-review.ts';
import type {
  DesignRect,
  DesignReview,
  DesignReviewPart,
  DesignReviewPin,
  DesignReviewPreview,
  DesignReviewScreen,
  DesignReviewResolution,
  DesignReviewSummary,
  InboxItem,
} from '../../../shared/v2/contracts.ts';
import {
  changeSummary,
  layerLabel,
  markChanges,
  mergeCanvas,
  noteChanges,
  sectionAt,
  sections,
  type Canvas,
} from '../../../shared/v2/design.ts';
import { approveLabel, reviewedDocument } from '../../../shared/v2/artifacts.ts';

/**
 * Where the design being read lives in its repository: design/, the project's App design, or
 * artifacts/<name>, a design made under Artifacts. Requests name it in their path, and a proposal
 * keeps it in its context, so everything below reads and writes the one folder. Every design
 * shares the project's design system in design/ds.
 */
const folderStore = new AsyncLocalStorage<string>();
export const appDesignFolder = 'design';
export const artifactNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function designFolder() {
  return folderStore.getStore() ?? appDesignFolder;
}
export function inDesignFolder<T>(folder: string | null | undefined, work: () => T): T {
  return folderStore.run(folder || appDesignFolder, work);
}
/** The artifact's name, or null for the App design. */
export function folderArtifact(folder = designFolder()) {
  return folder.startsWith('artifacts/') ? folder.slice('artifacts/'.length) : null;
}
/** Branches that hold this design's edits: design/… for the App design, artifact/<name>… for one. */
export function ownsBranch(branch: string, folder = designFolder()) {
  const artifact = folderArtifact(folder);
  return artifact
    ? branch === `artifact/${artifact}` || branch.startsWith(`artifact/${artifact}--`)
    : branch.startsWith('design/');
}
/** The artifacts a diff's paths change, each with its kind and the files changed in it. */
export function changedArtifacts(names: string) {
  const found = new Map<string, string[]>();
  for (const path of names.split('\n').filter(Boolean)) {
    const match = /^artifacts\/([^/]+)\/(.+)$/.exec(path);
    if (!match || !artifactNamePattern.test(match[1])) continue;
    found.set(match[1], [...(found.get(match[1]) ?? []), path]);
  }
  return [...found].map(([artifact, files]) => ({
    artifact,
    kind: files.includes(`artifacts/${artifact}/document.md`)
      ? ('document' as const)
      : ('design' as const),
    files,
  }));
}
/** The API path for this design: /api/projects/<id>/design, or …/artifacts/<name>/design. */
export function designApiPath(projectId: string, folder = designFolder()) {
  const artifact = folderArtifact(folder);
  return `/api/projects/${encodeURIComponent(projectId)}${artifact ? `/artifacts/${artifact}` : ''}/design`;
}

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
// A cadence view must not extend another view's cached failure by a second cadence.
const reviewCommitRead = (repo: string, args: string[]) =>
  commitText(repo, args, { limit: 4 * 1024 * 1024 }).catch(() => null);
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
async function resolveCommit(
  owner: string,
  projectId: string,
  repo: string,
  url: URL,
  presentation = false,
) {
  const taskId = url.searchParams.get('task');
  let ref = url.searchParams.get('ref') || 'HEAD';
  if (taskId) {
    const task = get('task', owner, taskId);
    if (task.projectId !== projectId) fail('That task belongs to another project', 404);
    const branch = `refs/heads/${currentTaskBranch(task)}`;
    ref = (
      presentation
        ? await presentationCommit(repo, branch).catch(() => null)
        : await gitRead(repo, ['rev-parse', '--verify', '--quiet', branch])
    )
      ? branch
      : task.baseRevision;
  }
  if (!validRef(ref)) fail('Invalid ref');
  // A full commit id names itself: review images ask for one per screen, and a cached render
  // then needs no Git at all. Reading at a commit the repository lacks still fails below.
  if (commitPattern.test(ref)) return { ref, commit: ref };
  const commit = presentation
    ? await presentationCommit(repo, ref).catch(() => null)
    : await gitRead(repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ]);
  if (!commit) fail(`No commit named ${ref} in this project`, 404);
  return { ref, commit };
}

/**
 * A file of the design system, ds/..., at a commit. A project with no design/ds of its own gets
 * deploy.local's, from this release, so a new project's boards can use the tokens and dl-* classes.
 */
async function designSystemFile(repo: string, commit: string, path: string, presentation = false) {
  const own = await readFile(
    repo,
    commit,
    `${appDesignFolder}/${path}`,
    2 * 1024 * 1024,
    presentation,
  );
  if (own) return own;
  if (!/^ds\/[\w.-]+(?:\/[\w.-]+)*$/.test(path) || path.split('/').includes('..')) return null;
  try {
    return await readDiskFile(resolve(process.cwd(), appDesignFolder, path));
  } catch {
    return null;
  }
}

async function readFile(
  repo: string,
  commit: string,
  path: string,
  limit = 2 * 1024 * 1024,
  presentation = false,
) {
  try {
    if (presentation) return await commitBytes(repo, ['show', `${commit}:${path}`], { limit });
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

/** Which boards hold instances of each component, at a commit. A commit never changes, so its
 * answer is kept: every review read asks it of the proposal and of main. */
const usageCache = new Map<string, Promise<Record<string, string[]>>>();
function componentUsage(repo: string, commit: string) {
  if (!commitPattern.test(commit)) return readComponentUsage(repo, commit);
  const key = `${repo}:${commit}`;
  let usage = usageCache.get(key);
  if (!usage) {
    usage = readComponentUsage(repo, commit);
    usageCache.set(key, usage);
    if (usageCache.size > 64) usageCache.delete(usageCache.keys().next().value!);
    usage.catch(() => usageCache.delete(key));
  }
  return usage;
}
async function readComponentUsage(repo: string, commit: string) {
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

/** The component library at a commit, read once per commit. */
const libraries = new Map<string, Promise<Library | null>>();
function libraryAt(repo: string, commit: string) {
  // A branch name moves; only a commit's answer is kept.
  if (!commitPattern.test(commit)) return showFile(repo, commit, libraryPath).then(parseLibrary);
  const key = `${repo}:${commit}`;
  let library = libraries.get(key);
  if (!library) {
    library = showFile(repo, commit, libraryPath).then(parseLibrary);
    libraries.set(key, library);
    if (libraries.size > 64) libraries.delete(libraries.keys().next().value!);
    library.catch(() => libraries.delete(key));
  }
  return library;
}

/**
 * A board as it shows at a commit: its instances drawn by that commit's library. A branch that
 * changes a component and leaves its instances to the landing still shows the change on every
 * screen. On main, where landing keeps them in step, it is the board itself.
 */
async function boardAsShown(repo: string, commit: string, html: string) {
  if (!html.includes(' data-component="')) return html;
  const library = await libraryAt(repo, commit);
  return library ? syncInstances(html, library) : html;
}

type SharedParts = {
  /** Board paths the branch carries whose whole change is its instances drawn again. */
  instanceOnly: string[];
  /** The components the branch changed in the library, in library order. */
  changed: { id: string; name: string; hash: string }[];
};
const noParts: SharedParts = { instanceOnly: [], changed: [] };
/** Boards classified at once on a first read: enough to keep Git busy. */
const sharedPartsWidth = 8;
const sharedPartsCache = new Map<string, Promise<SharedParts>>();
/**
 * Which components a proposal changed, and which of the boards it carries changed only because
 * their instances were drawn again from its library. Those boards are not changes of their own:
 * landing draws every instance again from main's boards anyway. Worked out against the commit the
 * branch started from, so the answer depends only on two commits and is kept.
 */
function sharedParts(
  repo: string,
  base: string,
  commit: string,
  paths: string[],
): Promise<SharedParts> {
  if (!paths.includes(libraryPath)) return Promise.resolve(noParts);
  const key = JSON.stringify([repo, base, commit, designFolder()]);
  const cached = sharedPartsCache.get(key);
  if (cached) {
    sharedPartsCache.delete(key);
    sharedPartsCache.set(key, cached);
    return cached;
  }
  const work = readSharedParts(repo, base, commit, paths);
  sharedPartsCache.set(key, work);
  if (sharedPartsCache.size > 32) sharedPartsCache.delete(sharedPartsCache.keys().next().value!);
  work.catch(() => sharedPartsCache.delete(key));
  return work;
}
async function readSharedParts(
  repo: string,
  base: string,
  commit: string,
  paths: string[],
): Promise<SharedParts> {
  const [was, library] = await Promise.all([
    keptFile(repo, base, libraryPath).then(parseLibrary),
    keptFile(repo, commit, libraryPath).then(parseLibrary),
  ]);
  if (!library) return noParts;
  const changed = library.components
    .filter(
      (component) =>
        JSON.stringify(component) !==
        JSON.stringify(was?.components.find((item) => item.id === component.id)),
    )
    .map((component) => ({
      id: component.id,
      name: component.name || component.id,
      hash: sha1(JSON.stringify(component)),
    }));
  if (!changed.length) return noParts;
  const boards = paths.filter(
    (path) => path.startsWith(`${designFolder()}/boards/`) && path.endsWith('.html'),
  );
  const instanceOnly: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < boards.length) {
      const path = boards[next++];
      const [before, after] = await Promise.all([
        keptFile(repo, base, path),
        keptFile(repo, commit, path),
      ]);
      if (!before || !after || !before.includes(' data-component="')) continue;
      if (syncInstances(before, library).trimEnd() === after.trimEnd()) instanceOnly.push(path);
    }
  };
  await Promise.all(Array.from({ length: Math.min(sharedPartsWidth, boards.length) }, worker));
  return { instanceOnly: instanceOnly.sort(), changed };
}

/** The proposal's paths without the boards it carries only for their instances. */
const ownPaths = (paths: string[], instanceOnly: string[]) =>
  instanceOnly.length ? paths.filter((path) => !instanceOnly.includes(path)) : paths;

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
    resolutions: DesignReviewResolution[];
  },
) {
  const blob = (commit: string, path: string) =>
    gitRead(repo, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
  const writes: { path: string; content: string | null }[] = [];
  const dir = designFolder();
  for (const path of input.paths) {
    const [base, target, from] = await Promise.all(
      [input.base, input.target, input.from].map((commit) => blob(commit, path)),
    );
    if (target === base || from === base || target === from) continue;
    const [baseText, targetText, fromText] = await Promise.all(
      [input.base, input.target, input.from].map((commit) => showFile(repo, commit, path)),
    );
    const resolution = input.resolutions.find((entry) => entry.file === conflictName(path));
    if (path.startsWith(`${dir}/boards/`)) {
      const merged = mergeBoard(baseText, targetText, fromText, resolution?.choice ?? undefined);
      if (merged.kind === 'same-part' && !resolution?.choice)
        fail('Resolve these screens in the review before deciding.', 409);
      writes.push({ path, content: merged.content || null });
      continue;
    }
    if (path === `${dir}/canvas.json`) {
      const [was, main, branch] = [baseText, targetText, fromText].map((text) => {
        try {
          return JSON.parse(text || 'null') as Canvas | null;
        } catch {
          return null;
        }
      });
      if (was && main && branch) {
        const merged = mergeCanvas(was, main, branch);
        for (const resolution of input.resolutions) {
          if (
            resolution.choice !== 'main' ||
            !canvasConflicts(was, main, branch).includes(resolution.file)
          )
            continue;
          const field = resolution.file.startsWith('note:') ? 'notes' : 'boards';
          const key = field === 'notes' ? resolution.file.slice(5) : resolution.file;
          const into = merged[field] as Record<string, unknown>;
          const value = main[field]?.[key];
          if (value === undefined) delete into[key];
          else into[key] = value;
        }
        writes.push({ path, content: `${JSON.stringify(merged, null, 2)}\n` });
        continue;
      }
    }
    if (resolution?.choice) {
      writes.push({
        path,
        content: (resolution.choice === 'main' ? targetText : fromText) || null,
      });
      continue;
    }
    const merged = await mergeLines(repo, path, baseText, targetText, fromText);
    if (merged === null)
      fail(
        `${input.main} changed ${path.slice(dir.length + 1)} since ${input.branch} started, on the same lines. Resolve it in the review, then approve again.`,
        409,
      );
    writes.push({ path, content: merged });
  }
  return writes;
}
/**
 * A file that is not a board, merged line by line. A stylesheet where both sides added rules at
 * the same place keeps both sets, main's first: rules are independent, so neither is lost.
 * Null when the same lines changed and nothing can be kept from both.
 */
async function mergeLines(repo: string, path: string, base: string, target: string, from: string) {
  const dir = await mkdtemp(join(tmpdir(), 'design-merge-'));
  try {
    const [ours, old, theirs] = ['main', 'base', 'branch'].map((name) => join(dir, name));
    await Promise.all([writeFile(ours, target), writeFile(old, base), writeFile(theirs, from)]);
    // merge-file exits with the number of conflicts, so a rejection means the lines overlap.
    const run = (flags: string[]) =>
      gitSlots(repo, () => repositoryGit(dir, ['merge-file', '-p', ...flags, ours, old, theirs]))
        .then((bytes) => bytes.toString())
        .catch(() => null);
    return (await run([])) ?? (path.endsWith('.css') ? await run(['--union']) : null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
/** A file's whole text at a commit, last newline kept. */
async function showFile(repo: string, commit: string, path: string, presentation = false) {
  if (presentation)
    return commitText(
      repo,
      ['show', `${commit}:${path}`],
      { limit: 16 * 1024 * 1024 },
      false,
    ).catch(() => '');
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

async function readCanvas(
  repo: string,
  commit: string,
  presentation = false,
): Promise<Canvas | null> {
  const path = `${designFolder()}/canvas.json`;
  const bytes = presentation
    ? await optionalCommitText(repo, ['show', `${commit}:${path}`], {
        limit: 2 * 1024 * 1024,
      })
    : await readFile(repo, commit, path);
  if (!bytes) return null;
  try {
    const canvas = JSON.parse(bytes.toString()) as Canvas;
    return canvas && typeof canvas.boards === 'object' ? canvas : null;
  } catch {
    fail(`${path} is not valid JSON`, 422);
  }
}

async function designBranches(repo: string) {
  const folder = designFolder();
  const out = await gitRead(repo, [
    'for-each-ref',
    '--sort=-committerdate',
    '--count=40',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(committername)',
    folderArtifact(folder) ? 'refs/heads/artifact/' : 'refs/heads/design/',
  ]);
  const main = (await gitRead(repo, ['symbolic-ref', '--short', 'HEAD'])) || 'main';
  const made = await madeOnBranch(repo, main, folder);
  return Promise.all(
    (out ? out.split('\n') : [])
      .filter((line) => ownsBranch(line.split('\t')[0], folder))
      .map(async (line) => {
        const [name, commit, updatedAt, by] = line.split('\t');
        // Edits: the branch's own commits since it left main.
        const edits = Number(
          (await gitRead(repo, ['rev-list', '--count', `${main}..${commit}`])) ?? 0,
        );
        return { name, commit, updatedAt, by, edits: Math.max(0, edits - made) };
      }),
  );
}

async function presentedDesignBranches(repo: string) {
  const snapshot = await repositoryRefs.read(repo);
  const main = await presentationCommit(repo, snapshot.symbolicHead || 'main').catch(() => null);
  if (!main) return designBranches(repo);
  const folder = designFolder();
  const made = await madeOnBranch(repo, main, folder);
  const branches = snapshot.refs
    .filter((ref) => ref.name.startsWith('refs/heads/') && ownsBranch(ref.name.slice(11), folder))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 40);
  return Promise.all(
    branches.map(async (ref) => ({
      name: ref.shortName,
      commit: ref.oid,
      updatedAt: ref.updatedAt,
      by: ref.by,
      edits: Math.max(
        0,
        Number(
          (await optionalCommitText(repo, ['rev-list', '--count', `${main}..${ref.oid}`])) ?? 0,
        ) - made,
      ),
    })),
  );
}

/**
 * 1 when this design is an artifact main does not have yet: its branch's first commit only made
 * its files, which is not an edit. 0 otherwise.
 */
async function madeOnBranch(repo: string, main: string, folder: string) {
  if (!folderArtifact(folder)) return 0;
  return (await gitRead(repo, ['ls-tree', '--name-only', main, `${folder}/`])) ? 0 : 1;
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
  // An artifact's edit branches are artifact/<name>--<what>, so its branches are easy to tell apart.
  const artifact = folderArtifact();
  const prefix = artifact ? `artifact/${artifact}--` : 'design/';
  let branch = `${prefix}${slug}`;
  for (
    let n = 2;
    await gitRead(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    n++
  )
    branch = `${prefix}${slug}-${n}`;
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
export async function copyPaths(
  repo: string,
  input: {
    target: string;
    from: string;
    paths: string[];
    branch: string;
    message: string;
    by: string;
    /** New contents for files, written alongside the copied paths. */
    writes?: { path: string; content: string | null }[];
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
      if (write.content === null) {
        await git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', write.path]);
        continue;
      }
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
  if (!ownsBranch(branch)) {
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
  if (body?.expect && body.expect !== head && ownsBranch(String(body.ref)))
    fail('This design branch changed since you loaded it; reload and edit again', 409);
  return { branch, head: head! };
}

/** The branch a project's design is approved onto: the repository's default branch. */
export async function mainBranch(repo: string) {
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
    if (!ownsBranch(branch) || !validRef(branch))
      fail(
        folderArtifact()
          ? `Propose a branch of this artifact, like artifact/${folderArtifact()}`
          : 'Propose a design branch, like design/title-size',
      );
    name = branch
      .replace(/^design\//, '')
      .replace(/^artifact\//, '')
      .replace(/--.*$/, '');
  }
  const folder = designFolder();
  const commit =
    (await gitRead(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) ||
    // A branch removed when its design landed still names that proposal.
    landedRemovedCommit(owner, project.id, branch);
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
      `${folder}/`,
    ])) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  if (!paths.length) fail(`${branch} changes nothing in ${folder}/`, 409);
  return { branch, commit: commit!, base, paths, taskId, main, name, folder };
}

function landedRemovedCommit(owner: string, projectId: string, branch: string) {
  const row = branchReviewRow(owner, projectId, branch);
  const landing = row && list('design-review-landing', owner).find((entry) => entry.id === row.id);
  return landing?.branch?.removed ? (row.context.commit as string) : null;
}

// Inbox IDs travel as one URL path segment, so the branch's slashes become tildes.
const branchKey = (branch: string) => branch.replaceAll('/', '~');
function designItemId(projectId: string, branch: string, commit: string) {
  return `design:${projectId}:${branchKey(branch)}:${commit.slice(0, 12)}`;
}

/** Ask for approval in Waiting on you. The same branch at the same commit asks only once. */
/** Links per commit: a commit never changes, so its links are worked out once. */
const linkCache = new Map<string, (BoardLink & { from: string })[]>();

/** The canvas at a commit, for the line a proposal shows; null when it has none.
 * A commit's canvas never changes, so its text is kept: a review reads three per request. */
const canvasTexts = new Map<string, Promise<string | null>>();
async function canvasAt(repo: string, commit: string): Promise<Canvas | null> {
  const path = `${designFolder()}/canvas.json`;
  const key = `${repo}:${commit}:${path}`;
  let text = canvasTexts.get(key);
  if (!text) {
    text = gitRead(repo, ['show', `${commit}:${path}`]);
    canvasTexts.set(key, text);
    if (canvasTexts.size > 32) canvasTexts.delete(canvasTexts.keys().next().value!);
    // A commit the repository lacks may arrive later; only what was read is kept.
    text.then((value) => value === null && canvasTexts.delete(key)).catch(() => {});
  }
  try {
    return JSON.parse((await text) ?? 'null');
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
  paths.filter((path) => path !== `${designFolder()}/canvas.json` && changed.includes(path));
const conflictName = (path: string) => {
  const dir = designFolder();
  return path.startsWith(`${dir}/boards/`)
    ? path.slice(`${dir}/boards/`.length)
    : path.startsWith(`${dir}/`)
      ? path.slice(dir.length + 1)
      : path;
};
const reviewBoardPaths = (context: any) =>
  (context.paths as string[]).filter((path) =>
    path.startsWith(`${context.folder ?? appDesignFolder}/boards/`),
  );

type OverlapMerge = Omit<DesignReviewResolution, 'choice'>;
/**
 * How each file both main and the proposal changed merges, given the three commits. Commits never
 * change, so the answer is worked out once and kept: every review read, its 15-second poll and
 * each main-comparison preview ask it again, and a proposal touching most boards costs a few
 * hundred file reads and merges each time otherwise. Requests that arrive while it is being
 * worked out share the one answer.
 */
const overlapMergeCache = new Map<string, Promise<OverlapMerge[]>>();
/** Files merged at once on a first read: enough to keep Git busy, few enough to hold in memory. */
const overlapMergeWidth = 8;
function overlapMerges(
  repo: string,
  baseCommit: string,
  mainCommit: string,
  proposalCommit: string,
  paths: string[],
): Promise<OverlapMerge[]> {
  if (!paths.length) return Promise.resolve([]);
  const key = JSON.stringify([repo, baseCommit, mainCommit, proposalCommit, paths]);
  const cached = overlapMergeCache.get(key);
  if (cached) {
    // Most recently used last, so the oldest is the one let go.
    overlapMergeCache.delete(key);
    overlapMergeCache.set(key, cached);
    return cached;
  }
  const work = (async () => {
    const merges: (OverlapMerge | null)[] = new Array(paths.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const index = next++;
        merges[index] = await overlapMerge(
          repo,
          [baseCommit, mainCommit, proposalCommit],
          paths[index],
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(overlapMergeWidth, paths.length) }, worker));
    return merges.filter((merge) => merge !== null);
  })();
  overlapMergeCache.set(key, work);
  if (overlapMergeCache.size > 32) overlapMergeCache.delete(overlapMergeCache.keys().next().value!);
  // A failed read is not an answer; the next request tries again.
  work.catch(() => overlapMergeCache.delete(key));
  return work;
}
async function overlapMerge(
  repo: string,
  commits: [base: string, main: string, proposal: string],
  path: string,
): Promise<OverlapMerge | null> {
  const [base, target, from] = await Promise.all(
    commits.map((commit) => keptFile(repo, commit, path)),
  );
  if (target === from || base === from) return null;
  const merged = path.startsWith(`${designFolder()}/boards/`)
    ? mergeBoard(base, target, from)
    : (await mergeLines(repo, path, base, target, from)) === null
      ? {
          kind: 'same-part' as const,
          mainChanged: 'File changed',
          proposalChanged: 'File changed',
          detail: 'Both changed the same lines of this file.',
        }
      : {
          kind: 'kept-both' as const,
          mainChanged: 'File changed',
          proposalChanged: 'File changed',
          detail: 'Different lines changed. Both are kept. Nothing to choose.',
        };
  return {
    file: conflictName(path),
    mainExists: Boolean(target),
    proposalExists: Boolean(from),
    kind: merged.kind,
    mainChanged: merged.mainChanged,
    proposalChanged: merged.proposalChanged,
    detail: merged.detail,
  };
}

/**
 * A file's text at a commit for an answer that is kept: '' only when the commit has no such file.
 * showFile also gives '' when Git fails, which is fine for one read but must not be remembered.
 */
async function keptFile(repo: string, commit: string, path: string) {
  try {
    return (
      await gitSlots(repo, () =>
        repositoryGit(repo, ['show', `${commit}:${path}`], { limit: 16 * 1024 * 1024 }),
      )
    ).toString();
  } catch (error) {
    const entry = await gitSlots(repo, () => repositoryGit(repo, ['ls-tree', commit, '--', path]));
    if (entry.toString().trim()) throw error;
    return '';
  }
}

/** Compare proposal edits with main by screen, not by main's commit ID. No repository writes.
 * An inbox decision rechecks this with withRepositoryWrites held, immediately before merging. */
export function reviewMain(repo: string, context: any, presentation = false) {
  return inDesignFolder(context.folder, () => readReviewMain(repo, context, presentation));
}
async function readReviewMain(repo: string, context: any, presentation: boolean) {
  const dir = designFolder();
  const main = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${context.main}^{commit}`,
  ]);
  if (!main) fail('Main could not be checked. Try again.', 409);
  const diff = await (presentation ? reviewCommitRead : gitRead)(repo, [
    'diff',
    '--name-only',
    '--no-renames',
    context.base,
    main!,
    '--',
    `${dir}/`,
  ]);
  if (diff === null) fail('Main could not be checked. Try again.', 409);
  const changed = diff.split('\n');
  // A board the branch carries only for its instances is main's board at landing, drawn again:
  // main changing it meanwhile is never a conflict.
  const { instanceOnly } = await sharedParts(repo, context.base, context.commit, context.paths);
  const overlapping = conflictPaths(ownPaths(context.paths, instanceOnly), changed);
  const choiceFor = (file: string): BoardChoice | null => {
    const saved = context.choices?.[file];
    return saved?.main === main && saved?.proposal === context.commit ? saved.choice : null;
  };
  // Fresh objects every call: the canvas check below edits them, and callers keep them.
  const resolutions: DesignReviewResolution[] = (
    await overlapMerges(repo, context.base, main!, context.commit, overlapping)
  ).map((merged) => ({ ...merged, choice: choiceFor(merged.file) }));
  if (changed.includes(`${dir}/canvas.json`) && context.paths.includes(`${dir}/canvas.json`)) {
    const [base, target, from] = await Promise.all([
      canvasAt(repo, context.base),
      canvasAt(repo, main!),
      canvasAt(repo, context.commit),
    ]);
    const conflicts = canvasConflicts(base, target, from);
    for (const file of conflicts) {
      const existing = resolutions.find((entry) => entry.file === file);
      if (existing) {
        existing.kind = 'same-part';
        continue;
      }
      const note = file.startsWith('note:');
      const key = file.slice(5);
      resolutions.push({
        file,
        kind: 'same-part',
        choice: choiceFor(file),
        mainChanged: note ? (target?.notes?.[key]?.text ?? 'Removed') : 'Screen placement changed',
        proposalChanged: note
          ? (from?.notes?.[key]?.text ?? 'Removed')
          : 'Screen placement changed',
        detail: note ? 'Both changed this note.' : 'Both changed this screen’s placement.',
      });
    }
    const mainNotes = Object.keys({ ...base?.notes, ...target?.notes }).filter(
      (key) => JSON.stringify(base?.notes?.[key]) !== JSON.stringify(target?.notes?.[key]),
    );
    for (const key of Object.keys({ ...base?.notes, ...from?.notes })) {
      if (
        !mainNotes.length ||
        mainNotes.includes(key) ||
        JSON.stringify(base?.notes?.[key]) === JSON.stringify(from?.notes?.[key])
      )
        continue;
      resolutions.push({
        file: `note:${key}`,
        kind: 'kept-both',
        choice: null,
        mainChanged: mainNotes
          .map((key) => target?.notes?.[key]?.text?.split('\n')[0] ?? 'Removed note')
          .join(', '),
        proposalChanged: from?.notes?.[key]?.text?.split('\n')[0] ?? 'Removed note',
        detail: 'Different notes changed. Both are kept. Nothing to choose.',
      });
    }
  }
  return {
    main: main!,
    resolutions,
    conflicts: resolutions
      .filter((entry) => entry.kind === 'same-part' && !entry.choice)
      .map((entry) => entry.file),
    updated: changed.some(Boolean),
    instanceOnly,
  };
}

/** Discard observed obsolete answers durably, without overwriting a choice saved while
 * this read was in flight. A later reset of main must not resurrect an old answer. */
function obsoleteChoices(row: any, main: string) {
  return Object.entries(row.context.choices ?? {}).filter(([, value]) => {
    const choice = value as { main: string; proposal: string };
    return choice.main !== main || choice.proposal !== row.context.commit;
  });
}
function discardObsoleteChoices(owner: string, row: any, main: string) {
  const obsolete = obsoleteChoices(row, main);
  if (!obsolete.length) return;
  const current = get('v2-inbox-native', owner, row.id);
  const choices = { ...current.context.choices };
  let changed = false;
  for (const [file, saved] of obsolete) {
    if (JSON.stringify(choices[file]) !== JSON.stringify(saved)) continue;
    delete choices[file];
    changed = true;
  }
  if (changed)
    save('v2-inbox-native', owner, { ...current, context: { ...current.context, choices } });
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
  // Each review in the lineage with its round, so a later round can tell last round's notes.
  const rows = list('v2-inbox-native', owner);
  const rounds = new Map<string, number>([
    [designItemId(context.projectId, context.branch, context.commit), context.round ?? 1],
    ...reviewLineage(owner, context).map(
      (earlier) =>
        [earlier, rows.find((row) => row.id === earlier)?.context.round ?? 1] as [string, number],
    ),
  ]);
  const lineage = new Set(rounds.keys());
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
      ...(row.layer ? { layer: row.layer } : {}),
      ...(row.position.offset ? { offset: row.position.offset } : {}),
      ...(row.position.area ? { area: row.position.area } : {}),
      x: row.position.x,
      y: row.position.y,
      text: row.text,
      author: row.author,
      resolved: Boolean(row.resolved),
      reply: row.reply ?? null,
      createdAt: row.createdAt,
      round: rounds.get(row.reviewItemId),
    }))
    .sort((a, b) => a.number - b.number);
}

/**
 * A cheap summary: no Chromium or screenshot work on the landing page. `status` is main as the
 * caller already read it, so one review never compares against two different mains.
 */
// Displayed main/conflict evidence can lag external ref writes by at most two seconds.
// Decisions still call reviewMain directly; a new saved context gets a new key.
const reviewSummaryEvidence = repositoryView(async (key: string) => {
  const [repo, context] = JSON.parse(key);
  return inDesignFolder(context.folder, () =>
    Promise.all([
      reviewMain(repo, context, true),
      reviewTree(repo, context.base, true),
      reviewTree(repo, context.commit, true),
    ] as const),
  );
});

function reviewSummary(
  owner: string,
  project: any,
  row: any,
  status?: Awaited<ReturnType<typeof reviewMain>>,
  presentation = false,
): Promise<DesignReviewSummary> {
  return inDesignFolder(row.context.folder, () =>
    readReviewSummary(owner, project, row, status, presentation),
  );
}
async function readReviewSummary(
  owner: string,
  project: any,
  row: any,
  status: Awaited<ReturnType<typeof reviewMain>> | undefined,
  presentation: boolean,
): Promise<DesignReviewSummary> {
  const { context } = row;
  const repo = project.repositoryPath;
  let [current, baseTree, fromTree] =
    presentation && !status
      ? await reviewSummaryEvidence.read(JSON.stringify([repo, context]))
      : await Promise.all([
          status ?? reviewMain(repo, context),
          reviewTree(repo, context.base),
          reviewTree(repo, context.commit),
        ]);
  // Removing obsolete saved choices is a write, even though it happens during a GET.
  // Recheck directly before that side effect; only display-only evidence can use the view.
  if (presentation && obsoleteChoices(row, current.main).length)
    current = await reviewMain(repo, context);
  discardObsoleteChoices(owner, row, current.main);
  return summaryOf(
    owner,
    project,
    row,
    current.conflicts,
    ownPaths(reviewBoardPaths(context), current.instanceOnly ?? []).map((path) => [
      baseTree.has(path),
      fromTree.has(path),
    ]),
    current.resolutions,
  );
}

/** The summary's words, given which screens exist at the base and at the proposal. */
function summaryOf(
  owner: string,
  project: any,
  row: any,
  conflicts: string[],
  screens: [before: boolean, after: boolean][],
  resolutions: DesignReviewResolution[] = [],
): DesignReviewSummary {
  const { context, item } = row;
  const counts = { screens: screens.length, changed: 0, new: 0, removed: 0 };
  for (const [before, after] of screens) counts[!before ? 'new' : !after ? 'removed' : 'changed']++;
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
    resolutions,
  };
}

async function reviewTree(repo: string, commit: string, presentation = false) {
  const tree = new Map<string, string>();
  const dir = designFolder();
  const text = await (presentation ? reviewCommitRead : reviewGit)(repo, [
    'ls-tree',
    '-r',
    '-z',
    commit,
    '--',
    `${dir}/`,
    // Every design draws with the project's design system.
    ...(dir === appDesignFolder ? [] : [`${appDesignFolder}/ds/`]),
  ]);
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
// Everything a screen says but seen and conflict is fixed by the proposal's commits, so it is
// worked out once per revision and kept: marking a screen seen, saving a pin and the review's
// poll reuse it. Requests that arrive while it is being built share the one build.
type ReviewBuilt = {
  evidence: ReviewEvidence[];
  screens: Omit<DesignReviewScreen, 'seen' | 'conflict'>[];
  afterHashes: Map<string, string>;
  counts: [before: boolean, after: boolean][];
};
const reviewBuilt = new Map<string, ReviewBuilt>();
const reviewBuilding = new Map<string, Promise<ReviewBuilt>>();
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
// Board notes are rare: one listing per commit says which exist, instead of a read per screen.
const noteFiles = new Map<string, Promise<Set<string>>>();
async function boardNote(repo: string, commit: string, path: string) {
  const notes = `${designFolder()}/notes/`;
  const key = `${repo}:${commit}:${notes}`;
  let listed = noteFiles.get(key);
  if (!listed) {
    listed = gitRead(repo, ['ls-tree', '--name-only', '-r', commit, '--', notes]).then(
      (text) => new Set((text ?? '').split('\n')),
    );
    noteFiles.set(key, listed);
    if (noteFiles.size > 64) noteFiles.delete(noteFiles.keys().next().value!);
    listed.catch(() => noteFiles.delete(key));
  }
  return (await listed).has(path) ? (await showFile(repo, commit, path)).slice(0, 2000) : '';
}
function loadReviewScreens(owner: string, project: any, row: any) {
  const key = reviewScreenKey(project.repositoryPath, row);
  const screens = reviewScreens.get(key);
  if (screens) return screens;
  let loading = reviewScreensLoading.get(key);
  if (!loading) {
    // A screen's metadata never depends on drawings, so a preview never waits for every
    // screen of the review to be drawn first.
    loading = designReview(owner, project, row, false, false)
      .then((review) => review.boards)
      .finally(() => reviewScreensLoading.delete(key));
    reviewScreensLoading.set(key, loading);
  }
  return loading;
}

async function buildReviewScreens(
  repo: string,
  context: any,
  comparison: string,
  paths: string[],
  canvases: { canvas: Canvas | null; beforeCanvas: Canvas | null; originalCanvas: Canvas | null },
  metadataOnly = false,
): Promise<ReviewBuilt> {
  const { canvas, beforeCanvas, originalCanvas } = canvases;
  const pages = canvas ? sections(canvas) : [];
  const oldPages = originalCanvas ? sections(originalCanvas) : [];
  // Asked at most once: it is the same answer for every board.
  let designSystemDiff: Promise<string | null> | undefined;
  const evidence: ReviewEvidence[] = [];
  const texts = new Map<string, { original: string; after: string }>();
  const dir = designFolder();
  const screens: ReviewBuilt['screens'] = await Promise.all(
    paths.map(async (path) => {
      const file = path.slice(`${dir}/boards/`.length);
      const [was, after, original] = await Promise.all([
        showFile(repo, comparison, path),
        showFile(repo, context.commit, path),
        comparison === context.base ? null : showFile(repo, context.base, path),
      ]).then(([was, after, original]) => [was, after, original ?? was]);
      texts.set(path, { original, after });
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
      const boardNotes = await boardNote(
        repo,
        after ? context.commit : comparison,
        `${dir}/notes/${file.replace(/\.html$/, '.md')}`,
      );
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
      const screen = {
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
        status: (!before ? 'new' : !after ? 'removed' : 'changed') as DesignReviewScreen['status'],
        before: context.previousCommit && !changedSinceReview ? context.base : comparison,
        after: context.commit,
        changes,
        lines: changes.map((change) => change.words),
        changedSinceReview,
      };
      let rendered;
      if (before && after && !metadataOnly) {
        try {
          const [a, b] = await Promise.all([
            renderBoardLayout(repo, screen.before, file, screen.w, screen.h),
            renderBoardLayout(repo, screen.after, file, screen.w, screen.h),
          ]);
          rendered = { before: a, after: b };
        } catch {
          /* A review remains usable without Chromium; no pixel claims are made. */
        }
      }
      evidence.push(reviewEvidence(screen, before, after, rendered, context.changeWords?.[file]));
      return screen;
    }),
  );
  return {
    evidence,
    screens,
    afterHashes: new Map(paths.map((path) => [path, sha1(texts.get(path)!.after)])),
    // Boards carried only for a shared part's instances are not among the screens, nor counted.
    counts: reviewBoardPaths(context)
      .filter((path) => texts.has(path))
      .map((path) => [Boolean(texts.get(path)?.original), Boolean(texts.get(path)?.after)]),
  };
}

/**
 * The components a proposal changed, as the review shows them: each one unit to approve, with the
 * screens landing draws it on and one screen to look at it on. That screen is the first the review
 * already shows that has an instance, in canvas page and board order, or else the first on the
 * canvas that has one; when it has no change of its own it joins the review's screens for the part.
 */
async function reviewParts(
  repo: string,
  context: any,
  row: any,
  input: {
    status: Awaited<ReturnType<typeof reviewMain>>;
    boards: DesignReviewScreen[];
    canvas: Canvas | null;
    pages: ReturnType<typeof sections>;
    order: string[];
    comparison: string;
    lineage: string[];
    seen: any[];
    approved: boolean;
  },
): Promise<{ parts: DesignReviewPart[]; lookAt: DesignReviewScreen[] }> {
  const { boards, canvas, pages, order } = input;
  const { changed } = await sharedParts(repo, context.base, context.commit, context.paths);
  if (!changed.length || !canvas) return { parts: [], lookAt: [] };
  const dir = designFolder();
  const [atCommit, atMain, previous] = await Promise.all([
    componentUsage(repo, context.commit),
    componentUsage(repo, input.status.main),
    context.previousCommit ? libraryAt(repo, context.previousCommit) : null,
  ]);
  const rank = (file: string) => {
    const page = pages.findIndex((entry) => entry.boards.includes(file));
    return [page < 0 ? pages.length : page, order.indexOf(file)];
  };
  const parts: DesignReviewPart[] = [];
  const lookAt = new Map<string, DesignReviewScreen>();
  for (const component of changed) {
    const shown = (atCommit[component.id] ?? []).filter((file) => canvas.boards[file]);
    // Counted as landing writes them: every instance on main, and the boards this branch brings.
    const screens = new Set([
      ...(atMain[component.id] ?? []),
      ...(atCommit[component.id] ?? []).filter((file) =>
        (context.paths as string[]).includes(`${dir}/boards/${file}`),
      ),
    ]);
    const file =
      boards.find((board) => !board.removed && shown.includes(board.file))?.file ??
      [...shown].sort((a, b) => {
        const [pa, oa] = rank(a);
        const [pb, ob] = rank(b);
        return pa - pb || oa - ob;
      })[0];
    if (!screens.size || !file) continue;
    const seen =
      input.approved ||
      input.seen.some(
        (entry) =>
          entry.board === `part:${component.id}` &&
          (entry.itemId === row.id ||
            (input.lineage.includes(entry.itemId) && entry.hash === component.hash)),
      );
    const placed = canvas.boards[file];
    const before = previous?.components.find((item) => item.id === component.id);
    const sinceReview =
      !context.previousCommit || !before || sha1(JSON.stringify(before)) !== component.hash;
    parts.push({
      component: component.id,
      name: component.name,
      screens: screens.size,
      lookAt: { file, title: placed.title ?? screenName(file) },
      seen,
      changedSinceReview: sinceReview,
    });
    if (boards.some((board) => board.file === file)) continue;
    const existing = lookAt.get(file);
    if (existing) {
      existing.seen &&= seen;
      existing.changedSinceReview ||= sinceReview;
      continue;
    }
    const page = pages.find((entry) => entry.boards.includes(file));
    lookAt.set(file, {
      file,
      title: placed.title ?? screenName(file),
      w: placed.w ?? 1440,
      h: placed.h ?? 900,
      widths: reviewWidths(placed.w ?? 1440),
      page: page?.title ?? null,
      pageId: page?.id ?? null,
      index: page ? page.boards.indexOf(file) + 1 : null,
      count: page?.boards.length ?? null,
      notes: null,
      added: false,
      removed: false,
      status: 'changed',
      before: input.comparison,
      after: context.commit,
      changes: [],
      lines: [],
      seen,
      changedSinceReview: sinceReview,
      conflict: false,
      instanceOnly: true,
    });
  }
  return { parts, lookAt: [...lookAt.values()] };
}

export function designReview(
  owner: string,
  project: any,
  row: any,
  fullEvidence = false,
  /**
   * False leaves Chromium out: the review's `changes` then come from the boards' text alone.
   * Everything else in the review is the same either way.
   */
  drawn = true,
): Promise<DesignReview> {
  return inDesignFolder(row.context.folder, () =>
    readDesignReview(owner, project, row, fullEvidence, drawn),
  );
}
async function readDesignReview(
  owner: string,
  project: any,
  row: any,
  fullEvidence: boolean,
  drawn: boolean,
): Promise<DesignReview> {
  const { context } = row;
  const item = documentReview(row);
  const dir = designFolder();
  const repo = project.repositoryPath;
  const status = await reviewMain(repo, context);
  discardObsoleteChoices(owner, row, status.main);
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
  const previousContexts = lineage.map((id) => reviewRow(owner, project.id, id).context);
  const previousPaths = previousContexts.flatMap((previous) => previous.paths as string[]);
  // A shared part is one thing to look at, not every board that shows it: boards carried only
  // for its instances, now or by an earlier round that no longer carries them, are left out.
  const instanceOnly = new Set(status.instanceOnly);
  const droppedInstances = new Set(
    (
      await Promise.all(
        previousContexts.map((previous) =>
          sharedParts(repo, previous.base, previous.commit, previous.paths),
        ),
      )
    )
      .flatMap((parts) => parts.instanceOnly)
      .filter((path) => !(context.paths as string[]).includes(path)),
  );
  const paths = [
    ...new Set([
      ...(context.paths as string[]),
      ...previousPaths,
      ...status.resolutions
        .filter((entry) => boardPattern.test(entry.file))
        .map((entry) => `${dir}/boards/${entry.file}`),
    ]),
  ].filter(
    (path) =>
      path.startsWith(`${dir}/boards/`) && !instanceOnly.has(path) && !droppedInstances.has(path),
  );
  const seen = list('design-review-seen', owner);
  const metadataOnly = !drawn || (status.resolutions.length > 0 && !fullEvidence);
  const builtKey = `${reviewScreenKey(repo, row)}:${context.commit}:${paths.join(',')}:${metadataOnly}`;
  let built = reviewBuilt.get(builtKey);
  if (!built) {
    let building = reviewBuilding.get(builtKey);
    if (building) {
      // Someone is waiting for this build now, so its drawings stop giving way to others'.
      buildingLanes.get(builtKey)?.promote(Math.max(askingPriority(), drawingPriority.review));
    } else {
      // Its own place in line, so promoting it never promotes the rest of what was drawing ahead.
      const parent = drawingLane.getStore();
      const lane = parent ? childLane(parent) : childLane(undefined, drawingPriority.review);
      buildingLanes.set(builtKey, lane);
      building = drawingLane
        .run(lane, () =>
          buildReviewScreens(
            repo,
            context,
            comparison,
            paths,
            {
              canvas,
              beforeCanvas,
              originalCanvas,
            },
            metadataOnly,
          ),
        )
        .then((result) => {
          // Drawings were dropped half way: what is left is not this review's evidence.
          if (lane.cancelled) throw new DrawingCancelled();
          return result;
        })
        .finally(() => {
          reviewBuilding.delete(builtKey);
          buildingLanes.delete(builtKey);
        });
      reviewBuilding.set(builtKey, building);
    }
    built = await building;
    reviewBuilt.set(builtKey, built);
    if (reviewBuilt.size > 64) reviewBuilt.delete(reviewBuilt.keys().next().value!);
  }
  const revision = built;
  const round = context.round ?? 1;
  const boards: DesignReviewScreen[] = await Promise.all(
    revision.screens.map(async (screen) => {
      const path = `${dir}/boards/${screen.file}`;
      // The earliest round it was ticked in: a later round shows that one.
      let seenInRound: number | undefined;
      for (const entry of seen) {
        if (entry.board !== screen.file) continue;
        const at =
          entry.itemId === item.id
            ? round
            : !screen.changedSinceReview &&
                lineage.includes(entry.itemId) &&
                sha1(await showFile(repo, entry.revision, path)) === revision.afterHashes.get(path)
              ? (previousContexts[lineage.indexOf(entry.itemId)]?.round ?? 1)
              : undefined;
        if (at !== undefined && (seenInRound === undefined || at < seenInRound)) seenInRound = at;
      }
      const wasSeen = seenInRound !== undefined;
      const approved = item.answer?.actionId === 'approve';
      const resolution = status.resolutions.find((entry) => entry.file === screen.file);
      return {
        ...screen,
        seen: approved || wasSeen,
        ...(wasSeen || approved ? { seenInRound: seenInRound ?? round } : {}),
        conflict: status.conflicts.includes(screen.file),
        resolution,
        main: resolution ? status.main : undefined,
      };
    }),
  );
  const pageOrder = [...new Set([...pages.map((p) => p.id), ...oldPages.map((p) => p.id)])];
  const byCanvas = (a: DesignReviewScreen, b: DesignReviewScreen) =>
    pageOrder.indexOf(a.pageId ?? '') - pageOrder.indexOf(b.pageId ?? '') ||
    order.indexOf(a.file) - order.indexOf(b.file);
  boards.sort(byCanvas);
  const { parts, lookAt } = await reviewParts(repo, context, row, {
    status,
    boards,
    canvas,
    pages,
    order,
    comparison,
    lineage,
    seen,
    approved: item.answer?.actionId === 'approve',
  });
  if (lookAt.length) {
    boards.push(...lookAt);
    boards.sort(byCanvas);
  }
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
  const mainTime = status.updated
    ? await gitRead(repo, ['show', '-s', '--format=%cI', status.main])
    : null;
  return {
    ...summaryOf(owner, project, row, status.conflicts, revision.counts, status.resolutions),
    api: designApiPath(project.id, dir),
    item,
    task: context.taskId
      ? (list('task', owner).find((entry) => entry.id === context.taskId)?.title ?? null)
      : null,
    before: comparison,
    after: context.commit,
    main: status.main,
    updatedWithMainAt: mainTime,
    round,
    previousItemId: context.previousItemId ?? null,
    landing: reviewLanding(owner, row.id),
    feedback: reviewFeedback(owner, row),
    proposerTaskId: buildProposerTask(owner, row)?.id ?? null,
    boards,
    parts,
    changes: groupReviewChanges(
      boards.map((board) => {
        const evidence = revision.evidence.find((entry) => entry.file === board.file);
        if (evidence) return { ...evidence, seen: board.seen };
        // A screen shown only for a shared part: one row, in the part's words.
        const shown = parts.filter((part) => part.lookAt.file === board.file);
        return {
          file: board.file,
          title: board.title,
          status: 'changed' as const,
          regions: [],
          changeWords: shown
            .map((part) => `${part.name} · ${part.screens} screen${part.screens === 1 ? '' : 's'}`)
            .join(' · '),
          nothingElse: false,
          seen: board.seen,
          changedSinceReview: board.changedSinceReview,
        };
      }),
      [
        project.name,
        ...list('app', owner)
          .filter((app) => app.projectId === project.id)
          .map((app) => app.name),
      ],
    ),
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
  const review = await designReview(owner, project, waiting, false, false);
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
          ? [board.before, board.after, ...(board.main ? [board.main] : [])]
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
          !Number.isInteger(width) ||
          width < 320 ||
          width > 2560 ||
          x > width ||
          y > (board?.h ?? 100000)
        )
          fail('Invalid pin coordinates');
        if (!validReviewAnchor(body, width, board?.h ?? 100000)) fail('Invalid note anchor');
        if (body.drawing !== undefined) {
          const drawing = body.drawing;
          if (
            !board ||
            note ||
            !validReviewDrawing(drawing) ||
            drawing.nativeWidth !== width ||
            drawing.nativeHeight !== board.h ||
            (revision !== board[drawing.side] &&
              !(drawing.side === 'before' && revision === board.main)) ||
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
          layer: body.layer ?? null,
          text,
          author: owner,
          commit: revision,
          number: Math.max(0, ...existing.map((entry) => entry.number ?? 0)) + 1,
          position: {
            width,
            revision,
            x,
            y,
            noteId: note ? note.id : null,
            offset: body.offset,
            area: body.area,
          },
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
    /** The screens the owner should look at first, in the author's words. */
    lookAt?: unknown;
  },
) {
  const title = optionalWords(input.title, 200);
  const summary = optionalWords(input.summary, 4000);
  if (!title || !summary) fail('A proposal needs a title and a summary');
  const changeWords = validateChangeWords(input.changeWords);
  if (
    input.lookAt !== undefined &&
    (!Array.isArray(input.lookAt) ||
      input.lookAt.length > 20 ||
      input.lookAt.some(
        (entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 200,
      ))
  )
    fail('Look at names up to 20 screens');
  const lookAt = ((input.lookAt as string[] | undefined) ?? []).map((entry) => entry.trim());
  // With the lock, a proposal never replaces one that is being approved at that moment.
  return withRepositoryWrites(project.repositoryPath, async () => {
    const proposal = await proposalFor(owner, project, input);
    const canvas = proposal.paths.includes(`${proposal.folder}/canvas.json`);
    const [before, after] = canvas
      ? await Promise.all([
          canvasAt(project.repositoryPath, proposal.base),
          canvasAt(project.repositoryPath, proposal.commit),
        ])
      : [null, null];
    const item = recordProposal(owner, project, proposal, canvas, before, after, {
      title,
      summary,
      changeWords,
      lookAt,
    });
    await ensureDesignCheckBoards(owner, project, get('v2-inbox-native', owner, item.id));
    return item;
  });
}

/** Persist cheap board metadata once, including older approvals first opened by a task. */
export function ensureDesignCheckBoards(owner: string, project: any, row: any) {
  return inDesignFolder(row.context.folder, () => saveDesignCheckBoards(owner, project, row));
}
async function saveDesignCheckBoards(owner: string, project: any, row: any) {
  const landing = list('design-review-landing', owner).find((entry) => entry.id === row.id);
  const commit = landing?.commit ?? row.context.commit;
  if (row.context.checkBoards && row.context.checkBoardsCommit === commit) return;
  const canvas = await canvasAt(project.repositoryPath, commit);
  const boards = await Promise.all(
    reviewBoardPaths(row.context).map(async (path) => {
      const file = path.slice(`${designFolder()}/boards/`.length);
      const placed = canvas?.boards[file];
      const html = await showFile(project.repositoryPath, commit, path);
      if (!html) return null;
      const width =
        placed?.w ?? Number(/name="design-board"[^>]*content="width=(\d+)/.exec(html)?.[1] ?? 1440);
      return {
        file,
        title: placed?.title ?? screenName(file),
        widths: reviewWidths(width),
        height: placed?.h ?? 900,
      };
    }),
  );
  const current = get('v2-inbox-native', owner, row.id);
  save('v2-inbox-native', owner, {
    ...current,
    context: { ...current.context, checkBoards: boards.filter(Boolean), checkBoardsCommit: commit },
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
    lookAt?: string[];
  },
) {
  const { title, summary, changeWords, lookAt = [] } = words;
  const history = list('v2-inbox-native', owner)
    .filter(
      (row) =>
        row.context?.projectId === project.id &&
        // A task started for a review's notes proposes from its own branch: the link says which review it continues.
        (row.context?.branch === proposal.branch ||
          (proposal.taskId !== null && row.context?.followUpTaskId === proposal.taskId)) &&
        row.item.state === 'answered' &&
        ['changes', 'update'].includes(row.item.answer?.actionId),
    )
    .sort((a, b) => b.item.answer.at.localeCompare(a.item.answer.at));
  const previous = history[0];
  const proposer = proposalProposer(owner, proposal.taskId);

  const dir = proposal.folder;
  const boards = proposal.paths
    .filter((path) => path.startsWith(`${dir}/boards/`))
    .map((path) => path.slice(`${dir}/boards/`.length).replace(/\.html$/, ''));
  const notes = canvas ? noteChanges(before, after) : [];
  const marks = canvas ? markChanges(before, after) : 0;
  // canvas.json carries the boards' places too; it counts as its own change only when nothing on it is named.
  const others = proposal.paths.filter(
    (path) =>
      !path.startsWith(`${dir}/boards/`) &&
      !(path === `${dir}/canvas.json` && (notes.length || marks || boards.length)),
  ).length;
  const document = reviewedDocument(proposal);
  const item: InboxItem = {
    id: designItemId(project.id, proposal.branch, proposal.commit),
    kind: 'other',
    title: title ?? previous?.item.title ?? screenName(proposal.name.replaceAll('-', ' ')),
    text: document
      ? `The document changed on ${proposal.branch}.`
      : changeSummary(proposal.branch, { boards, notes, marks, others }),
    from: proposer.id ?? owner,
    projectId: project.id,
    ...(proposal.taskId ? { taskId: proposal.taskId } : {}),
    ...(document ? { document } : {}),
    createdAt: now(),
    state: 'waiting',
    actions: [
      { id: 'approve', label: approveLabel(document), primary: true },
      { id: 'changes', label: 'Ask for changes' },
      { id: 'update', label: 'Ask to update' },
    ],
  };
  // A newer commit replaces the request for the same branch.
  const stale = `design:${project.id}:${branchKey(proposal.branch)}:`;
  // Nobody will look at an earlier round's screens drawn ahead of time.
  cancelWarmUps(stale, item.id);
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
    ...(lookAt.length ? { lookAt } : {}),
    proposer,
    proposerTaskId: proposal.taskId ?? null,
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
function prepareDecision(owner: string, repo: string, item: InboxItem, body: any, context: any) {
  return inDesignFolder(context.folder, () => decide(owner, repo, item, body, context));
}
async function decide(owner: string, repo: string, item: InboxItem, body: any, context: any) {
  const dir = designFolder();
  const status = await reviewMain(repo, context);
  discardObsoleteChoices(owner, { id: item.id, context }, status.main);
  if (body.actionId !== 'update' && status.conflicts.length)
    fail('These screens conflict with main. Resolve them in the review before deciding.', 409);
  if (body.actionId === 'update' && !status.resolutions.length)
    fail('This proposal has no conflicts with main. Refresh the review.', 409);
  if (body.actionId !== 'approve')
    return { conflicts: status.resolutions.map((entry) => entry.file) };
  if (body.delay === true)
    return { conflicts: status.conflicts, landingAt: new Date(Date.now() + 30000).toISOString() };
  // Use exactly the commit checked above; update-ref below rejects a concurrent main move.
  const target = status.main;
  // Boards carried only for their instances land as main's boards, drawn again below.
  const paths = ownPaths(context.paths as string[], status.instanceOnly);
  const merged = await mergedWrites(repo, {
    base: context.base,
    target,
    from: context.commit,
    paths,
    main: context.main,
    branch: context.branch,
    resolutions: status.resolutions,
  });
  const instances = await instanceWrites(repo, target, context.commit, paths);
  // Sync the resolved contents, never replace a merged board with the branch’s instance copy.
  const library = parseLibrary(
    merged.find((write) => write.path === libraryPath)?.content ??
      (await showFile(
        repo,
        context.paths.includes(libraryPath) ? context.commit : target,
        libraryPath,
      )),
  );
  const writes = new Map([...instances, ...merged].map((write) => [write.path, write]));
  if (library)
    for (const path of paths) {
      if (path.startsWith(`${dir}/boards/`) && !writes.has(path)) {
        const content = await showFile(repo, context.commit, path);
        if (content) writes.set(path, { path, content });
      }
    }
  if (library)
    for (const write of writes.values()) {
      if (write.path.startsWith(`${dir}/boards/`) && write.content)
        write.content = syncInstances(write.content, library);
    }
  const commit = await copyPaths(repo, {
    target,
    from: context.commit,
    paths,
    writes: [...writes.values()],
    branch: context.main,
    message: `${item.title.replace(/^Approve /, 'Approve ').replace(/\?$/, '')} from ${context.branch}${body.landingId ? `\n\nDesign-Review: ${body.landingId}` : ''}`,
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
    if (prepared.landingAt) {
      save('design-review-landing', owner, {
        id: item.id,
        at: prepared.landingAt,
        state: 'pending',
      });
      return;
    }
    const commit = prepared.commit!;
    save('project', owner, {
      ...get('project', owner, project.id),
      head: commit,
      updatedAt: now(),
    });
    queuePushTrigger(owner, project.id, `refs/heads/${context.main}`, commit);
    // Landing records approval only. Building requires a separate owner request.
    if (!list('design-review-landing', owner).some((entry) => entry.id === item.id))
      save('design-review-landing', owner, {
        id: item.id,
        at: now(),
        state: 'landed',
        commit,
      });
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
  // Who has the notes is decided now and kept with the answer, so the review reads the same later.
  const terminal = context.taskId ? null : waitingTerminal(owner, project.id, context.branch);
  let delivery: DesignFeedbackDelivery = context.taskId
    ? { kind: 'task', taskId: context.taskId }
    : terminal
      ? { kind: 'terminal', computer: terminal.computer }
      : { kind: 'nobody' };
  if (note)
    save('design-comment', owner, {
      id: id(),
      projectId: project.id,
      board:
        reviewBoardPaths(context)[0]?.slice(
          `${context.folder ?? appDesignFolder}/boards/`.length,
        ) ?? 'canvas.json',
      layer: null,
      folder: context.folder ?? appDesignFolder,
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
  // Ask to update hands the conflict back. With nobody to hand it to, a task is started for it, as
  // before; its proposal is this review's next round.
  if (body.actionId === 'update' && delivery.kind === 'nobody') {
    const task = queueTask(owner, {
      projectId: project.id,
      title: `Update design: ${item.title}`,
      ref: context.commit,
      prompt: content,
      ...serverTaskComputer(owner),
    });
    const row = get('v2-inbox-native', owner, item.id);
    context.taskId = task.id;
    context.followUpTaskId = task.id;
    item.taskId = task.id;
    save('v2-inbox-native', owner, { ...row, item, context });
    event(owner, project.id, null, 'v2.inbox', { item });
    delivery = { kind: 'task', taskId: task.id, started: true };
  }
  save('design-review-feedback', owner, {
    id: item.id,
    projectId: project.id,
    taskId: context.taskId,
    actionId: body.actionId,
    content,
    note: note || null,
    pins: pins.map((pin) => pin.id),
    notes: body.actionId === 'update' ? 1 : pins.length + (note ? 1 : 0),
    delivery,
    createdAt: now(),
  });
}

type DesignFeedbackDelivery =
  | { kind: 'task'; taskId: string; started?: boolean }
  | { kind: 'terminal'; computer: string }
  | { kind: 'nobody' };

/** How long a terminal running `deploy design feedback --wait` counts as waiting after it last asked. */
const terminalWaitLife = 20_000;
const branchRecordId = (projectId: string, branch: string) => `${projectId}:${branch}`;

/** A terminal on some computer that is waiting for the owner's answer on this branch right now. */
function waitingTerminal(owner: string, projectId: string, branch: string) {
  const wait = list('design-feedback-wait', owner).find(
    (row) => row.id === branchRecordId(projectId, branch),
  );
  return wait && Date.now() - Date.parse(wait.at) < terminalWaitLife ? wait : null;
}

/** What the review says about the owner's last notes: how many, and who has them. */
function reviewFeedback(owner: string, row: any): DesignReview['feedback'] {
  if (!['changes', 'update'].includes(row.item.answer?.actionId)) return null;
  const saved = list('design-review-feedback', owner).find((entry) => entry.id === row.id);
  if (!saved) return null;
  // Answers saved before deliveries were recorded went to the proposer's task, or to nobody.
  const delivery: DesignFeedbackDelivery =
    saved.delivery ?? (saved.taskId ? { kind: 'task', taskId: saved.taskId } : { kind: 'nobody' });
  return {
    actionId: saved.actionId ?? row.item.answer.actionId,
    notes: saved.notes ?? Math.max(1, (saved.pins?.length ?? 0) + (saved.note ? 1 : 0)),
    delivery: delivery.kind,
    ...(delivery.kind === 'terminal' ? { computer: delivery.computer } : {}),
    ...(delivery.kind === 'task' ? { taskId: delivery.taskId } : {}),
  };
}

/** The brief of a task started on a design nobody is working on: the owner's note and every open pin. */
export function designFollowUpBrief(input: {
  title: string;
  branch: string;
  folder: string;
  round: number;
  content: string;
}) {
  return [
    `The owner asked for changes on the design “${input.title}” (${input.branch}, round ${input.round}). Continue it from that branch's last commit.`,
    input.content,
    `Change the boards in ${input.folder}/ only. When a pin is done, answer it with deploy_design action resolve (commentId and a short reply). Then propose again with deploy_design action propose, with a title and a summary of what changed. The proposal continues this review as its next round.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Start a task for notes nobody has: on the review's branch, with the owner's note and every pin
 * still open. The task's proposal is linked to this review, so it is the review's next round.
 */
export function startDesignFollowUp(owner: string, projectId: string, itemId: unknown) {
  return db
    .transaction(() => {
      const row = reviewRow(owner, projectId, itemId);
      const saved = list('design-review-feedback', owner).find((entry) => entry.id === row.id);
      if (!['changes', 'update'].includes(row.item.answer?.actionId) || !saved)
        fail('The owner has not asked for changes on this design', 409);
      if (saved.delivery?.kind === 'task' || (!saved.delivery && saved.taskId))
        fail('A task already has these notes', 409);
      const context = row.context;
      const folder = context.folder ?? appDesignFolder;
      const open = reviewPins(owner, context).filter((pin) => !pin.resolved);
      const content =
        saved.actionId === 'update'
          ? saved.content
          : [
              saved.note,
              ...open.map(
                (pin) =>
                  `Pin ${pin.number} · ${pin.board}${pin.layer ? ` · ${pin.layer}` : ''} · comment ${pin.id}\n${pin.text}`,
              ),
            ]
              .filter(Boolean)
              .join('\n\n') || saved.content;
      const task = queueTask(owner, {
        projectId,
        title: `Update design: ${row.item.title}`,
        ref: context.commit,
        prompt: designFollowUpBrief({
          title: row.item.title,
          branch: context.branch,
          folder,
          round: context.round ?? 1,
          content,
        }),
        ...serverTaskComputer(owner),
      });
      // The task works on this design, in this folder, from the proposal's commit.
      save('task', owner, {
        ...get('task', owner, task.id),
        design: { ...(folder === appDesignFolder ? {} : { folder }), commit: context.commit },
      });
      const item = { ...row.item, taskId: task.id };
      save('v2-inbox-native', owner, {
        ...row,
        item,
        context: { ...context, taskId: task.id, followUpTaskId: task.id },
      });
      save('design-review-feedback', owner, {
        ...saved,
        taskId: task.id,
        delivery: { kind: 'task', taskId: task.id, started: true },
      });
      event(owner, projectId, null, 'v2.inbox', { item });
      return { taskId: task.id };
    })
    .immediate();
}

registerInboxSource('design', decideDesign, async ({ owner, body, context, check, answer }) => {
  check();
  const repo = requireRepository(owner, context.projectId).repositoryPath as string;
  return withRepositoryWrites(repo, async () => {
    // Checked again: another answer may have held the lock while this one waited for it.
    const result = answer(
      await prepareDecision(
        owner,
        repo,
        check(),
        body,
        reviewRow(owner, context.projectId, check().id).context,
      ),
    );
    if (body.actionId === 'approve' && !body.delay)
      await removeLandedBranch(owner, repo, result.id).catch((error) =>
        console.error('Design branch removal failed:', error),
      );
    return result;
  });
});

/** What the builder is told once an approved design is on main. The same words for every proposer. */
export function designBuildBrief(input: {
  title: string;
  summary?: string | null;
  commit: string;
  main: string;
  paths: string[];
}) {
  const shown = input.paths.slice(0, 60);
  return [
    `The design “${input.title}” is approved and on ${input.main} at ${input.commit.slice(0, 8)}.`,
    input.summary?.trim() || null,
    `What changed in the design:\n${shown.map((path) => `- ${path}`).join('\n')}${
      input.paths.length > shown.length ? `\n- and ${input.paths.length - shown.length} more` : ''
    }`,
    'Before starting, use deploy_require_tools as your first step to state the executable names of the programs you need.',
    'Build exactly what was approved, on every client the changed boards show. If the build has to differ from a board (wording, a state the board missed, a platform limit), stop that part and report the difference for the owner to decide before going on.',
    'When it is built, render each changed board, capture the running app at the same widths, and compare them (the project’s design/README.md says how, if it has one). Then report with deploy_design, action "built": state "matches", or state "differs" with a positive differences count and required text saying what differs in plain words. You may include why, board (a filename such as Header.html), width, and screenshotId from this task’s existing screenshot mechanism. For matches you may include captures, the number compared. Include comparisons (an array of { board, width, screenshotId }) to make the compared pairs available from the check. A later report replaces the earlier report; differs brings one decision to the owner. Wait for that decision: Fix the app returns it to this task; Keep it and update the design approves the difference and asks you to update the board in your own branch for the pull request. The work is not finished until that report is in.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A task nobody picked a computer for goes to one that is online and takes tasks. */
function serverTaskComputer(owner: string) {
  const workerId = onlineTaskWorker(owner);
  return workerId ? { workerId } : {};
}

/** Keep the original proposer separate from the task later assigned to build. */
function buildProposerTask(owner: string, row: any) {
  const taskId =
    row.context.proposerTaskId !== undefined ? row.context.proposerTaskId : row.context.taskId;
  return list('task', owner).find(
    (task) => task.id === taskId && !['cancelled', 'archived'].includes(task.status),
  );
}

function reviewLanding(owner: string, itemId: string) {
  const landing = list('design-review-landing', owner).find((entry) => entry.id === itemId);
  if (!landing?.build?.taskId) return landing;
  return {
    ...landing,
    build: { ...landing.build, name: proposalProposer(owner, landing.build.taskId).name },
  };
}

/** Only an explicit owner request starts a build; landing and boot never call this. */
export function requestDesignBuild(
  owner: string,
  projectId: string,
  itemId: string,
  place: unknown,
) {
  return db
    .transaction(() => {
      const row = reviewRow(owner, projectId, itemId);
      const landing = list('design-review-landing', owner).find((entry) => entry.id === itemId);
      if (row.item.answer?.actionId !== 'approve' || landing?.state !== 'landed' || !landing.commit)
        fail('The approved design must be on main before building', 409);
      if (landing.build) return landing.build;
      if (place !== 'proposer' && place !== 'new') fail('Choose the proposer’s task or a new task');
      const context = row.context;
      const proposerTask = buildProposerTask(owner, row);
      if (place === 'proposer' && !proposerTask)
        fail('This design can only build in a new task', 409);
      const workerId = onlineTaskWorker(owner);
      if (!workerId) fail('No computer is online and taking tasks', 409);
      const content = designBuildBrief({
        title: row.item.title,
        summary: context.summary,
        commit: landing.commit,
        main: context.main ?? 'main',
        paths: context.paths ?? [],
      });
      let taskId: string;
      if (place === 'proposer') {
        taskId = proposerTask!.id;
        const proposerWorker = proposerTask!.workerId || 'local';
        if (
          !computers(owner).some(
            (worker) => worker.id === proposerWorker && worker.status === 'online',
          )
        )
          fail('The proposer’s computer is not online. Choose a new task or bring it online.', 409);
        assertWorkerRole(owner, proposerWorker, 'tasks');
        const queued = queuedMessage(owner, taskId);
        if (queued?.status === 'queued') {
          save('queued-message', owner, { ...queued, content: `${queued.content}\n\n${content}` });
          event(owner, taskId, null, 'message.queued', { status: 'queued' });
        } else queueMessage(owner, taskId, { content });
      } else {
        taskId = queueTask(owner, {
          projectId,
          title: `Build: ${row.item.title}`,
          ref: landing.commit,
          prompt: content,
          workerId,
        }).id;
      }
      const build = { taskId, started: place === 'new', at: now() };
      save('design-review-landing', owner, { ...landing, build });
      const item = { ...row.item, taskId };
      save('v2-inbox-native', owner, {
        ...row,
        item,
        context: {
          ...context,
          proposerTaskId:
            context.proposerTaskId !== undefined
              ? context.proposerTaskId
              : (context.taskId ?? null),
          taskId,
        },
      });
      event(owner, projectId, null, 'v2.inbox', { item });
      return build;
    })
    .immediate();
}

/**
 * Once a design is on main its branch holds nothing main lacks, so it is removed, but only a
 * design or artifact branch, still at the proposed commit, whose every change since it left main is
 * inside the design folder the approval copied. Anything else would lose work, so it is kept. The
 * proposal's commit stays under refs/deploy/design-reviews, so round history still reads.
 * Call with withRepositoryWrites held.
 */
async function removeLandedBranch(owner: string, repo: string, itemId: string) {
  const landing = list('design-review-landing', owner).find((entry) => entry.id === itemId);
  if (landing?.state !== 'landed' || landing.branch) return;
  const row = get('v2-inbox-native', owner, itemId);
  let branch: { name: string; removed: boolean; kept?: string };
  try {
    branch = await landedBranchRemoval(repo, itemId, row.context);
  } catch (error) {
    console.error(`Design branch ${row.context.branch} was kept:`, error);
    branch = { name: row.context.branch, removed: false, kept: 'it could not be removed' };
  }
  save('design-review-landing', owner, { ...get('design-review-landing', owner, itemId), branch });
}
async function landedBranchRemoval(repo: string, itemId: string, context: any) {
  const name = String(context.branch);
  const kept = (why: string) => ({ name, removed: false, kept: why });
  if (!/^(design|artifact)\//.test(name)) return kept('it is not a design branch');
  const tip = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${name}^{commit}`,
  ]);
  if (!tip) return { name, removed: true };
  if (tip !== context.commit) return kept('it has commits after the proposal');
  const main = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${context.main ?? 'main'}^{commit}`,
  ]);
  const base = main && (await gitRead(repo, ['merge-base', main, tip]));
  if (!base) return kept('it shares no history with main');
  const changed = await gitRead(repo, ['diff', '--name-only', '--no-renames', base, tip]);
  if (changed === null) return kept('its changes could not be read');
  const folder = `${context.folder ?? appDesignFolder}/`;
  if (changed.split('\n').some((path) => path && !path.startsWith(folder)))
    return kept(`it changes files outside ${folder}`);
  const receipt = `refs/deploy/design-reviews/${sha1(itemId)}`;
  if ((await gitRead(repo, ['update-ref', receipt, tip])) === null)
    return kept('its commit could not be kept');
  // Only the commit that was approved: a branch moved meanwhile is left alone.
  if ((await gitRead(repo, ['update-ref', '-d', `refs/heads/${name}`, tip])) === null)
    return kept('it moved meanwhile');
  return { name, removed: true };
}

/** Persisted jobs are scanned on boot and each second; no in-memory timer owns a decision. */
export async function landDesignApprovals(clock = Date.now()) {
  const jobs = db
    .prepare("SELECT owner,data FROM records WHERE kind='design-review-landing'")
    .all() as { owner: string; data: string }[];
  for (const saved of jobs) {
    const job = JSON.parse(saved.data);
    if (job.state !== 'pending' || Date.parse(job.at) > clock) continue;
    // One job's failure never holds up the jobs behind it; a failed read is retried next scan.
    try {
      await landDesignApproval(saved.owner, job);
    } catch (error) {
      console.error(`Design approval ${job.id} will retry:`, error);
    }
  }
}

async function landDesignApproval(owner: string, job: any) {
  let row: any;
  let project: any;
  try {
    row = get('v2-inbox-native', owner, job.id);
    project = requireRepository(owner, row.context.projectId);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    // The proposal or its project is gone: there is nothing left to land it in.
    save('design-review-landing', owner, {
      ...job,
      state: 'failed',
      reason: 'The project or the proposal no longer exists',
    });
    return;
  }
  await withRepositoryWrites(project.repositoryPath, async () => {
    const current = get('design-review-landing', owner, job.id);
    if (current.state !== 'pending') return;
    try {
      // Recover the tiny crash window after update-ref but before the database transaction.
      const landed = await gitRead(project.repositoryPath, [
        'log',
        `refs/heads/${row.context.main}`,
        '--fixed-strings',
        '--grep',
        `Design-Review: ${job.id}`,
        '--format=%H',
        '-1',
      ]);
      const prepared = landed
        ? { commit: landed, conflicts: [] }
        : await prepareDecision(
            owner,
            project.repositoryPath,
            row.item,
            { actionId: 'approve', landingId: job.id },
            row.context,
          );
      db.transaction(() => {
        decideDesign(owner, row.item, { actionId: 'approve' }, row.context, prepared);
        save('design-review-landing', owner, {
          ...current,
          state: 'landed',
          commit: prepared.commit,
        });
        event(owner, project.id, null, 'v2.inbox', { item: row.item });
      }).immediate();
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
      restoreDesignWaiting(owner, row, { ...current, state: 'conflict' });
      return;
    }
    await removeLandedBranch(owner, project.repositoryPath, job.id);
  });
}
function restoreDesignWaiting(owner: string, row: any, landing?: any) {
  return db
    .transaction(() => {
      const item = { ...row.item, state: 'waiting' as const, answer: undefined };
      save('v2-inbox-native', owner, { ...row, item });
      remove('v2-inbox-answer', owner, row.id);
      if (landing) save('design-review-landing', owner, landing);
      else remove('design-review-landing', owner, row.id);
      event(owner, row.context.projectId, null, 'v2.inbox', { item });
      return item;
    })
    .immediate();
}
export function startDesignApprovals() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await landDesignApprovals();
    } catch (error) {
      console.error('Design approval will retry:', error);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), 1000);
  timer.unref();
  return () => clearInterval(timer);
}

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
  const folder = designFolder();
  return list('design-comment', owner)
    .filter(
      (row: any) =>
        row.projectId === projectId &&
        (row.folder ?? appDesignFolder) === folder &&
        !row.deletedAt &&
        (!board || row.board === board),
    )
    .map(presentComment);
}

// Renders are keyed by commit, so a cached one never goes stale.
type BoardRender = {
  png: Buffer;
  boxes: Record<string, DesignRect>;
  textBoxes?: DesignRect[];
  words?: Record<string, string>;
};
const renders = new Map<string, BoardRender>();
const renderers = new Map<string, typeof drawBoard>();
const rendering = new Map<string, Promise<BoardRender>>();
const renderLimit = 64;
// Renders also stay on disk, so a restart doesn't make a review draw every screen again. The
// 1× drawings reviews compare are kept for every board of a large design, before and after,
// at each width; the 2× and 3× previews, which are bigger and drawn again on demand, fewer.
const renderFiles = { 1: 4000, other: 1200 };
let rendersWritten = 0;
const renderPath = (key: string, scale: number) =>
  join(
    deployDataPath('design-renders'),
    `${createHash('sha256').update(key).digest('hex')}${scale === 1 ? '' : `@${scale}x`}`,
  );
async function readRender(key: string, scale: number): Promise<BoardRender | null> {
  try {
    const path = renderPath(key, scale);
    const rendered = {
      png: await readDiskFile(`${path}.png`),
      ...JSON.parse(await readDiskFile(`${path}.json`, 'utf8')),
    };
    // Used drawings are the last to go.
    const used = new Date();
    await utimes(`${path}.png`, used, used).catch(() => {});
    return rendered;
  } catch {
    return null;
  }
}
function writeRender(key: string, scale: number, rendered: BoardRender) {
  try {
    const path = renderPath(key, scale);
    mkdirSync(deployDataPath('design-renders'), { recursive: true });
    writeFileSync(`${path}.png`, rendered.png);
    writeFileSync(
      `${path}.json`,
      JSON.stringify({
        boxes: rendered.boxes,
        textBoxes: rendered.textBoxes,
        words: rendered.words,
      }),
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
  for (const [dense, limit] of [
    [false, renderFiles[1]],
    [true, renderFiles.other],
  ] as const)
    for (const { name } of files
      .filter((file) => file.name.includes('x.png') === dense)
      .slice(limit)) {
      rmSync(join(directory, name), { force: true });
      rmSync(join(directory, name.replace(/\.png$/, '.json')), { force: true });
    }
}

// One Chromium draws every board, a few at a time, and closes after a minute without work.
// Three at a time was fixed; with more cores more at once is faster (60 boards on 18 cores:
// 11.2 s three at a time, 9.1 s six), so it grows with the cores, never below three.
const drawLimit = Math.max(3, Math.min(6, Math.floor(availableParallelism() / 3)));
let drawing = 0;
/**
 * One line for every drawing, in this order: a screen someone asked for right now (a preview),
 * then the rest of a review someone has open, then a new proposal's screens drawn ahead of time
 * at 1×, then its 2× and 3× previews. Equal drawings go first come, first served. Drawings
 * nobody needs any more (a withdrawn or superseded proposal's warm-up) leave the line.
 */
const drawingPriority = { asked: 0, review: 1, warm: 2, warmDensities: 3 } as const;
type DrawingLane = {
  readonly priority: number;
  readonly cancelled: boolean;
  /** Someone is waiting for it at this priority now. */
  promote(priority: number): void;
};
/** One drawing: getting ready (reading its board), waiting for Chromium, or drawing. */
type DrawingTicket = ReturnType<typeof childLane> & { phase: 'preparing' | 'queued' | 'running' };
const drawingLane = new AsyncLocalStorage<DrawingLane>();
/** A lane of its own; with a parent it is as urgent as its parent, unless promoted past it. */
function childLane(
  parent: DrawingLane | undefined,
  priority?: number,
): DrawingLane & {
  cancel(): void;
} {
  let promoted: number | undefined;
  let cancelled = false;
  return {
    get priority() {
      return Math.min(promoted ?? Infinity, priority ?? parent?.priority ?? drawingPriority.asked);
    },
    get cancelled() {
      return promoted === undefined && (cancelled || Boolean(parent?.cancelled));
    },
    promote(to: number) {
      const before = promoted;
      promoted = Math.min(promoted ?? Infinity, to);
      if (promoted !== before) drawingsChanged();
    },
    cancel() {
      cancelled = true;
    },
  };
}
const askingPriority = () => drawingLane.getStore()?.priority ?? drawingPriority.asked;
class DrawingCancelled extends Error {
  constructor() {
    super('Nobody needs this drawing any more');
  }
}
const drawingTickets = new Map<string, DrawingTicket>();
/** Every drawing someone wants that has not finished, whatever it is doing. */
const liveDrawings = new Set<DrawingTicket>();
const buildingLanes = new Map<string, DrawingLane>();
const drawQueue: {
  start: () => void;
  stop: (error: Error) => void;
  lane: DrawingLane | undefined;
}[] = [];
/**
 * Start what may start. A drawing reads its board from Git before it can wait for Chromium, so
 * a free slot is kept for a more urgent drawing that is still getting ready rather than given to
 * a less urgent one already waiting: otherwise the other side of a screen someone asked for
 * waits behind a drawing nobody asked for.
 */
function nextDrawing() {
  for (let at = drawQueue.length - 1; at >= 0; at--)
    if (drawQueue[at].lane?.cancelled) drawQueue.splice(at, 1)[0].stop(new DrawingCancelled());
  let readying = Infinity;
  for (const ticket of liveDrawings)
    if (ticket.phase === 'preparing' && !ticket.cancelled)
      readying = Math.min(readying, ticket.priority);
  while (drawing < drawLimit && drawQueue.length) {
    let best = 0;
    for (let at = 1; at < drawQueue.length; at++)
      if ((drawQueue[at].lane?.priority ?? 0) < (drawQueue[best].lane?.priority ?? 0)) best = at;
    if ((drawQueue[best].lane?.priority ?? 0) > readying) break;
    const [next] = drawQueue.splice(best, 1);
    drawing++;
    if (next.lane) (next.lane as DrawingTicket).phase = 'running';
    next.start();
  }
  drawingEvents.emit('change');
}
/** Changes to what is waiting, for nextDrawing and for tests that follow the queue. */
const drawingEvents = new EventEmitter();
drawingEvents.setMaxListeners(0);
function drawingsChanged() {
  nextDrawing();
}
/** What the queue holds, for tests: the drawing slots in use and each drawing not yet done. */
export function drawingQueueState() {
  return {
    running: drawing,
    queued: drawQueue.length,
    drawings: [...liveDrawings].map((ticket) => ({
      priority: ticket.priority,
      phase: ticket.phase,
      cancelled: ticket.cancelled,
    })),
  };
}
export const drawingQueueEvents = drawingEvents;
/**
 * Settles when no warm-up is left, for tests: those running, those a proposal just scheduled
 * (they start on the next turn of the event loop) and any those start.
 */
export async function designWarmUps() {
  await new Promise((resolve) => setImmediate(resolve));
  while (warmRuns.size) await Promise.allSettled([...warmRuns]);
}
const warmRuns = new Set<Promise<unknown>>();
/** Warm-ups by review, so a withdrawn or superseded review's warm-up can be stopped. */
const warmLanes = new Map<string, ReturnType<typeof childLane>>();
function cancelWarmUps(prefix: string, keep: string) {
  for (const [itemId, lane] of warmLanes)
    if (itemId.startsWith(prefix) && itemId !== keep) {
      lane.cancel();
      warmLanes.delete(itemId);
    }
  drawingsChanged();
}
let chromiumLaunch: Promise<import('playwright').Browser> | null = null;
let chromiumIdle: ReturnType<typeof setTimeout> | undefined;
async function withBoardChromium<T>(
  executablePath: string,
  work: (browser: import('playwright').Browser) => Promise<T>,
): Promise<T> {
  const lane = drawingLane.getStore();
  if (lane?.cancelled) throw new DrawingCancelled();
  // Every drawing waits in line, even with a slot free: the slot may be kept for a more urgent one.
  await new Promise<void>((resolve, reject) => {
    if (lane) (lane as DrawingTicket).phase = 'queued';
    drawQueue.push({ start: resolve, stop: reject, lane });
    nextDrawing();
  });
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
    nextDrawing();
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

/** Light unless `scheme=dark` asks for the design system's dark theme. */
export type BoardScheme = 'light' | 'dark';
export function previewScheme(url: URL): BoardScheme {
  return url.searchParams.get('scheme') === 'dark' ? 'dark' : 'light';
}

export async function renderBoard(
  repo: string,
  commit: string,
  board: string,
  width: number,
  height?: number,
  scale = 1,
  scheme: BoardScheme = 'light',
) {
  return (await renderBoardLayout(repo, commit, board, width, height, scale, drawBoard, scheme))
    .png;
}

// Test/injected renderers must not inherit an in-flight Chromium warm-up (or its failure).
const rendererWork = new WeakMap<typeof drawBoard, Map<string, Promise<BoardRender>>>();

export async function renderBoardLayout(
  repo: string,
  commit: string,
  board: string,
  width: number,
  height?: number,
  scale = 1,
  draw: typeof drawBoard = drawBoard,
  scheme: BoardScheme = 'light',
): Promise<BoardRender> {
  // A light drawing keeps the key it always had, so drawings already kept are not drawn again.
  const key =
    (await drawingKey(repo, commit, board, width, height, scale, scheme)) ||
    `${repo}:${commit}:${designFolder()}:${board}:${width}:${height ?? 'board'}:${scale}${scheme === 'dark' ? ':dark' : ''}`;
  const cached = renders.get(key);
  if (cached && (draw === drawBoard || renderers.get(key) === draw)) return cached;
  let work = rendering;
  if (draw !== drawBoard) {
    work = rendererWork.get(draw) ?? new Map();
    rendererWork.set(draw, work);
  }
  const pending = work.get(key);
  if (pending) {
    // Someone is waiting for this drawing now: it goes ahead of drawings made for later.
    drawingTickets.get(key)?.promote(askingPriority());
    return pending;
  }
  // Known before anything is read, so a second asker joins it and can move it up the line.
  const ticket: DrawingTicket = Object.assign(childLane(drawingLane.getStore()), {
    phase: 'preparing' as const,
  });
  const job = (async () => {
    const stored = draw === drawBoard ? await readRender(key, scale) : null;
    if (stored) return stored;
    const rendered = await drawingLane.run(ticket, () =>
      draw(repo, commit, board, width, height, scale, scheme),
    );
    if (draw === drawBoard) writeRender(key, scale, rendered);
    return rendered;
  })();
  work.set(key, job);
  drawingTickets.set(key, ticket);
  liveDrawings.add(ticket);
  drawingsChanged();
  try {
    const rendered = await job;
    renders.set(key, rendered);
    renderers.set(key, draw);
    if (renders.size > renderLimit) renders.delete(renders.keys().next().value!);
    return rendered;
  } finally {
    work.delete(key);
    if (drawingTickets.get(key) === ticket) drawingTickets.delete(key);
    liveDrawings.delete(ticket);
    // A slot kept for it is free again.
    drawingsChanged();
  }
}

/**
 * What a drawing shows depends only on the board's file, the design system's stylesheets and
 * the size, so a repository's drawings are kept by those, not by commit: a board main and a
 * proposal share, or that a later round left alone, is drawn once. Null when the commit has no
 * such board on its canvas; drawBoard then says why.
 */
async function drawingKey(
  repo: string,
  commit: string,
  board: string,
  width: number,
  height: number | undefined,
  scale: number,
  scheme: BoardScheme = 'light',
) {
  const [canvas, tree] = await Promise.all([drawingCanvas(repo, commit), designTree(repo, commit)]);
  const placed = canvas?.boards?.[board];
  const blob = tree.get(`${designFolder()}/boards/${board}`);
  if (!placed || !blob) return null;
  const styles = [...tree]
    .filter(([path]) => path.startsWith('design/ds/') && path.endsWith('.css'))
    .map(([path, sha]) => `${path}=${sha}`)
    .sort();
  // A board may show pictures of the running app, which change without the board changing.
  const captures = [...tree]
    .filter(([path]) => path.startsWith(`${designFolder()}/boards/captures/`))
    .map(([path, sha]) => `${path}=${sha}`)
    .sort();
  // Instances draw from the library, so a board is drawn again when it changes.
  const library = tree.get(libraryPath);
  return `drawing:${createHash('sha256')
    .update(
      JSON.stringify([
        repo,
        blob,
        styles,
        width,
        height ?? placed.h,
        scale,
        ...(library ? [library] : []),
        ...(captures.length ? [captures] : []),
        ...(scheme === 'dark' ? ['dark'] : []),
      ]),
    )
    .digest('hex')}`;
}
/** The canvas at a commit, read once for every drawing made at it. */
const drawingCanvases = new Map<string, Promise<Canvas | null>>();
function drawingCanvas(repo: string, commit: string) {
  const key = `${repo}:${commit}:${designFolder()}`;
  let canvas = drawingCanvases.get(key);
  if (!canvas) {
    canvas = canvasAt(repo, commit);
    drawingCanvases.set(key, canvas);
    if (drawingCanvases.size > 64) drawingCanvases.delete(drawingCanvases.keys().next().value!);
    canvas
      .then((value) => value || drawingCanvases.delete(key))
      .catch(() => drawingCanvases.delete(key));
  }
  return canvas;
}
/** design/ at a commit, path to blob. A commit never changes, so it is listed once. */
const designTrees = new Map<string, Promise<Map<string, string>>>();
function designTree(repo: string, commit: string) {
  const key = `${repo}:${commit}:${designFolder()}`;
  let tree = designTrees.get(key);
  if (!tree) {
    tree = reviewTree(repo, commit);
    designTrees.set(key, tree);
    if (designTrees.size > 64) designTrees.delete(designTrees.keys().next().value!);
    // An empty listing may be a Git failure; only a real one is kept.
    tree
      .then((entries) => entries.size || designTrees.delete(key))
      .catch(() => designTrees.delete(key));
  }
  return tree;
}

/**
 * The design system's fonts, fetched from Google once and kept: every drawing has a fresh
 * context, which would otherwise fetch them again each time. The same bytes, so the same pixels.
 */
const fonts = new Map<
  string,
  Promise<{ status: number; headers: Record<string, string>; body: Buffer }>
>();
async function fontResponse(route: import('playwright').Route) {
  const url = route.request().url();
  let font = fonts.get(url);
  if (!font) {
    font = route.fetch().then(async (response) => {
      if (!response.ok()) throw new Error(`${url} answered ${response.status()}`);
      return {
        status: response.status(),
        headers: response.headers(),
        body: await response.body(),
      };
    });
    fonts.set(url, font);
    if (fonts.size > 64) fonts.delete(fonts.keys().next().value!);
    font.catch(() => fonts.delete(url));
  }
  try {
    await route.fulfill(await font);
  } catch {
    // Offline or refused: the board draws in its fallback font, as it always did.
    await route.abort().catch(() => {});
  }
}

/**
 * A board as it is drawn: its instances by the commit's library, with the design system and its
 * pictures inlined so the page needs nothing from this server.
 */
async function boardPage(repo: string, commit: string, html: string) {
  let page = await boardAsShown(repo, commit, html);
  for (const match of page.matchAll(/<link rel="stylesheet" href="\.\.\/(ds\/[^"]+\.css)">/g)) {
    const css = await designSystemFile(repo, commit, match[1]);
    page = page.replace(match[0], `<style>${css?.toString() ?? ''}</style>`);
  }
  return inlineCaptures(repo, commit, page);
}

/** The Chromium this computer draws boards with. */
async function drawingChromium() {
  const { chromium } = await import('playwright');
  const executablePath = boardBrowser(chromium.executablePath());
  if (!executablePath)
    fail('Rendering boards needs Chromium on the coordinator: run pnpm audit:visual:install', 503);
  return executablePath!;
}

/**
 * `deploy design check`'s drawings: a board at a commit as review draws it (light, or dark as the
 * design system and the page's own colour scheme both see it), measured at 700 for what leaves
 * the page; and Before beside After as one picture.
 */
export function checkDrawing(repo: string): CheckDrawing {
  return {
    shoot: async ({ commit, file, width, height, scheme, measure }) => {
      const html = await readFile(repo, commit, `${designFolder()}/boards/${file}`);
      if (!html) return null;
      const page = await boardPage(repo, commit, html.toString());
      return withBoardChromium(await drawingChromium(), async (browser) => {
        const context = await browser.newContext({
          viewport: { width, height },
          colorScheme: scheme,
          javaScriptEnabled: false,
        });
        try {
          await context.route('**/*', (route) =>
            /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(route.request().url())
              ? fontResponse(route)
              : route.abort(),
          );
          const tab = await context.newPage();
          await tab.setContent(page, { waitUntil: 'load', timeout: 15000 });
          if (scheme === 'dark')
            await tab.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
          await tab.evaluate(() => document.fonts.ready);
          const measured = measure ? await tab.evaluate(measureOverflow) : null;
          return { png: await tab.screenshot(), measured };
        } finally {
          await context.close();
        }
      });
    },
    pair: async ({ before, after, width, height, scheme }) =>
      withBoardChromium(await drawingChromium(), async (browser) => {
        const context = await browser.newContext({
          viewport: { width: width * 2 + 48, height: height + 64 },
          javaScriptEnabled: false,
        });
        try {
          const tab = await context.newPage();
          const image = (png: Buffer | null) =>
            png
              ? `<img src="data:image/png;base64,${png.toString('base64')}">`
              : '<p>New board · no Before</p>';
          await tab.setContent(
            `<style>body{margin:0;display:flex;gap:16px;padding:16px;font:13px system-ui;background:${scheme === 'dark' ? '#18181b' : '#f4f4f5'};color:${scheme === 'dark' ? '#fafafa' : '#18181b'}}figure{margin:0}figcaption{margin-bottom:8px}img{display:block;border:1px solid #888}p{width:${width}px}</style>` +
              `<figure><figcaption>Before · main · ${width} · ${scheme}</figcaption>${image(before)}</figure>` +
              `<figure><figcaption>After · this branch · ${width} · ${scheme}</figcaption>${image(after)}</figure>`,
            { waitUntil: 'load', timeout: 15000 },
          );
          return await tab.screenshot({ fullPage: true });
        } finally {
          await context.close();
        }
      }),
  };
}

/** A terminal's working copy of design/, pushed for one check and removed after it. */
export const checkRefPattern = /^refs\/design-check\/[A-Za-z0-9._-]{1,80}$/;

async function drawBoard(
  repo: string,
  commit: string,
  board: string,
  width: number,
  height?: number,
  scale = 1,
  scheme: BoardScheme = 'light',
): Promise<BoardRender> {
  const canvas = await readCanvas(repo, commit);
  const placed = canvas?.boards[board];
  if (!placed) fail(`${board} is not on the canvas at this commit`, 404);
  const html = await readFile(repo, commit, `${designFolder()}/boards/${board}`);
  if (!html) fail(`${designFolder()}/boards/${board} is missing at this commit`, 404);
  const page = await boardPage(repo, commit, html.toString());
  const executablePath = await drawingChromium();
  return withBoardChromium(executablePath, async (browser) => {
    const context = await browser.newContext({
      viewport: { width, height: height ?? placed.h },
      deviceScaleFactor: scale,
      javaScriptEnabled: false,
    });
    try {
      await context.route('**/*', (route) =>
        /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(route.request().url())
          ? fontResponse(route)
          : route.abort(),
      );
      const tab = await context.newPage();
      await tab.setContent(page, { waitUntil: 'load', timeout: 15000 });
      // The design system's dark theme is the root's data-theme, as the canvas's Dark sets it.
      if (scheme === 'dark')
        await tab.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await tab.evaluate(() => document.fonts.ready);
      const { boxes, textBoxes, words } = await tab.evaluate(() => {
        const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
        const textBoxes = [];
        const words: Record<string, string> = {};
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
          words[element.dataset.layer!] = (element.innerText ?? element.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          if (
            ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) ||
            Array.from(element.childNodes).some(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            )
          )
            textBoxes.push(box);
        }
        return { boxes, textBoxes, words };
      });
      const png = await tab.screenshot();
      return { png, boxes, textBoxes, words };
    } finally {
      await context.close();
    }
  });
}

/** Pictures that sit beside the boards, in boards/captures, as the commit has them. */
const captureLink = /((?:src|srcset)=")(captures\/[A-Za-z0-9_.-]+\.png)(")/g;
export const captureLimit = 16 * 1024 * 1024;

/**
 * A board drawn from its text has no address to load pictures from, so each picture in
 * boards/captures it shows (`deploy design capture` puts the running app there) goes in as data.
 */
export async function inlineCaptures(repo: string, commit: string, page: string) {
  const paths = [...new Set([...page.matchAll(captureLink)].map((match) => match[2]))];
  if (!paths.length) return page;
  const data = new Map<string, string>();
  for (const path of paths) {
    if (path.split('/').includes('..')) continue;
    const bytes = await readFile(repo, commit, `${designFolder()}/boards/${path}`, captureLimit);
    if (bytes) data.set(path, `data:image/png;base64,${bytes.toString('base64')}`);
  }
  return page.replace(captureLink, (whole, before, path, after) =>
    data.has(path) ? `${before}${data.get(path)}${after}` : whole,
  );
}

/** Progressive review payload; the screenshot and rectangles come from the same render. */
export async function reviewPreview(
  repo: string,
  projectId: string,
  board: DesignReviewScreen,
  width: number,
  render: typeof renderBoardLayout = renderBoardLayout,
  scale = 1,
  scheme: BoardScheme = 'light',
): Promise<DesignReviewPreview> {
  // Both sides are asked for at once, so both go ahead of drawings nobody is waiting for.
  const side = (revision: string) => render(repo, revision, board.file, width, board.h, scale);
  // Dark is drawn too, so its pictures are ready; where things are comes from light, which a
  // theme does not move, so pins and areas sit where they do in light.
  const dark = (revision: string) =>
    render(repo, revision, board.file, width, board.h, scale, undefined, 'dark');
  const [before, after] = await Promise.all([
    board.added ? null : side(board.before),
    board.removed ? null : side(board.after),
    ...(scheme === 'dark'
      ? [board.added ? null : dark(board.before), board.removed ? null : dark(board.after)]
      : []),
  ]);
  const areas = reviewAreas(board.changes, before?.boxes ?? {}, after?.boxes ?? {}, width, board.h);
  const url = (revision: string) =>
    `${designApiPath(projectId)}/render?ref=${revision}&board=${encodeURIComponent(board.file)}&width=${width}&height=${board.h}&scale=${scale}${scheme === 'dark' ? '&scheme=dark' : ''}`;
  return {
    width,
    height: board.h,
    before: before ? url(board.before) : null,
    after: after ? url(board.after) : null,
    areas,
    layers: { before: before?.boxes ?? {}, after: after?.boxes ?? {} },
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
function warmReview(owner: string, project: any, repo: string, itemId: string) {
  const lane = childLane(undefined, drawingPriority.warm);
  warmLanes.set(itemId, lane);
  const run = drawingLane
    .run(lane, () => warmDrawings(owner, project, repo, itemId, lane))
    .finally(() => {
      if (warmLanes.get(itemId) === lane) warmLanes.delete(itemId);
      warmRuns.delete(run);
    });
  warmRuns.add(run);
  return run;
}
async function warmDrawings(
  owner: string,
  project: any,
  repo: string,
  itemId: string,
  lane: DrawingLane,
) {
  try {
    const row = reviewRow(owner, project.id, itemId);
    await inDesignFolder(row.context.folder, () => warmBoards(owner, project, repo, row, lane));
  } catch {
    // Warming is only a head start; the review draws whatever is missing when it opens.
  }
}
async function warmBoards(owner: string, project: any, repo: string, row: any, lane: DrawingLane) {
  {
    const { boards } = await designReview(owner, project, row);
    // Then 2× and 3×, only when nothing more urgent is waiting.
    await drawingLane.run(childLane(lane, drawingPriority.warmDensities), async () => {
      for (const board of boards)
        for (const scale of [2, 3]) {
          if (lane.cancelled) return;
          await reviewPreview(repo, project.id, board, board.widths[0], renderBoardLayout, scale);
        }
    });
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
  /** Where the design lives; design/ when left out. */
  folder?: string;
  board: string;
  layer: string | null;
  text: string;
  ref: string;
  commit: string;
  snippet: string | null;
  openComments: string[];
}) {
  const dir = input.folder ?? appDesignFolder;
  const where = !input.board
    ? `the design in \`${dir}/\`, which has no boards yet`
    : input.layer
      ? `the layer \`${input.layer}\` on the board \`${dir}/boards/${input.board}\``
      : `the board \`${dir}/boards/${input.board}\``;
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
    `- Change only files in ${dir}/. Keep every existing data-layer ID, and give new elements unique ones (\`node scripts/design-layers.mjs\` names them, if this project has it).`,
    ...(dir === appDesignFolder
      ? []
      : [
          `- Place each new board in ${dir}/canvas.json, with its title, position and size, and keep its file in ${dir}/boards/.`,
          '- Link the design system from a board as ../ds/deploy-local/…; deploy.local serves the project’s design/ds, or its own when the project has none.',
        ]),
    '- Use the design system (the dl-* classes and the tokens) and follow design/ds/README.md when the project has one.',
    '- Look at each board you change at every width before you finish: with `node design/tools/render.mjs <Board>` if the project has it, otherwise by opening the file in a browser at that width.',
    '- Before you change a board or a layer, call deploy_design with action presence (board, layer, a short note) so the person watching sees where you work.',
    '- Commit as you go with deploy_checkpoint and deploy_commit, so the Design page shows your changes while you work. Do not build the change in the app: this task is the design only.',
    '- Read open comments with deploy_design action comments, and resolve the ones you addressed.',
    '- End by saying what you changed, board by board, and what you checked.',
  ].join('\n');
}

/** Mark a comment or a review pin addressed, with a reply: deploy_design's resolve and the CLI's. */
export function resolveDesignComment(
  owner: string,
  projectId: string,
  args: { commentId?: unknown; resolved?: unknown; reply?: unknown },
) {
  const row = get('design-comment', owner, String(args.commentId ?? ''));
  if (row.projectId !== projectId) fail('Not found', 404);
  return presentComment(
    save('design-comment', owner, {
      ...row,
      resolved: args.resolved !== false,
      resolvedAt: args.resolved === false ? null : now(),
      reply: optionalWords(args.reply, 1000) ?? row.reply ?? null,
    }),
  );
}

/** The newest proposal of a branch in a project, whatever its state. */
function branchReviewRow(owner: string, projectId: string, branch: string) {
  return list('v2-inbox-native', owner)
    .filter(
      (row) =>
        row.context?.source === 'design' &&
        row.context.projectId === projectId &&
        row.context.branch === branch,
    )
    .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt))[0];
}

/**
 * The owner's latest answer on a branch's proposal, for `deploy design feedback`: still waiting,
 * asked for changes (the note and every open pin, numbered as the review numbers them), or approved
 * and where it landed.
 */
export async function readBranchFeedback(owner: string, project: any, branch: string) {
  if (!validRef(branch)) fail('Name a branch');
  const row = branchReviewRow(owner, project.id, branch);
  // The project's own name, for a terminal that named it by ID or by its origin.
  const named = { branch, owner, project: String(project.name ?? project.id) };
  if (!row) return { ...named, review: null };
  return inDesignFolder(row.context.folder, async () => {
    const { context, item } = row;
    const repo = project.repositoryPath as string;
    const saved = list('design-review-feedback', owner).find((entry) => entry.id === row.id);
    const asked = ['changes', 'update'].includes(item.answer?.actionId);
    const html = new Map<string, string | null>();
    const pins = [];
    for (const pin of asked ? reviewPins(owner, context).filter((entry) => !entry.resolved) : []) {
      const path = `${designFolder()}/boards/${pin.board}`;
      if (!html.has(path)) html.set(path, await showFile(repo, context.commit, path));
      const board = html.get(path);
      pins.push({
        id: pin.id,
        number: pin.number,
        board: pin.board,
        boardTitle: screenName(pin.board),
        layer: pin.layer ?? null,
        layerName: pin.layer
          ? layerLabel(
              pin.layer,
              ((board && layerSnippet(board, pin.layer)) ?? '').replace(/<[^>]+>/g, ' '),
            )
          : null,
        text: pin.text,
      });
    }
    const landing = reviewLanding(owner, row.id);
    return {
      ...named,
      review: {
        id: row.id,
        title: item.title,
        round: context.round ?? 1,
        boards: reviewBoardPaths(context).length,
        lookAt: context.lookAt ?? [],
        state: item.state,
        proposedAt: item.createdAt,
        answer: item.answer
          ? { actionId: item.answer.actionId, at: item.answer.at, by: item.answer.by ?? owner }
          : null,
        note: asked ? (saved?.note ?? null) : null,
        pins,
        feedback: reviewFeedback(owner, row),
        landing: landing
          ? {
              state: landing.state,
              at: landing.at,
              commit: landing.commit ?? null,
              branch: landing.branch ?? null,
            }
          : null,
      },
    };
  });
}

/** A terminal waiting on a branch's answer says so every few seconds; the review reads it when answered. */
export function markTerminalWaiting(owner: string, projectId: string, body: any) {
  const branch = String(body?.branch ?? '');
  if (!validRef(branch)) fail('Name a branch');
  const computer = optionalWords(body?.computer, 120) ?? 'a computer';
  return save('design-feedback-wait', owner, {
    id: branchRecordId(projectId, branch),
    projectId,
    branch,
    computer,
    at: now(),
  });
}

/** Who started a design branch from a terminal, on which computer and when, kept with the project. */
export function recordDesignStart(owner: string, projectId: string, body: any) {
  const branch = String(body?.branch ?? '');
  if (!validRef(branch) || !/^(design|artifact)\//.test(branch))
    fail('Name a design branch, like design/title-size');
  return save('design-branch-start', owner, {
    id: branchRecordId(projectId, branch),
    projectId,
    branch,
    by: owner,
    computer: optionalWords(body?.computer, 120) ?? 'a computer',
    folder: optionalWords(body?.folder, 400),
    at: now(),
  });
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
export function designTool(scope: { owner: string; taskId: string; runId?: string }, args: any) {
  const task = get('task', scope.owner, scope.taskId);
  return inDesignFolder(task.design?.folder, () => runDesignTool(scope, args));
}
async function runDesignTool(scope: { owner: string; taskId: string; runId?: string }, args: any) {
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
        folder: designFolder(),
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
    case 'resolve':
      return { comment: resolveDesignComment(scope.owner, project.id, args) };
    case 'built': {
      const row = approvedTaskDesign(scope.owner, task.id);
      if (row) {
        await ensureDesignCheckBoards(scope.owner, project, row);
        if (args.state === 'matches' && task.needs?.tools.length) {
          const run = scope.runId
            ? get('run', scope.owner, scope.runId)
            : list('run', scope.owner)
                .filter((candidate) => candidate.taskId === task.id)
                .at(-1);
          const workerId = run?.workerId ?? task.workerId ?? 'local';
          if (!hasTools(scope.owner, workerId, task.needs.tools))
            fail(
              'This computer has not confirmed all the programs this task needs. Report differs or compare on a computer that has confirmed them.',
              409,
            );
        }
      }
      return reportDesignBuild(scope.owner, task.id, args);
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
    case 'list':
      return listDesigns(project, task);
    case 'use':
      return useDesign(scope.owner, project, task, args.artifact);
    default:
      fail('action must be list, use, presence, comments, comment, resolve, propose or built');
  }
}

/** The commit main points at, or a failure for a repository with no commits yet. */
async function mainHead(repo: string) {
  const main = await mainBranch(repo);
  const head = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${main}^{commit}`,
  ]);
  if (!head) fail(`${main} has no commits yet`, 409);
  return { main, head: head! };
}

/** The project's designs and documents on main, and the one this task works on. */
async function listDesigns(project: any, task: any) {
  const repo = project.repositoryPath as string;
  const { main, head } = await mainHead(repo);
  const files = (
    (await gitRead(repo, [
      'ls-tree',
      '-r',
      '--name-only',
      head,
      '--',
      appDesignFolder,
      'artifacts',
    ])) ?? ''
  )
    .split('\n')
    .filter(Boolean);
  const boards = (folder: string) =>
    files.filter((path) => path.startsWith(`${folder}/boards/`) && path.endsWith('.html')).length;
  const designs: { name: string; folder: string; kind: 'design' | 'document'; boards?: number }[] =
    [];
  if (files.includes(`${appDesignFolder}/canvas.json`))
    designs.push({
      name: 'App design',
      folder: appDesignFolder,
      kind: 'design',
      boards: boards(appDesignFolder),
    });
  for (const path of files) {
    const match = path.match(
      /^artifacts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(canvas\.json|document\.md)$/,
    );
    if (!match) continue;
    const folder = `artifacts/${match[1]}`;
    designs.push(
      match[2] === 'canvas.json'
        ? { name: match[1], folder, kind: 'design', boards: boards(folder) }
        : { name: match[1], folder, kind: 'document' },
    );
  }
  return {
    main,
    designs,
    using: task.design ? (task.design.folder ?? appDesignFolder) : null,
  };
}

/**
 * Point this task at a design: the App design (design/) or a named one (artifacts/<name>/).
 * Proposals from the task then go to that design's review. A design that is not on main yet
 * starts from an empty canvas the agent writes into its workspace.
 */
async function useDesign(owner: string, project: any, task: any, artifact: unknown) {
  const name = artifact == null || artifact === '' ? null : String(artifact);
  if (name !== null && !artifactNamePattern.test(name))
    fail('artifact must be a name like drop-redesign: lowercase letters, numbers and dashes');
  const folder = name ? `artifacts/${name}` : appDesignFolder;
  const repo = project.repositoryPath as string;
  const { main, head } = await mainHead(repo);
  const on = (path: string) => gitRead(repo, ['ls-tree', '--name-only', head, '--', path]);
  if (name && (await on(`${folder}/document.md`)))
    fail(`${folder} is a document; deploy_design works on designs`, 409);
  const exists = Boolean(await on(`${folder}/canvas.json`));
  const { folder: _previous, ...design } = task.design ?? {};
  save('task', owner, {
    ...get('task', owner, task.id),
    design: {
      ...design,
      board: '',
      layer: null,
      ref: main,
      commit: head,
      askedAt: now(),
      ...(name ? { folder } : {}),
    },
  });
  const title = name ?? String(project.name ?? 'App design');
  return {
    folder,
    exists,
    ...(exists
      ? {}
      : {
          starter: [
            {
              path: `${folder}/canvas.json`,
              content: `${JSON.stringify({ title, boards: {}, order: [], notes: {} }, null, 2)}\n`,
            },
          ],
          boardTemplate: blankBoard('Board title', 1440, 900),
        }),
    guide: designGuide(folder),
  };
}

/** How a design is laid out, for an agent in a project that may have no design yet. */
export function designGuide(folder: string) {
  return [
    `Work only in ${folder}/.`,
    `${folder}/canvas.json: { "title", "boards": { "<Name>.html": { "x", "y", "w", "h", "title" } }, "order": ["<Name>.html"], "notes": { "<id>": { "x", "y", "text" } } }. Place boards apart on the canvas; web boards are usually 1440 wide (check them at 700 too) and phone boards 390.`,
    `${folder}/boards/<Name>.html: one standalone page per board, with <meta name="design-board" content="width=W,height=H">. Give every element a person might point at a data-layer ID unique in its board, and keep those IDs when you change an element.`,
    'Boards render with JavaScript off and load nothing but Google Fonts: no scripts, no remote images (inline small SVG instead).',
    "Style: link ../ds/deploy-local/tokens.css and ../ds/deploy-local/components/bundle.css for deploy.local's tokens and dl-* classes (the project's design/ds if it has one, otherwise deploy.local's), or style the board in its own <style>.",
    'deploy.local draws the boards for review itself. To look at one, open the file in a browser at its width. node design/tools/render.mjs exists only if this project has it.',
    'Call presence before you change a board, commit as you go with deploy_checkpoint and deploy_commit, then propose. Change no app code until the owner approves the design and asks you to build it.',
  ].join('\n');
}

export async function designApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  const makeRoute = routes<undefined>();
  if (
    await dispatch([
      makeRoute({
        method: 'GET',
        path: '/api/design/reviews',
        handler: async () => sendJson(res, await readDesignReviews(owner, url)),
      }),
      makeRoute({
        method: 'GET',
        path: '/api/design/projects',
        handler: async () => sendJson(res, await readDesignProjects(owner)),
      }),
    ])(req, res, undefined)
  )
    return true;
  const route = url.pathname.match(
    /^\/api\/projects\/([^/]+)(?:\/artifacts\/([^/]+))?\/design(\/.*)?$/,
  );
  if (!route) return false;
  // A terminal names the project the way its origin does: by ID, or by repository name.
  const project = findRepository(owner, decodeURIComponent(route[1]));
  const artifact = route[2] ? decodeURIComponent(route[2]) : null;
  if (artifact !== null && !artifactNamePattern.test(artifact)) fail('Not found', 404);
  return inDesignFolder(artifact ? `artifacts/${artifact}` : appDesignFolder, () =>
    projectDesignApi(req, res, owner, url, project, route[3] ?? ''),
  );
}

async function projectDesignApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  url: URL,
  project: any,
  sub: string,
): Promise<boolean> {
  const makeRoute = routes<undefined>();
  const repo = project.repositoryPath as string;
  const dir = designFolder();
  // Keep the original file character constraints, including the 404/405 distinction.
  // Commit-bound paths also keep relative board and design-system links on that commit.
  const file = sub.match(/^\/files\/([0-9a-f]+)\/((?:boards|ds)\/[A-Za-z0-9_./-]+)$/);
  const comment = sub.match(/^\/comments\/([A-Za-z0-9-]+)$/);

  return dispatch(
    [
      makeRoute({
        method: 'GET',
        path: '',
        handler: async () => {
          const { ref, commit } = await resolveCommit(owner, project.id, repo, url, true);
          const canvas = await readCanvas(repo, commit, true);
          const open = comments(owner, project.id).filter((comment) => !comment.resolved);
          return sendJson(res, {
            ref,
            commit,
            canvas,
            // An artifact made on its branch that main does not have yet.
            fresh:
              folderArtifact(dir) &&
              Boolean(
                await madeOnBranch(
                  repo,
                  (await repositoryRefs.read(repo)).symbolicHead || 'main',
                  dir,
                ),
              ),
            branches: await presentedDesignBranches(repo),
            openComments: open.length,
          });
        },
      }),
      makeRoute({
        method: ['GET', 'HEAD'],
        path: '/files/:commit([0-9a-f]+)/:kind(boards|ds)/:file*',
        handler: async () => {
          if (!file) return false;
          const [, commit, path] = file;
          if (!commitPattern.test(commit) || path.split('/').includes('..')) fail('Not found', 404);
          const type = fileTypes[path.split('.').pop()!];
          if (!type) fail('Not found', 404);
          // Boards are the design's own; the design system is the project's, in design/ds.
          // Pictures of the running app, in boards/captures, may be larger than a board.
          let bytes = path.startsWith('ds/')
            ? await designSystemFile(repo, commit, path, true)
            : await readFile(
                repo,
                commit,
                `${dir}/${path}`,
                path.startsWith('boards/captures/') ? captureLimit : 2 * 1024 * 1024,
                true,
              );
          if (!bytes) fail('Not found', 404);
          // A board shows its instances as its commit's library draws them.
          if (path.startsWith('boards/') && path.endsWith('.html')) {
            const html = bytes!.toString();
            const shown = await boardAsShown(repo, commit, html);
            if (shown !== html) bytes = Buffer.from(shown);
          }
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': bytes.length,
            'Content-Security-Policy': boardPolicy,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=31536000, immutable',
          });
          res.end(req.method === 'HEAD' ? undefined : bytes);
          return true;
        },
      }),
      makeRoute({
        method: '*',
        path: '/files/:commit([0-9a-f]+)/:kind(boards|ds)/:file*',
        handler: async () => {
          if (!file) return false;
          fail('Method not allowed', 405);
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/branches',
        handler: async () => {
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
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/comments',
        handler: async () => {
          return sendJson(
            res,
            readDesignComments(owner, project.id, url.searchParams.get('board')),
          );
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/comments',
        handler: async () => {
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
            folder: dir,
            board,
            layer,
            text,
            commit,
            author: owner,
            resolved: false,
            createdAt: now(),
          });
          return sendJson(res, { comment: presentComment(row) }, 201);
        },
      }),
      makeRoute({
        method: '*',
        path: '/comments',
        handler: async () => {
          fail('Method not allowed', 405);
        },
      }),
      makeRoute({
        method: 'PATCH',
        path: '/comments/:id([A-Za-z0-9-]+)',
        handler: async () => {
          const row = get('design-comment', owner, comment![1]);
          if (row.projectId !== project.id || (row.folder ?? appDesignFolder) !== dir)
            fail('Not found', 404);
          const body = await readJson(req);
          if (typeof body?.resolved !== 'boolean') fail('Send resolved: true or false');
          const next = save('design-comment', owner, {
            ...row,
            resolved: body.resolved,
            resolvedAt: body.resolved ? now() : null,
          });
          return sendJson(res, { comment: presentComment(next) });
        },
      }),
      makeRoute({
        method: '*',
        path: '/comments/:id([A-Za-z0-9-]+)',
        handler: async () => {
          fail('Method not allowed', 405);
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/links',
        handler: async () => {
          const { commit } = await resolveCommit(owner, project.id, repo, url);
          const key = `${repo}:${commit}:${dir}`;
          let links = linkCache.get(key);
          if (!links) {
            const canvas = await readCanvas(repo, commit);
            const files = Object.keys(canvas?.boards ?? {});
            const found = await Promise.all(
              files.map(async (file) => {
                const html = await readFile(repo, commit, `${dir}/boards/${file}`);
                return html
                  ? boardLinks(html.toString()).map((link) => ({ from: file, ...link }))
                  : [];
              }),
            );
            links = found.flat();
            linkCache.set(key, links);
            if (linkCache.size > 20) linkCache.delete(linkCache.keys().next().value!);
          }
          return sendJson(res, { commit, links });
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/changes',
        handler: async () => {
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
            `${dir}/`,
          ]);
          // A new artifact's canvas.json only made it; until something is drawn there is no change.
          const made = folderArtifact()
            ? !(await gitRead(repo, ['ls-tree', '--name-only', mergeBase, `${dir}/`]))
            : false;
          const files = await Promise.all(
            (out ? out.split('\n') : [])
              .filter((line) => !(made && line === `A\t${dir}/canvas.json`))
              .map(async (line) => {
                const [code, path] = line.split('\t');
                const status = code === 'A' ? 'added' : code === 'D' ? 'removed' : 'changed';
                // A changed board also says what changed in it, layer by layer.
                if (
                  status !== 'changed' ||
                  !path.startsWith(`${dir}/boards/`) ||
                  !path.endsWith('.html')
                )
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
          // A task can work on an artifact rather than design/: name each one it changed, so its
          // Design tab can open that artifact's review.
          const artifacts = folderArtifact()
            ? []
            : changedArtifacts(
                (await gitRead(repo, [
                  'diff',
                  '--name-only',
                  '--no-renames',
                  mergeBase,
                  commit,
                  '--',
                  'artifacts/',
                ])) ?? '',
              );
          return sendJson(res, { base: mergeBase, commit, files, artifacts });
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/render',
        handler: async () => {
          const { commit } = await resolveCommit(owner, project.id, repo, url);
          const board = String(url.searchParams.get('board') ?? '');
          if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
          const width = Number(url.searchParams.get('width') ?? 1440);
          if (!Number.isInteger(width) || width < 320 || width > 2560)
            fail('Width must be 320 to 2560');
          const height = url.searchParams.has('height')
            ? Number(url.searchParams.get('height'))
            : undefined;
          if (height !== undefined && (!Number.isInteger(height) || height < 64 || height > 20000))
            fail('Height must be 64 to 20000');
          const png = await renderBoard(
            repo,
            commit,
            board,
            width,
            height,
            previewScale(url),
            previewScheme(url),
          );
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': png.length,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=31536000, immutable',
          });
          res.end(png);
          return true;
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/ask',
        handler: async () => {
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
          // A design with no boards yet is asked about as a whole, to start it.
          if (board !== '' && !boardPattern.test(board)) fail('Name a board, like Welcome.html');
          if (layer !== null && (!board || !layerPattern.test(layer))) fail('Invalid layer');
          if (!text || text.length > 8000)
            fail('Say what you want changed, in at most 8000 characters');
          const { ref, commit } = await resolveCommit(owner, project.id, repo, url);
          let snippet: string | null = null;
          if (board) {
            const html = await readFile(repo, commit, `${dir}/boards/${board}`);
            if (!html) fail(`${dir}/boards/${board} is missing at this commit`, 404);
            snippet = layer ? layerSnippet(html.toString(), layer) : null;
            if (layer && !snippet) fail(`${board} has no layer ${layer}`, 404);
          } else if (Object.keys((await readCanvas(repo, commit))?.boards ?? {}).length)
            fail('Name a board, like Welcome.html');
          const openComments = board
            ? comments(owner, project.id, board)
                .filter((row) => !row.resolved && (!layer || row.layer === layer))
                .map((row) => row.text)
            : [];
          const name = board
            ? board.replace(/\.html$/, '')
            : ((await readCanvas(repo, commit))?.title ?? folderArtifact() ?? 'design');
          const task = queueTask(owner, {
            projectId: project.id,
            title: `Design: ${name}${layer ? ` › ${layer}` : ''}`,
            ref: commit,
            workerId: body?.workerId,
            model: body?.model,
            prompt: askPrompt({
              folder: dir,
              board,
              layer,
              text,
              ref,
              commit,
              snippet,
              openComments,
            }),
          });
          save('task', owner, {
            ...get('task', owner, task.id),
            design: {
              board,
              layer,
              ref,
              commit,
              text,
              askedAt: now(),
              ...(dir === appDesignFolder ? {} : { folder: dir }),
            },
          });
          return sendJson(
            res,
            { task: { id: task.id, title: task.title, branch: currentTaskBranch(task) } },
            201,
          );
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/components',
        handler: async () => {
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
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/edit',
        handler: async () => {
          const body = await readJson(req);
          const board = String(body?.board ?? '');
          if (!boardPattern.test(board)) fail('Name a board, like Welcome.html');
          const edits = body?.edits;
          if (!Array.isArray(edits) || !edits.length || edits.length > 50)
            fail('Send 1 to 50 edits');
          const result = await withRepositoryWrites(repo, async () => {
            const { branch, head } = await editBranch(repo, body, board.replace(/\.html$/, ''));
            const html = await readFile(repo, head, `${dir}/boards/${board}`);
            if (!html) fail(`${dir}/boards/${board} is missing on ${branch}`, 404);
            const main = await gitRead(repo, [
              'rev-parse',
              '--verify',
              '--quiet',
              `refs/heads/${await mainBranch(repo)}^{commit}`,
            ]);
            const base = main ? await readFile(repo, main, `${dir}/boards/${board}`) : null;
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
              writes: [{ path: `${dir}/boards/${board}`, content: next }],
            });
            return { branch, commit, layers };
          });
          return sendJson(res, result);
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/canvas',
        handler: async () => {
          const body = await readJson(req);
          const result = await withRepositoryWrites(repo, async () => {
            const op = body?.op;
            const { branch, head } = await editBranch(
              repo,
              body,
              op === 'board' ? 'new board' : 'notes',
            );
            const canvas = await readCanvas(repo, head);
            if (!canvas) fail('This design has no canvas.json', 404);
            const { writes, made } = applyCanvasEdit(canvas!, body, dir);
            writes.push({
              path: `${dir}/canvas.json`,
              content: `${JSON.stringify(canvas, null, 2)}\n`,
            });
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
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/asks',
        handler: async () => {
          return sendJson(res, readDesignAsks(owner, project.id, dir));
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/accept',
        handler: async () => {
          const body = await readJson(req);
          const task = get('task', owner, String(body?.task ?? ''));
          if (
            task.projectId !== project.id ||
            !task.design ||
            (task.design.folder ?? appDesignFolder) !== dir
          )
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
            if (!ownsBranch(into)) {
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
                `${dir}/`,
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
              message: `Accept ${paths.length === 1 ? paths[0].slice(dir.length + 1) : `${paths.length} design changes`} from ${task.title}`,
              by: owner,
            });
            return { branch: into, commit, accepted: paths };
          });
          return sendJson(res, result);
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/propose',
        handler: async () => {
          const body = await readJson(req);
          const item = await proposeDesign(owner, project, {
            ref: body?.ref,
            task: body?.task,
            title: body?.title,
            summary: body?.summary,
            changeWords: body?.changeWords,
            lookAt: body?.lookAt,
          });
          setImmediate(() => void warmReview(owner, project, repo, item.id));
          return sendJson(res, { item }, 201);
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/check',
        handler: async () => {
          const body = await readJson(req);
          const ref = String(body?.ref ?? '');
          if (!checkRefPattern.test(ref))
            fail('Name the pushed working copy, like refs/design-check/…');
          try {
            const commit = await gitRead(repo, [
              'rev-parse',
              '--verify',
              '--quiet',
              `${ref}^{commit}`,
            ]);
            if (!commit) fail('Push the working copy first', 404);
            const main = await mainBranch(repo);
            const base = await gitRead(repo, [
              'rev-parse',
              '--verify',
              '--quiet',
              `${main}^{commit}`,
            ]);
            if (!base) fail(`This project has no ${main} yet`, 409);
            const result = await checkDesign(
              {
                commit: commit!,
                base: base!,
                baseRef: main,
                drop: Boolean(body?.drop),
                folder: dir,
              },
              { read: (args) => reviewGit(repo, args) },
              checkDrawing(repo),
            );
            return sendJson(res, result);
          } finally {
            // The working copy was only for this check.
            await gitString(repo, ['update-ref', '-d', ref]).catch(() => {});
          }
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/working',
        handler: async () =>
          sendJson(res, { working: recordDesignStart(owner, project.id, await readJson(req)) }),
      }),
      makeRoute({
        method: 'GET',
        path: '/feedback',
        handler: async () =>
          sendJson(
            res,
            await readBranchFeedback(owner, project, String(url.searchParams.get('branch') ?? '')),
          ),
      }),
      makeRoute({
        method: 'POST',
        path: '/feedback/wait',
        handler: async () => {
          const body = await readJson(req);
          markTerminalWaiting(owner, project.id, body);
          return sendJson(res, await readBranchFeedback(owner, project, String(body?.branch)));
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/feedback/resolve',
        handler: async () => {
          const body = await readJson(req);
          const row = branchReviewRow(owner, project.id, String(body?.branch ?? ''));
          if (!row) fail('Nothing on this branch was proposed', 404);
          const pin = reviewPins(owner, row.context).find(
            (entry) => entry.number === Number(body?.pin),
          );
          if (!pin) fail(`No note ${body?.pin} on this proposal`, 404);
          const reply = optionalWords(body?.reply, 1000);
          if (!reply) fail('Say what you did');
          return sendJson(res, {
            comment: resolveDesignComment(owner, project.id, { commentId: pin!.id, reply }),
          });
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/review/task',
        handler: async () => {
          const body = await readJson(req);
          return sendJson(res, startDesignFollowUp(owner, project.id, body?.item), 201);
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/presence',
        handler: async () => {
          return sendJson(res, readDesignPresence(owner, project.id));
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/review',
        handler: async () => {
          const row = reviewRow(owner, project.id, url.searchParams.get('item'));
          if ((row.context.folder ?? appDesignFolder) !== dir)
            return inDesignFolder(row.context.folder, () =>
              projectDesignApi(req, res, owner, url, project, sub),
            );
          const evidence = url.searchParams.get('evidence');
          const review = await designReview(
            owner,
            project,
            row,
            evidence === 'all',
            // The web canvas never shows `changes`; it gets each screen's areas from its preview.
            evidence !== 'text',
          );
          if (url.searchParams.get('previews') === 'all') {
            for (const board of review.boards) {
              board.previews = {};
              for (const width of board.widths)
                board.previews[width] = await reviewPreview(repo, project.id, board, width);
            }
          }
          return sendJson(res, review);
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/review/preview',
        handler: async () => {
          const row = reviewRow(owner, project.id, url.searchParams.get('item'));
          if ((row.context.folder ?? appDesignFolder) !== dir)
            return inDesignFolder(row.context.folder, () =>
              projectDesignApi(req, res, owner, url, project, sub),
            );
          const boards = await loadReviewScreens(owner, project, row);
          const board = boards.find((entry) => entry.file === url.searchParams.get('board'));
          const width = Number(url.searchParams.get('width'));
          if (!board || !board.widths.includes(width)) fail('Name a screen and one of its widths');
          const comparison =
            url.searchParams.get('comparison') === 'main'
              ? await reviewMain(repo, row.context)
              : null;
          const resolution = comparison?.resolutions.find((entry) => entry.file === board!.file);
          return sendJson(
            res,
            await reviewPreview(
              repo,
              project.id,
              comparison
                ? {
                    ...board!,
                    before: comparison.main,
                    added: resolution?.mainExists === false,
                    removed: resolution?.proposalExists === false,
                  }
                : board!,
              width,
              undefined,
              previewScale(url),
              previewScheme(url),
            ),
          );
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/review/choice',
        handler: async () => {
          const body = await readJson(req);
          await withRepositoryWrites(repo, async () => {
            const row = reviewRow(owner, project.id, body?.item);
            if (row.item.state !== 'waiting') fail('This review has already been answered', 409);
            const status = await reviewMain(repo, row.context);
            if (body.main !== status.main || body.proposal !== row.context.commit)
              fail('The design changed. Refresh the review and choose again.', 409);
            if (![null, 'main', 'proposal'].includes(body.choice))
              fail('Choose main or this proposal');
            if (
              !status.resolutions.some(
                (entry) => entry.file === body.file && entry.kind === 'same-part',
              )
            )
              fail('That screen needs no choice', 409);
            const choices = Object.fromEntries(
              Object.entries(row.context.choices ?? {}).filter(([, value]) => {
                const saved = value as { main: string; proposal: string };
                return saved.main === status.main && saved.proposal === row.context.commit;
              }),
            );
            if (body.choice === null) delete choices[body.file];
            else
              choices[body.file] = {
                choice: body.choice,
                version: id(),
                main: status.main,
                proposal: row.context.commit,
              };
            save('v2-inbox-native', owner, { ...row, context: { ...row.context, choices } });
          });
          return sendJson(res, { ok: true });
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/review/seen',
        handler: async () => {
          const body = await readJson(req);
          const row = reviewRow(owner, project.id, body?.item);
          const review = await designReview(owner, project, row, false, false);
          const files = body?.boards ?? [body?.board];
          if (
            !Array.isArray(files) ||
            !files.length ||
            files.length > review.boards.length ||
            files.some((file) => !review.boards.some((board) => board.file === file)) ||
            body?.revision !== review.after
          )
            fail('Name screens at this proposal revision', 409);
          // Ticking the screen a shared part is looked at on ticks the part, for every screen.
          const parts = review.parts?.filter((part) => files.includes(part.lookAt.file)) ?? [];
          const hashes = parts.length
            ? await sharedParts(repo, row.context.base, row.context.commit, row.context.paths)
            : noParts;
          db.transaction(() => {
            for (const file of new Set(files))
              save('design-review-seen', owner, {
                id: `${row.id}:${file}`,
                itemId: row.id,
                board: file,
                revision: review.after,
                seenAt: now(),
              });
            for (const part of parts)
              save('design-review-seen', owner, {
                id: `${row.id}:part:${part.component}`,
                itemId: row.id,
                board: `part:${part.component}`,
                revision: review.after,
                // A later round keeps it seen while the component is the same.
                hash: hashes.changed.find((entry) => entry.id === part.component)?.hash ?? null,
                seenAt: now(),
              });
          }).immediate();
          return sendJson(res, { seen: true });
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/review/build',
        handler: async () => {
          const body = await readJson(req);
          return sendJson(res, {
            build: requestDesignBuild(owner, project.id, body?.item, body?.place),
          });
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/review/undo',
        handler: async () => {
          const body = await readJson(req);
          const result = await withRepositoryWrites(repo, async () => {
            const row = reviewRow(owner, project.id, body?.item);
            const landing = list('design-review-landing', owner).find(
              (entry) => entry.id === row.id,
            );
            if (!landing || landing.state !== 'pending' || Date.parse(landing.at) <= Date.now())
              fail('This approval can no longer be undone', 409);
            return restoreDesignWaiting(owner, row);
          });
          return sendJson(res, { item: result });
        },
      }),
      makeRoute({
        method: 'POST',
        path: '/review/pins',
        handler: async () => {
          const body = await readJson(req, 1024 * 1024);
          return sendJson(res, await mutateReviewPin(owner, project, 'POST', body));
        },
      }),
      makeRoute({
        method: 'PATCH',
        path: '/review/pins',
        handler: async () => {
          const body = await readJson(req, 128 * 1024);
          return sendJson(res, await mutateReviewPin(owner, project, 'PATCH', body));
        },
      }),
      makeRoute({
        method: 'DELETE',
        path: '/review/pins',
        handler: async () => {
          const body = await readJson(req, 128 * 1024);
          return sendJson(res, await mutateReviewPin(owner, project, 'DELETE', body));
        },
      }),
      makeRoute({
        method: 'GET',
        path: '/proposals',
        handler: async () => {
          return sendJson(res, readDesignProposals(owner, project.id, dir));
        },
      }),
    ],
    { path: () => sub, notFound: () => fail('Not found', 404) },
  )(req, res, undefined);
}

export async function readDesignReviews(owner: string, url: URL) {
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
      await reviewSummary(
        owner,
        requireRepository(owner, row.context.projectId),
        row,
        undefined,
        true,
      ),
    );
  proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const approved = list('v2-inbox-native', owner)
    .filter(
      (row) =>
        row.context?.source === 'design' &&
        row.item.answer?.actionId === 'approve' &&
        (!projectId || row.context.projectId === projectId) &&
        !list('design-review-landing', owner).some(
          (landing) => landing.id === row.id && landing.state !== 'landed',
        ),
    )
    .sort((a, b) => b.item.answer.at.localeCompare(a.item.answer.at))
    .flatMap((row) => {
      const built = list('design-review-built', owner).find(
        (entry) => entry.id === row.id && entry.state !== 'waiting',
      );
      const landing = reviewLanding(owner, row.id);
      const task = list('task', owner).find((entry) => entry.id === landing?.build?.taskId);
      const project = get('project', owner, row.context.projectId);
      const building =
        task && !['done', 'completed', 'cancelled', 'archived'].includes(task.status);
      if (!built && !building) return [];
      return [
        {
          id: row.id,
          title: row.item.title,
          project: project.name ?? project.id,
          detail: built
            ? ['matches', 'kept'].includes(built.state)
              ? 'Built · matches the design'
              : `Built · ${built.differences} difference${built.differences === 1 ? '' : 's'} to look at`
            : landing?.build?.name
              ? `${project.name ?? project.id} · ${landing.build.name} is building it`
              : `${project.name ?? project.id} · being built`,
        },
      ];
    })
    .slice(0, 5);
  return { proposals, approved };
}

export async function readDesignProjects(owner: string) {
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
                await presentationCommit(
                  row.repositoryPath,
                  `refs/heads/${(await repositoryRefs.read(row.repositoryPath)).symbolicHead || 'main'}`,
                ),
                true,
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
  return { projects: designs };
}

/** Stored canvas metadata; these reads never open Git or render a board. */
export function readDesignComments(owner: string, projectId: string, board?: string | null) {
  const project = requireRepository(owner, projectId);
  return { comments: comments(owner, project.id, board) };
}
export function readDesignPresence(owner: string, projectId: string) {
  const project = requireRepository(owner, projectId);
  return {
    agents: livePresence(owner, project.id),
    // Design branches started from a terminal, newest first, with who and where.
    terminals: list('design-branch-start', owner)
      .filter((row) => row.projectId === project.id)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 20)
      .map((row) => ({ branch: row.branch, by: row.by, computer: row.computer, at: row.at })),
  };
}
export function readDesignAsks(owner: string, projectId: string, folder = appDesignFolder) {
  const project = requireRepository(owner, projectId);
  const asks = list('task', owner)
    .filter(
      (task: any) =>
        task.projectId === project.id &&
        task.design &&
        (task.design.folder ?? appDesignFolder) === folder,
    )
    .sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 20)
    .map((task: any) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      branch: currentTaskBranch(task),
      ...task.design,
    }));
  return { asks };
}
export function readDesignProposals(owner: string, projectId: string, folder = appDesignFolder) {
  const project = requireRepository(owner, projectId);
  const prefix = `design:${project.id}:`;
  // Each request also names the boards it would change, so the canvas can mark them In review.
  // The canvas polls this every 10 s and it lists every proposal ever made, so it reads no git:
  // counts and conflicts, which do, come from /api/design/reviews for what still waits.
  const contexts = new Map(
    list('v2-inbox-native', owner)
      .filter(
        (row: any) =>
          row.id.startsWith(prefix) && (row.context?.folder ?? appDesignFolder) === folder,
      )
      .map((row: any) => [row.id, row.context]),
  );
  const items = syncInbox(owner)
    .filter((item) => contexts.has(item.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((item) => ({
      ...item,
      branch: contexts.get(item.id)?.branch ?? null,
      boards: ((contexts.get(item.id)?.paths ?? []) as string[])
        .filter((path) => path.startsWith(`${folder}/boards/`))
        .map((path) => path.slice(`${folder}/boards/`.length)),
    }));
  return { proposals: items };
}
