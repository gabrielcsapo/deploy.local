import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, get, list } from '../workspace/store.ts';
import { sendJson } from './attachments.ts';
import { fail } from '../kernel/errors.ts';
import { dispatch, routes } from '../kernel/routes.ts';
import { repositoryGit } from '../kernel/git.ts';
import { resolveCommit } from '../workspace/repositories.ts';
import {
  MESSAGE_SEARCH_MIN,
  searchMessageRecords,
  snippet,
} from '../workspace/message-search.ts';
import {
  matchFileNames,
  searchRepositoryCode,
  type FileMatch,
} from '../workspace/repository-search.ts';
import { projectsForOwner } from './projects.ts';
import { agentsForOwner } from './agents.ts';
import { getComputers } from './computers.ts';

/**
 * One search across deploy.local. Names answer at once from what is already stored; text inside
 * code is a separate, slower read so the names never wait for it.
 */
export type SearchName = {
  kind: 'project' | 'app' | 'task' | 'agent' | 'computer' | 'pull' | 'issue';
  id: string;
  title: string;
  /** What it belongs to, for the row's quiet text and its link. */
  projectId?: string;
  project?: string;
  appKind?: 'web' | 'worker';
  status?: string;
  agent?: string;
  number?: number;
  at?: string;
};
export type SearchMessage = {
  id: string;
  /** A task's chat, or an agent's. */
  taskId?: string;
  agentId?: string;
  title: string;
  who: string;
  fromYou: boolean;
  at: string;
  snippet: string;
};
export type SearchResponse = {
  query: string;
  names: SearchName[];
  messages: { total: number; items: SearchMessage[] };
  /** Only inside a project: files whose name matches. */
  files?: { total: number; items: FileMatch[]; ref: string };
};
export type SearchCodeResponse = {
  query: string;
  lines: number;
  files: number;
  projects: number;
  truncated: boolean;
  /** The branch searched, when the search was inside one project. */
  ref?: string;
  items: { projectId: string; project: string; ref: string; path: string; line: number; text: string }[];
};

const NAME_LIMIT = 6;
const MESSAGE_LIMIT = 50;

function query(url: URL) {
  const text = (url.searchParams.get('q') ?? '').trim();
  if (text.length > 200) fail('Search for something shorter');
  return text;
}

/** Names that start with the words rank above names that only contain them. */
function rank<T>(rows: T[], needle: string, text: (row: T) => string, recent: (row: T) => string) {
  const scored: { row: T; score: number; at: string }[] = [];
  for (const row of rows) {
    const at = text(row).toLowerCase().indexOf(needle);
    if (at >= 0) scored.push({ row, score: at === 0 ? 0 : 1, at: recent(row) });
  }
  scored.sort((a, b) => a.score - b.score || b.at.localeCompare(a.at));
  return scored.map((item) => item.row);
}

export async function readSearch(owner: string, url: URL): Promise<SearchResponse> {
  const text = query(url);
  const projectId = url.searchParams.get('project') || undefined;
  if (projectId) get('project', owner, projectId);
  const empty: SearchResponse = { query: text, names: [], messages: { total: 0, items: [] } };
  if (!text) return empty;
  const needle = text.toLowerCase();
  const projects = await projectsForOwner(owner);
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const agents = agentsForOwner(owner);
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));
  const tasks = list('task', owner);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const inProject = (row: { projectId?: string }) => !projectId || row.projectId === projectId;

  const names: SearchName[] = [];
  if (!projectId) {
    for (const project of rank(projects, needle, (p) => p.name, (p) => p.name).slice(0, NAME_LIMIT))
      names.push({ kind: 'project', id: project.id, title: project.name });
  }
  const apps = projects
    .filter((project) => !projectId || project.id === projectId)
    .flatMap((project) => project.apps.map((app) => ({ app, project })));
  for (const { app, project } of rank(apps, needle, (a) => a.app.name, (a) => a.app.name).slice(
    0,
    NAME_LIMIT,
  ))
    names.push({
      kind: 'app',
      id: app.id,
      title: app.name,
      projectId: project.id,
      project: project.name,
      appKind: app.kind,
    });
  for (const task of rank(
    tasks.filter((task) => task.title && inProject(task)),
    needle,
    (task) => String(task.title),
    (task) => String(task.updatedAt ?? task.createdAt ?? ''),
  ).slice(0, NAME_LIMIT))
    names.push({
      kind: 'task',
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      project: projectName.get(task.projectId),
      status: task.status,
      agent: agentName.get(task.agentId),
      at: task.updatedAt ?? task.createdAt,
    });
  if (!projectId) {
    for (const agent of rank(agents, needle, (a) => a.name, (a) => a.name).slice(0, NAME_LIMIT))
      names.push({ kind: 'agent', id: agent.id, title: agent.name });
    for (const computer of rank(getComputers(owner), needle, (c) => c.name, (c) => c.name).slice(
      0,
      NAME_LIMIT,
    ))
      names.push({ kind: 'computer', id: computer.id, title: computer.name });
  }
  for (const [kind, record] of [
    ['pull', 'pull-request'],
    ['issue', 'issue'],
  ] as const)
    for (const row of rank(
      list(record, owner).filter((row) => row.title && inProject(row)),
      needle,
      (row) => `${row.title} #${row.number ?? ''}`,
      (row) => String(row.updatedAt ?? row.createdAt ?? ''),
    ).slice(0, NAME_LIMIT))
      names.push({
        kind,
        id: row.id,
        title: row.title,
        number: row.number,
        projectId: row.projectId,
        project: projectName.get(row.projectId),
        status: row.status ?? row.state,
        at: row.updatedAt ?? row.createdAt,
      });

  const messages: SearchMessage[] = [];
  if ([...text].length >= MESSAGE_SEARCH_MIN)
    for (const hit of searchMessageRecords(db, owner, text)) {
      if (hit.kind === 'message') {
        const task = taskById.get(hit.row.taskId);
        if (!task || hit.row.isProgress || !inProject(task)) continue;
        const fromYou = hit.row.role === 'user';
        messages.push({
          id: hit.row.id,
          taskId: task.id,
          agentId: task.agentId,
          title: task.title || 'Task',
          who: fromYou ? 'You' : (agentName.get(task.agentId) ?? 'Agent'),
          fromYou,
          at: hit.row.createdAt,
          snippet: snippet(hit.text, text),
        });
      } else {
        const name = agentName.get(hit.row.agentId);
        const event = hit.row.event;
        if (!name || projectId || !event) continue;
        const fromYou = event.kind === 'you';
        messages.push({
          id: event.id,
          agentId: hit.row.agentId,
          title: name,
          who: fromYou ? 'You' : name,
          fromYou,
          at: event.at,
          snippet: snippet(hit.text, text),
        });
      }
    }
  messages.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const response: SearchResponse = {
    query: text,
    names,
    messages: { total: messages.length, items: messages.slice(0, MESSAGE_LIMIT) },
  };
  if (projectId) {
    const target = await searchTarget(owner, projectId, url.searchParams.get('ref'));
    if (target) {
      const raw = await repositoryGit(
        target.repo,
        ['ls-tree', '-r', '-z', '--name-only', target.commit],
        { limit: 8 * 1024 * 1024 },
      );
      response.files = {
        ...matchFileNames(raw.toString().split('\0').filter(Boolean), text),
        ref: target.ref,
      };
    }
  }
  return response;
}

/** A project's repository and the commit to search: the branch asked for, or its main branch. */
async function searchTarget(owner: string, projectId: string, ref: string | null) {
  const project = get('project', owner, projectId);
  if (!project.repositoryPath) return null;
  if (project.repositoryStatus && project.repositoryStatus !== 'ready') return null;
  try {
    const commit = await resolveCommit(project.repositoryPath, ref || 'HEAD');
    let name = ref || '';
    if (!name)
      name = (
        await repositoryGit(project.repositoryPath, ['symbolic-ref', '--short', 'HEAD'], {
          allowStatus: [1, 128],
        })
      )
        .toString()
        .trim();
    return { id: project.id as string, name: project.name as string, repo: project.repositoryPath as string, commit, ref: name || 'main' };
  } catch {
    // An empty repository has nothing to search.
    return null;
  }
}

export async function readSearchCode(
  owner: string,
  url: URL,
  signal?: AbortSignal,
): Promise<SearchCodeResponse> {
  const text = query(url);
  const projectId = url.searchParams.get('project') || undefined;
  const keep = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 3));
  const response: SearchCodeResponse = {
    query: text,
    lines: 0,
    files: 0,
    projects: 0,
    truncated: false,
    items: [],
  };
  if ([...text].length < MESSAGE_SEARCH_MIN) return response;
  const ids = projectId
    ? [projectId]
    : list('project', owner)
        .filter((project) => project.repositoryPath)
        .map((project) => project.id as string);
  const targets = (
    await Promise.all(
      ids.map((id) => searchTarget(owner, id, projectId ? url.searchParams.get('ref') : null)),
    )
  ).filter((target) => target !== null);
  if (projectId && targets[0]) response.ref = targets[0].ref;
  // A few repositories at a time: each search already uses several threads.
  let next = 0;
  const found: (Awaited<ReturnType<typeof searchRepositoryCode>> | null)[] = [];
  await Promise.all(
    Array.from({ length: Math.min(3, targets.length) }, async () => {
      while (next < targets.length) {
        const index = next++;
        const target = targets[index];
        found[index] = await searchRepositoryCode(target.repo, target.commit, text, {
          keep,
          signal,
        }).catch(() => null);
      }
    }),
  );
  targets.forEach((target, index) => {
    const result = found[index];
    if (!result?.lines) return;
    response.lines += result.lines;
    response.files += result.files;
    response.projects++;
    response.truncated ||= result.truncated;
    for (const item of result.items)
      if (response.items.length < keep)
        response.items.push({ projectId: target.id, project: target.name, ref: target.ref, ...item });
  });
  return response;
}

const makeRoute = routes<{ owner: string; url: URL }>();
const searchDispatch = dispatch([
  makeRoute({
    method: 'GET',
    path: '/api/search',
    handler: async ({ res, context }) => sendJson(res, await readSearch(context.owner, context.url)),
  }),
  makeRoute({
    method: 'GET',
    path: '/api/search/code',
    handler: async ({ req, res, context }) => {
      const stop = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) stop.abort();
      });
      void req;
      return sendJson(res, await readSearchCode(context.owner, context.url, stop.signal));
    },
  }),
]);

export async function searchApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  return searchDispatch(req, res, { owner, url: new URL(req.url!, 'http://localhost') });
}
