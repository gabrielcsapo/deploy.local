// Entirely synthetic repository/database. Run on 5180; never opens the coordinator's data.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
if (process.env.DEPLOY_MDNS_ADDRESS !== '127.0.0.1')
  throw new Error('Set DEPLOY_MDNS_ADDRESS=127.0.0.1');
const port = Number(process.env.PORT ?? 5180);
if (port < 5180 || port > 5189) throw new Error('Use only ports 5180–5189');
const root = mkdtempSync(join(tmpdir(), 'review-surface-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const { save, list, remove, get } = await import('../../../server/workspace/store.ts');
const { v2Api } = await import('../../../server/v2/api.ts');
const { proposeDesign, designReview, startDesignApprovals } =
  await import('../../../server/v2/design.ts');
const { layerSnippet } = await import('../../../server/design/board-html.ts');
const owner = 'review-fixture';
const repo = join(root, 'repository');
mkdirSync(join(repo, 'design/boards'), { recursive: true });
cpSync(resolve('design/ds'), join(repo, 'design/ds'), { recursive: true });
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '--initial-branch=main');
git('config', 'user.name', 'Review fixture');
git('config', 'user.email', 'review@example.invalid');
const source = readFileSync('design/boards/DesignReview.html', 'utf8');
const screen = layerSnippet(source, 'review-screen')!.replace('dl-rv-screen ', 'fixture-screen ');
const phoneSource = readFileSync('design/boards/DesignReviewWipe.html', 'utf8');
const oldPhone = layerSnippet(phoneSource, 'phone-2')!;
const newPhone = layerSnippet(phoneSource, 'phone')!;
const projectPhone = layerSnippet(
  readFileSync('design/boards/DesignReviewNew.html', 'utf8'),
  'phone',
)!;

const html = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../ds/deploy-local/tokens.css"><link rel="stylesheet" href="../ds/deploy-local/components/bundle.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap"><style>body{margin:0;font-family:Arial,sans-serif;font-size:13px;color:var(--ink)}.fixture-screen{height:100vh;display:flex;flex-direction:column}.fixture-screen a{color:inherit;text-decoration:none}.fixture-screen .dl-menu-btn{display:none}.fixture-screen .dl-head{padding-left:20px}.dl-rv-change::after{display:none}</style></head><body>${body.replaceAll('gabriel', 'fixture-user')}</body></html>`;
const files = Array.from({ length: 23 }, (_, i) =>
  i === 21 ? 'RepositorySync.html' : `Project${i + 1}.html`,
);
const sameFiles = ['BackLink.html', 'BackSettings.html', 'BackRepository.html'];
const boards: Record<string, any> = {};
const write = (file: string, body: string) =>
  writeFileSync(join(repo, 'design/boards', file), html(body));
for (const [i, file] of [...files, ...sameFiles, 'ProjectsPhone.html'].entries()) {
  boards[file] = {
    x: i * 1600,
    y: 0,
    w: file.includes('Phone') ? 390 : 1440,
    h: 900,
    title:
      file === 'RepositorySync.html'
        ? 'Repository sync'
        : file.includes('Phone')
          ? 'Projects on iPhone'
          : `Project ${i + 1}`,
  };
  const breadcrumb = layerSnippet(screen, 'breadcrumb')!;
  const old = `<nav data-layer="breadcrumb" class="dl-crumbs"><span data-layer="project-label">${i < 4 ? 'Repository' : 'Project'}</span> <span data-layer="home-gym" class="dl-t">home-gym</span></nav>`;
  write(file, sameFiles.includes(file) ? screen : screen.replace(breadcrumb, old));
}
write('ProjectsPhone.html', oldPhone);
const canvas = () =>
  writeFileSync(
    join(repo, 'design/canvas.json'),
    JSON.stringify({ title: 'Review fixture', boards, order: Object.keys(boards), notes: {} }),
  );
canvas();
git('add', '.');
git('commit', '-qm', 'Add fixture screens');
const base = git('rev-parse', 'HEAD');
git('checkout', '-qb', 'design/project-back');
for (const file of files) write(file, screen);
for (const file of sameFiles)
  write(file, screen.replace('href="Projects.html"', 'href="ProjectsPhone.html"'));
write('ProjectsPhone.html', newPhone);
boards['ProjectPhone.html'] = { x: 0, y: 1200, w: 390, h: 844, title: 'A project on iPhone' };
write('ProjectPhone.html', projectPhone);
canvas();
git('add', '.');
git('commit', '-qm', 'Add a way back from projects');
const after = git('rev-parse', 'HEAD');
write(files[0], screen.replace('Hosted on deploy.local', 'This project lives on deploy.local'));
git('add', '.');
git('commit', '-qm', 'Show several changed areas');
const several = git('rev-parse', 'HEAD');
write(files[0], screen);
for (const file of files)
  write(
    file,
    screen.replace(
      'data-layer="home-gym" class="dl-t"',
      'data-layer="home-gym" class="dl-t" style="font-weight:600"',
    ),
  );
git('add', '.');
git('commit', '-qm', 'Keep project names bold in the next review');
const round2 = git('rev-parse', 'HEAD');
git('branch', '-f', 'design/round-two', round2);
git('branch', '-f', 'design/several', several);

git('checkout', '-q', 'main');
git('branch', '-f', 'design/project-back', after);
const project = {
  id: 'review-project',
  name: 'home-gym',
  repositoryPath: repo,
  repositoryStatus: 'ready',
};
save('project', owner, project);
save('run', owner, { id: 'fixture-run', taskId: 'review-task', status: 'running' });
save('agent', owner, { id: 'designer', name: 'Designer', job: 'Design the app', computers: [] });
save('task', owner, {
  id: 'review-task',
  projectId: project.id,
  title: 'Build the project navigation',
  status: 'open',
  createdAt: new Date().toISOString(),
});
const item = await proposeDesign(owner, project, {
  ref: 'design/project-back',
  title: 'A way back from a project',
  summary:
    'Project pages get a breadcrumb back to Projects, and on iPhone a project opens as its own page.',
  changeWords: {
    ...Object.fromEntries(sameFiles.map((file) => [file, { 'projects-2': 'Where Back goes' }])),
    'ProjectsPhone.html': { 'home-gym': 'Projects on iPhone' },
  },
});
const savedRow = get('v2-inbox-native', owner, item.id);
const baseline = {
  ...savedRow,
  item: { ...savedRow.item, taskId: 'review-task' },
  context: {
    ...savedRow.context,
    taskId: 'review-task',
    proposer: { id: 'designer', name: 'Designer', avatar: null },
  },
};
save('v2-inbox-native', owner, baseline);
let phoneReady: { board: string; failed: number } | null = null;
let currentState = 'DesignReview';
let currentItemId = item.id;
const reset = (state: string) => {
  phoneReady = null;
  if (state.endsWith('Phone')) {
    state = state.replace(/Phone$/, '');
    if (
      [
        'DesignReviewDrawComment',
        'DesignReviewDrawSaved',
        'DesignReviewPin',
        'DesignReviewGrid',
        'DesignReviewDecide',
        'DesignReviewHold',
      ].includes(state)
    )
      state = 'DesignReview';
  }
  currentState = state;
  currentItemId = item.id;
  for (const kind of [
    'design-comment',
    'design-review-seen',
    'design-review-landing',
    'design-review-built',
    'v2-inbox-answer',
    'v2-inbox-native',
    'queued-message',
  ])
    for (const row of list(kind, owner)) remove(kind, owner, row.id);
  git('update-ref', 'refs/heads/main', base);
  save('v2-inbox-native', owner, baseline);
  if (state === 'DesignReviewWords') {
    const changeWords = { ...baseline.context.changeWords };
    delete changeWords['ProjectsPhone.html'];
    currentItemId = `${item.id}-words`;
    remove('v2-inbox-native', owner, item.id);
    save('v2-inbox-native', owner, {
      ...baseline,
      id: currentItemId,
      item: { ...baseline.item, id: currentItemId },
      context: { ...baseline.context, changeWords },
    });
  }
  if (state === 'DesignReviewDiffSeveral')
    save('v2-inbox-native', owner, {
      ...baseline,
      context: { ...baseline.context, commit: several },
    });
  if (state === 'DesignReviewRound2') {
    currentItemId = item.id.replace(after.slice(0, 12), round2.slice(0, 12));
    save('v2-inbox-native', owner, {
      ...baseline,
      item: {
        ...baseline.item,
        state: 'answered',
        answer: { actionId: 'changes', at: new Date().toISOString(), by: owner, on: 'web' },
      },
    });
    save('v2-inbox-native', owner, {
      ...baseline,
      id: currentItemId,
      item: { ...baseline.item, id: currentItemId },
      context: {
        ...baseline.context,
        commit: round2,
        previousCommit: after,
        previousItemId: item.id,
        round: 2,
      },
    });
  }
  if (state === 'DesignPropose') remove('v2-inbox-native', owner, item.id);

  if (
    [
      'DesignReviewViewer',
      'DesignReviewDiff',
      'DesignReviewWidth',
      'DesignReviewRegion',
      'DesignReviewDraw',
      'DesignReviewNote',
      'DesignReviewSent',
      'DesignReviewRound2',
      'DesignReviewApproveCheck',
    ].includes(state)
  )
    save('design-comment', owner, {
      id: 'fixture-note',
      projectId: project.id,
      reviewItemId: item.id,
      board: files[0],
      layer: 'home-gym',
      position: { width: 1440, revision: after, x: 190, y: 56, offset: { x: 0.5, y: 0.5 } },
      number: 1,
      text: 'Keep the project name bold.',
      author: owner,
      resolved: state === 'DesignReviewRound2',
      reply: state === 'DesignReviewRound2' ? 'home-gym stays semibold in the breadcrumb.' : null,
      createdAt: new Date().toISOString(),
    });
  if (state === 'DesignReviewSent') {
    const answer = { actionId: 'changes', on: 'web', by: owner, at: new Date().toISOString() };
    save('v2-inbox-native', owner, {
      ...baseline,
      item: { ...baseline.item, state: 'answered', answer },
    });
    save('v2-inbox-answer', owner, { id: item.id, answer });
  }
  if (state === 'DesignReviewApproved' || state === 'DesignToReview') {
    const answer = { actionId: 'approve', on: 'web', by: owner, at: new Date().toISOString() };
    save('v2-inbox-native', owner, {
      ...baseline,
      item: { ...baseline.item, state: 'answered', answer },
    });
    save('v2-inbox-answer', owner, { id: item.id, answer });
    if (state === 'DesignReviewApproved')
      save('design-review-landing', owner, {
        id: item.id,
        at: new Date(Date.now() + 30000).toISOString(),
        state: 'pending',
      });
    else {
      git('update-ref', 'refs/heads/main', after);
      for (const state of ['matches', 'differs']) {
        const reportId = `${item.id}:${state}`;
        save('v2-inbox-native', owner, {
          ...baseline,
          id: reportId,
          item: {
            ...baseline.item,
            id: reportId,
            title: state === 'matches' ? 'A calmer project header' : 'A project on iPhone',
            state: 'answered',
            answer,
          },
          context: { ...baseline.context, taskId: null },
        });
        save('v2-inbox-answer', owner, { id: reportId, answer });
        save('design-review-built', owner, {
          id: reportId,
          state,
          differences: state === 'differs' ? 1 : undefined,
          at: new Date().toISOString(),
        });
      }
    }
  }
};
const vite = await createVite({
  configFile: false,
  cacheDir: join(root, 'vite'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve('app'),
      'react-flight-router/client': resolve('docs/evidence/board-parity/fixture-router.tsx'),
    },
  },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});
const stopApprovals = startDesignApprovals();
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1:${port}`);
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname === '/__fixture/native-ready') {
      phoneReady = {
        board: url.searchParams.get('board') ?? '',
        failed: Number(url.searchParams.get('failed') ?? 0),
      };
      return send({ ok: true });
    }
    if (url.pathname === '/__fixture/native-status') return send(phoneReady);
    if (url.pathname === '/__fixture') {
      reset(url.searchParams.get('state') ?? 'DesignReview');
      const destination =
        currentState === 'DesignToReview'
          ? '/dashboard/design?view=review'
          : currentState === 'DesignPropose'
            ? `/dashboard/design?project=${project.id}&view=canvas&ref=design%2Fproject-back`
            : `/dashboard/inbox?item=${encodeURIComponent(currentItemId)}`;
      res.writeHead(302, { location: `${destination}&state=${currentState}` });
      res.end();
      return;
    }
    if (url.pathname.endsWith('/design/review') && req.method === 'GET') {
      if (currentState === 'loading') await new Promise((done) => setTimeout(done, 20000));
      const review = await designReview(
        owner,
        project,
        get('v2-inbox-native', owner, currentItemId),
      );
      // These fixture-only states model server responses without modifying the real repository.
      if (currentState === 'conflict') {
        review.stale = true;
        review.conflicts = files.slice(0, 2);
      }
      return send(review);
    }
    if (url.pathname === '/api/workspace/state')
      return send({
        version: 1,
        cursor: 1,
        projects: [],
        tasks: [],
        workers: [],
        runs: [],
        adapters: [],
      });
    if (url.pathname === '/api/user') return send({ username: owner, role: 'admin' });
    if (url.pathname === '/api/nodes') return send({ nodes: [] });
    if (url.pathname === '/api/v2/auth/account')
      return send({ username: owner, welcomed: true, firstTaskSeen: true, passkeyOffered: true });
    if (url.pathname === '/api/v2/events' && url.searchParams.get('after') === 'latest')
      return send({ events: [], cursor: 0, supportsWait: true });
    if (url.pathname === '/api/v2/events' || url.pathname.endsWith('/stream')) {
      const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 15000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname.startsWith('/api/v2/')) {
      await v2Api(req, res, () => ({ username: owner }));
      if (res.writableEnded || res.headersSent) return;
    }
    if (url.pathname.startsWith('/api/')) return send({});
    if (url.pathname.startsWith('/dashboard')) {
      res.setHeader('content-type', 'text/html');
      res.end(
        await vite.transformIndexHtml(
          url.pathname,
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap"><style>body{margin:0;font-family:Arial,sans-serif;font-size:13px;color:var(--ink)}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/docs/evidence/review-surface-build/fixture.client.tsx"></script></body></html>',
        ),
      );
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  } catch (error) {
    if (!res.headersSent) send({ error: String(error) }, 500);
    else res.end();
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Fixture: http://127.0.0.1:${port}/__fixture?state=DesignReview\nTest data: ${root}`),
);
process.on('SIGINT', () => {
  stopApprovals();
  server.close();
  void vite.close().then(() => process.exit());
});
