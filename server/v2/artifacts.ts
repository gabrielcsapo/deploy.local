import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SpanContext } from '../../packages/trace/index.js';
import { requestPhase, requestSpans } from './request-trace.ts';
import { dispatch, routes } from '../kernel/routes.ts';
import { fail } from '../kernel/errors.ts';
import { gitRead } from '../workspace/repository-git.ts';
import { withRepositoryWrites } from '../kernel/jobs/repository-lock.ts';
import { requireRepository } from '../workspace/repositories.ts';
import { list } from '../workspace/store.ts';
import {
  optionalCommitText,
  presentationCommit,
} from '../features/repositories/repository-views.ts';
import { readJson, sendJson } from './attachments.ts';
import {
  appDesignFolder,
  artifactNamePattern,
  copyPaths,
  mainBranch,
  ownsBranch,
} from './design.ts';
import type { ArtifactKind, ArtifactSummary } from '../../shared/v2/artifacts.ts';
import { artifactSlug, documentTitle } from '../../shared/v2/artifacts.ts';

/**
 * Artifacts: the designs and documents kept in a project's repository. The App design is the
 * project's design/ folder; every other artifact is a folder of its own, artifacts/<name>, with a
 * canvas.json (a design) or a document.md (a document). Creating one writes its files on a new
 * branch, artifact/<name>; it reaches main the way a design does, through review.
 */

const documentFile = 'document.md';
const folderOf = (name: string) => `artifacts/${name}`;
const branchOf = (name: string) => `artifact/${name}`;

/** The first canvas a new design starts from: one empty page, nothing on it. */
export function newCanvas(title: string) {
  return {
    title,
    boards: {},
    order: [],
    notes: { 'section-page-1': { x: 0, y: -150, text: 'Page 1' } },
  };
}

async function show(repo: string, commit: string, path: string) {
  return gitRead(repo, ['show', `${commit}:${path}`]);
}

/** What one folder holds at a commit: a design, a document, or neither. */
async function readArtifact(
  repo: string,
  commit: string,
  folder: string,
): Promise<{ kind: ArtifactKind; name: string; boards?: number } | null> {
  const canvas = await show(repo, commit, `${folder}/canvas.json`);
  if (canvas !== null) {
    try {
      const parsed = JSON.parse(canvas);
      if (parsed && typeof parsed.boards === 'object')
        return {
          kind: 'design',
          name: String(parsed.title ?? ''),
          boards: Object.keys(parsed.boards).length,
        };
    } catch {
      return null;
    }
  }
  if (folder === appDesignFolder) return null;
  const document = await show(repo, commit, `${folder}/${documentFile}`);
  if (document !== null) return { kind: 'document', name: documentTitle(document) };
  return null;
}

/**
 * Whether a branch holds work on `path` that main does not have: it changed the path since it
 * left main, and its copy still differs from main's. Approving copies the files onto main
 * rather than merging, so the branch's commits never become main's ancestors.
 */
async function hasWork(repo: string, main: string | null, ref: string, path: string) {
  if (!main) return true;
  const base = (await gitRead(repo, ['merge-base', main, ref])) || main;
  const changed = await gitRead(repo, ['diff', '--name-only', base, ref, '--', path]);
  if (!changed) return false;
  return (
    base === main || Boolean(await gitRead(repo, ['diff', '--name-only', main, ref, '--', path]))
  );
}

async function changedAt(repo: string, ref: string, folder: string) {
  return (await gitRead(repo, ['log', '-1', '--format=%cI', ref, '--', `${folder}/`])) || null;
}

type ArtifactRefs = { name: string; commit: string; at: string }[];
type RepositoryArtifact = Omit<ArtifactSummary, 'projectId' | 'project' | 'state'> & {
  unproposed: boolean;
};

async function artifactRefs(repo: string) {
  const [main, lines] = await Promise.all([
    mainBranch(repo),
    gitRead(repo, [
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)',
      'refs/heads/design/',
      'refs/heads/artifact/',
    ]),
  ]);
  const head = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${main}^{commit}`,
  ]);
  const refs = (lines ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, commit, at] = line.split('\t');
      return { name, commit, at };
    });
  return { head, refs, key: head && lines !== null ? `${head}\n${lines}` : null };
}

async function scanArtifacts(repo: string, head: string | null, refs: ArtifactRefs) {
  const folders = new Set<string>([appDesignFolder]);
  if (head) {
    const names = (await gitRead(repo, ['ls-tree', '-d', '--name-only', head, 'artifacts/'])) ?? '';
    for (const path of names.split('\n').filter(Boolean)) {
      const name = path.slice('artifacts/'.length);
      if (artifactNamePattern.test(name)) folders.add(folderOf(name));
    }
  }
  // An artifact made here and not approved yet lives only on its branch.
  for (const ref of refs) {
    const match = /^artifact\/([a-z0-9-]+?)(?:--.*)?$/.exec(ref.name);
    if (match && artifactNamePattern.test(match[1])) folders.add(folderOf(match[1]));
  }
  const found = await Promise.all(
    [...folders].map(async (folder): Promise<RepositoryArtifact | null> => {
      const artifact = folder === appDesignFolder ? null : folder.slice('artifacts/'.length);
      const onMain = head ? await readArtifact(repo, head, folder) : null;
      // Branches with work on this folder that main does not have yet, newest first.
      const ahead = (
        await Promise.all(
          refs
            .filter((ref) => ownsBranch(ref.name, folder))
            .map(async (ref) =>
              (await hasWork(repo, head, ref.commit, `${folder}/`)) ? ref : null,
            ),
        )
      )
        .filter((ref) => ref !== null)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const newest = ahead[0];
      const read = onMain ?? (newest ? await readArtifact(repo, newest.commit, folder) : null);
      if (!read) return null;
      const mainAt = head && onMain ? await changedAt(repo, head, folder) : null;
      const updatedAt =
        newest && (!mainAt || Date.parse(newest.at) > Date.parse(mainAt)) ? newest.at : mainAt;
      return {
        artifact,
        kind: read.kind,
        name: artifact ? read.name || artifact : 'App design',
        boards: read.boards,
        updatedAt,
        branch: onMain ? null : (newest?.name ?? null),
        unproposed: ahead.length > 0,
      };
    }),
  );
  return found.filter((entry) => entry !== null);
}

// A scan reads immutable commits. Re-read the refs and inbox on every request so new edits,
// approvals and project metadata appear immediately. Expiry also retries nullable Git reads.
const scanCache = new Map<
  string,
  { key: string; expires: number; result: Promise<RepositoryArtifact[]> }
>();
const scanCacheSize = 64;
const scanCacheMs = 30_000;

async function repositoryArtifacts(repo: string, trace?: SpanContext) {
  const { head, refs, key } = await requestPhase(trace, 'artifacts.refs', () => artifactRefs(repo));
  const cached = scanCache.get(repo);
  if (key && cached?.key === key && cached.expires > performance.now())
    return requestPhase(trace, 'artifacts.scan.cached', () => cached.result);

  const result = requestPhase(trace, 'artifacts.scan', () => scanArtifacts(repo, head, refs));
  if (!key) return result;
  scanCache.delete(repo);
  if (scanCache.size >= scanCacheSize) scanCache.delete(scanCache.keys().next().value!);
  const entry = { key, expires: performance.now() + scanCacheMs, result };
  scanCache.set(repo, entry);
  try {
    return await result;
  } catch (error) {
    if (scanCache.get(repo) === entry) scanCache.delete(repo);
    throw error;
  }
}

async function projectArtifacts(
  project: any,
  waiting: ReadonlySet<string> | undefined,
  trace?: SpanContext,
): Promise<ArtifactSummary[]> {
  const artifacts = await repositoryArtifacts(project.repositoryPath, trace);
  return artifacts.map(({ unproposed, ...entry }) => ({
    projectId: project.id,
    project: project.name ?? project.id,
    ...entry,
    state: waiting?.has(entry.artifact ? folderOf(entry.artifact) : appDesignFolder)
      ? 'review'
      : unproposed
        ? 'unproposed'
        : null,
  }));
}

export async function readArtifacts(owner: string, trace?: SpanContext) {
  const projects = list('project', owner).filter(
    (row: any) => row.repositoryPath && row.repositoryStatus !== 'removing',
  );
  const waiting = new Map<string, Set<string>>();
  for (const row of list('v2-inbox-native', owner)) {
    const { context, item } = row;
    if (context?.source !== 'design' || item?.state !== 'waiting') continue;
    let folders = waiting.get(context.projectId);
    if (!folders) waiting.set(context.projectId, (folders = new Set()));
    folders.add(context.folder ?? appDesignFolder);
  }
  const all = (
    await requestPhase(trace, 'artifacts.projects', (phase) =>
      Promise.all(
        projects.map((project: any, index) =>
          // Leave room for ref and scan phases inside the bounded request trace.
          requestPhase(index < 4 ? phase : undefined, 'artifacts.repository', (repoPhase) =>
            projectArtifacts(project, waiting.get(project.id), repoPhase),
          ).catch(() => []),
        ),
      ),
    )
  ).flat();
  all.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '') || 0);
  return {
    artifacts: all,
    projects: projects.map((project: any) => ({
      id: project.id,
      name: project.name ?? project.id,
    })),
  };
}

/** Write a new artifact's files on artifact/<name>, from main. Nobody adds them by hand. */
export async function createArtifact(
  owner: string,
  input: { kind?: unknown; name?: unknown; project?: unknown },
) {
  const kind = input.kind;
  if (kind !== 'design' && kind !== 'document') fail('Make a design or a document');
  const title = String(input.name ?? '').trim();
  if (!title || title.length > 80) fail('Give it a name of at most 80 characters');
  const name = artifactSlug(title);
  if (!name) fail('Give it a name with a letter or a number');
  const project = requireRepository(owner, String(input.project ?? ''));
  const repo = project.repositoryPath as string;
  const folder = folderOf(name);
  const branch = branchOf(name);
  return withRepositoryWrites(repo, async () => {
    const main = await mainBranch(repo);
    const head = await gitRead(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${main}^{commit}`,
    ]);
    if (!head) fail(`${main} has no commits yet`, 409);
    if (await gitRead(repo, ['ls-tree', '--name-only', head!, `${folder}/`]))
      fail(`${project.name ?? project.id} already has ${folder}`, 409);
    if (await gitRead(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))
      fail(`${branch} already exists`, 409);
    const files =
      kind === 'design'
        ? [
            {
              path: `${folder}/canvas.json`,
              content: `${JSON.stringify(newCanvas(title), null, 2)}\n`,
            },
          ]
        : [{ path: `${folder}/${documentFile}`, content: `# ${title}\n` }];
    if (
      (await gitRead(repo, [
        'update-ref',
        `refs/heads/${branch}`,
        head!,
        '0'.repeat(head!.length),
      ])) === null
    )
      fail(`Could not create ${branch}`, 500);
    const commit = await copyPaths(repo, {
      target: head!,
      from: head!,
      paths: [],
      branch,
      message: `Add ${folder}`,
      by: owner,
      writes: files,
    });
    return { projectId: project.id, artifact: name, kind, branch, commit };
  });
}

async function resolve(repo: string, ref: string) {
  if (!ref || ref.startsWith('-') || ref.includes('..') || ref.length > 250) fail('Invalid ref');
  const commit = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  if (!commit) fail(`No commit named ${ref} in this project`, 404);
  return commit!;
}

/**
 * A document as it is on main and, while it is being edited, on its branch: the page shows the
 * branch's text and marks the blocks that differ from main.
 */
export async function readDocument(owner: string, projectId: string, name: string, url: URL) {
  const project = requireRepository(owner, projectId);
  const repo = project.repositoryPath as string;
  const folder = folderOf(name);
  const path = `${folder}/${documentFile}`;
  const reviewId = url.searchParams.get('review');
  if (reviewId) return readReviewedDocument(owner, project, name, reviewId);
  const main = await mainBranch(repo);
  const head = await gitRead(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${main}^{commit}`,
  ]);
  const mainText = head ? await show(repo, head, path) : null;
  // The branch to show: the one asked for, else the newest of this document's branches.
  let branch = url.searchParams.get('ref');
  if (!branch) {
    const refs = (
      (await gitRead(repo, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)',
        'refs/heads/artifact/',
      ])) ?? ''
    )
      .split('\n')
      .filter((ref) => ref && ownsBranch(ref, folder));
    for (const ref of refs) {
      if (await hasWork(repo, head, ref, path)) {
        branch = ref;
        break;
      }
    }
  }
  if (branch && !ownsBranch(branch, folder)) fail('That branch is not this document’s', 404);
  const commit = branch ? await resolve(repo, `refs/heads/${branch}`) : head;
  const text = commit ? await show(repo, commit, path) : null;
  if (text === null && mainText === null) fail('No such document', 404);
  // The commit that made a new document is not an edit.
  const edits =
    branch && head
      ? Math.max(
          0,
          Number((await gitRead(repo, ['rev-list', '--count', `${head}..${commit}`])) ?? 0) -
            (mainText === null ? 1 : 0),
        )
      : 0;
  const waiting = list('v2-inbox-native', owner).find(
    (row: any) =>
      row.context?.source === 'design' &&
      row.context.projectId === project.id &&
      row.context.folder === folder &&
      row.item.state === 'waiting',
  );
  return {
    projectId: project.id,
    project: project.name ?? project.id,
    artifact: name,
    title: documentTitle(text ?? mainText ?? ''),
    text: text ?? '',
    main: mainText,
    branch: branch ?? null,
    commit,
    edits,
    changedAt: commit ? await changedAt(repo, commit, folder) : null,
    review: waiting
      ? { id: waiting.id, branch: waiting.context.branch, state: waiting.item.state }
      : null,
  };
}

/**
 * A document as one review proposed it: After is the commit proposed, Before is the document on
 * main now. The review page reads it while it waits and after it is decided, so this reads only
 * cached views and starts no Git process once warm.
 */
async function readReviewedDocument(owner: string, project: any, name: string, reviewId: string) {
  const repo = project.repositoryPath as string;
  const folder = folderOf(name);
  const path = `${folder}/${documentFile}`;
  const row = list('v2-inbox-native', owner).find(
    (entry: any) =>
      entry.id === reviewId &&
      entry.context?.source === 'design' &&
      entry.context.projectId === project.id &&
      entry.context.folder === folder,
  );
  if (!row) fail('No such review of this document', 404);
  const { context, item } = row as any;
  const head = await presentationCommit(repo, `refs/heads/${context.main || 'main'}`).catch(
    () => null,
  );
  const [text, mainText, mainAt] = await Promise.all([
    optionalCommitText(repo, ['show', `${context.commit}:${path}`]),
    head ? optionalCommitText(repo, ['show', `${head}:${path}`]) : null,
    head ? optionalCommitText(repo, ['log', '-1', '--format=%cI', head, '--', `${folder}/`]) : null,
  ]);
  if (text === null && mainText === null) fail('No such document', 404);
  return {
    projectId: project.id,
    project: project.name ?? project.id,
    artifact: name,
    title: documentTitle(text ?? mainText ?? ''),
    text: text ?? '',
    main: mainText,
    branch: context.branch as string,
    commit: context.commit as string,
    edits: 0,
    changedAt: mainAt || null,
    review: { id: row!.id, branch: context.branch as string, state: item.state as string },
  };
}

/** Save the document to its branch, starting artifact/<name> from main on the first edit. */
export async function saveDocument(owner: string, projectId: string, name: string, body: any) {
  const project = requireRepository(owner, projectId);
  const repo = project.repositoryPath as string;
  const folder = folderOf(name);
  const path = `${folder}/${documentFile}`;
  const text = String(body?.text ?? '');
  if (text.length > 512 * 1024) fail('A document can hold at most 512 KB of text');
  return withRepositoryWrites(repo, async () => {
    const main = await mainBranch(repo);
    const head = await gitRead(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${main}^{commit}`,
    ]);
    if (!head) fail(`${main} has no commits yet`, 409);
    let branch = body?.branch ? String(body.branch) : null;
    if (branch && !ownsBranch(branch, folder)) fail('That branch is not this document’s', 404);
    if (!branch) {
      // Edit starts a branch: artifact/<name>, or the next free one beside it.
      branch = branchOf(name);
      for (
        let n = 2;
        await gitRead(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        n++
      )
        branch = `${branchOf(name)}--edits${n === 2 ? '' : `-${n}`}`;
      if (!(await show(repo, head!, path))) fail('No such document', 404);
      if (
        (await gitRead(repo, [
          'update-ref',
          `refs/heads/${branch}`,
          head!,
          '0'.repeat(head!.length),
        ])) === null
      )
        fail(`Could not create ${branch}`, 500);
    }
    const at = await resolve(repo, `refs/heads/${branch}`);
    if (body?.expect && body.expect !== at)
      fail('This document changed since you opened it; reload it and edit again', 409);
    if ((await show(repo, at, path)) === text.replace(/\n$/, '')) return { branch, commit: at };
    const commit = await copyPaths(repo, {
      target: at,
      from: at,
      paths: [],
      branch,
      message: `Edit ${folder}`,
      by: owner,
      writes: [{ path, content: text.endsWith('\n') ? text : `${text}\n` }],
    });
    return { branch, commit };
  });
}

export async function artifactsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  const route = routes<undefined>();
  const document = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)\/document$/);
  const name = document ? decodeURIComponent(document[2]) : '';
  if (document && !artifactNamePattern.test(name)) fail('Not found', 404);
  return dispatch([
    route({
      method: 'GET',
      path: '/api/artifacts',
      handler: async () => sendJson(res, await readArtifacts(owner, requestSpans.get(res)?.phases)),
    }),
    route({
      method: 'POST',
      path: '/api/artifacts',
      handler: async () => sendJson(res, await createArtifact(owner, await readJson(req)), 201),
    }),
    route({
      method: 'GET',
      path: '/api/projects/:project/artifacts/:artifact/document',
      handler: async () =>
        sendJson(res, await readDocument(owner, decodeURIComponent(document![1]), name, url)),
    }),
    route({
      method: 'PUT',
      path: '/api/projects/:project/artifacts/:artifact/document',
      handler: async () =>
        sendJson(
          res,
          await saveDocument(owner, decodeURIComponent(document![1]), name, await readJson(req)),
        ),
    }),
  ])(req, res, undefined);
}
