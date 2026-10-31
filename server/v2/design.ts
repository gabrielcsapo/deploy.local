import type { IncomingMessage, ServerResponse } from 'node:http';
import { layerSnippet } from '../design/board-html.ts';
import { currentTaskBranch } from '../workspace/follow-up.ts';
import { requireRepository } from '../workspace/repositories.ts';
import { gitSync, repositoryGit } from '../workspace/repository-git.ts';
import { get, id, list, now, save } from '../workspace/store.ts';
import { queueTask } from '../workspace/task-workspace.ts';
import { readJson, sendJson } from './attachments.ts';
import { fail } from './inbox.ts';

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

type Canvas = {
  title?: string;
  boards: Record<string, { x: number; y: number; w: number; h: number; title?: string }>;
  order?: string[];
  notes?: Record<string, unknown>;
};

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
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)',
    'refs/heads/design/',
  ]);
  return (out ? out.split('\n') : []).map((line) => {
    const [name, commit, updatedAt] = line.split('\t');
    return { name, commit, updatedAt };
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

function presentComment(row: any) {
  return {
    id: row.id,
    board: row.board,
    layer: row.layer ?? null,
    text: row.text,
    author: row.author,
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
  const { existsSync } = await import('node:fs');
  if (!existsSync(chromium.executablePath()))
    fail('Rendering boards needs Chromium on the coordinator: run pnpm audit:visual:install', 503);
  const browser = await chromium.launch();
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
    '- Commit as you go, so the Design page shows your changes while you work. Do not build the change in the app: this task is the design only.',
    '- End by saying what you changed, board by board, and what you checked.',
  ].join('\n');
}

export async function designApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
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
      design: { board, layer, ref, commit, askedAt: now() },
    });
    return sendJson(
      res,
      { task: { id: task.id, title: task.title, branch: currentTaskBranch(task) } },
      201,
    );
  }

  fail('Not found', 404);
}
