/** Real database fixture. No router shim, Docker, workers, network, or Git mutations. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

if (!process.env.DEPLOY_DATA_DIR)
  throw new Error('Set DEPLOY_DATA_DIR to an empty fixture directory');
const root = resolve(process.env.DEPLOY_DATA_DIR);
mkdirSync(root, { recursive: true });
const store = await import('../../../server/store.ts');
const { save, db } = await import('../../../server/workspace/store.ts');
const { updatePreferences } = await import('../../../server/v2/auth-store.ts');
const { putProjectSettings, putProjectSecret } = await import('../../../server/v2/settings.ts');
const { resolveProject } = await import('../../../server/v2/projects.ts');
const account = store.registerUser('owner', randomBytes(24).toString('hex'));
if (!account.token) throw new Error(account.error);
const owner = 'owner';
updatePreferences(owner, { welcomed: true, passkeyOffered: true, firstTaskSeen: true });
const now = Date.now();
const at = (ago = 0) => new Date(now - ago).toISOString();

// Write a tiny valid bare object database directly. Application reads still go through its real
// repository APIs; the seed never invokes a Git command or starts a repository worker.
function repository(id: string, name: string, pipeline = false) {
  const directory = join(root, 'workspace', 'repositories', `${id}.git`);
  mkdirSync(join(directory, 'refs', 'heads'), { recursive: true });
  mkdirSync(join(directory, 'objects'), { recursive: true });
  writeFileSync(join(directory, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(directory, 'config'), '[core]\nrepositoryformatversion = 0\nbare = true\n');
  function object(kind: string, content: Buffer | string) {
    const body = Buffer.from(content);
    const bytes = Buffer.concat([Buffer.from(`${kind} ${body.length}\0`), body]);
    const oid = createHash('sha1').update(bytes).digest('hex');
    mkdirSync(join(directory, 'objects', oid.slice(0, 2)), { recursive: true });
    writeFileSync(join(directory, 'objects', oid.slice(0, 2), oid.slice(2)), deflateSync(bytes));
    return oid;
  }
  const files: Record<string, string> = {
    'README.md': `# ${name}\n\nLocal project-pages evidence.\n`,
  };
  if (pipeline)
    files['deploy.yaml'] =
      `apiVersion: deploy.local/v1\nkind: Application\npipeline:\n  on: [push, manual]\n  jobs:\n    typecheck:\n      runsOn: {os: linux}\n      run: pnpm typecheck\n`;
  const tree = object(
    'tree',
    Buffer.concat(
      Object.entries(files)
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([path, body]) =>
          Buffer.concat([
            Buffer.from(`100644 ${path}\0`),
            Buffer.from(object('blob', body), 'hex'),
          ]),
        ),
    ),
  );
  function commit(message: string, parent?: string) {
    return object(
      'commit',
      `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Owner <owner@example.test> ${Math.floor(now / 1000)} +0000\ncommitter Owner <owner@example.test> ${Math.floor(now / 1000)} +0000\n\n${message}\n`,
    );
  }
  const main = commit('Prepare project pages');
  const proposal = commit('Keep project tabs mounted', main);
  writeFileSync(join(directory, 'refs/heads/main'), `${main}\n`);
  writeFileSync(join(directory, 'refs/heads/proposal'), `${proposal}\n`);
  save('project', owner, {
    id,
    name,
    owner,
    repositoryPath: directory,
    repositoryStatus: 'ready',
    defaultBranch: 'main',
    source: { kind: 'hosted' },
    createdAt: at(5 * 86400_000),
  });
  return main;
}
const manyCommit = repository('many-tabs', 'deploy.local', true);
const pantryCommit = repository('pantry', 'pantry');
repository('small', 'Small project');
save('project', owner, {
  id: 'preparing',
  name: 'Preparing repository',
  owner,
  repositoryStatus: 'preparing',
  defaultBranch: 'main',
  source: { kind: 'hosted' },
  createdAt: at(),
});
save('repository-operation', owner, {
  id: 'preparing-operation',
  projectId: 'preparing',
  kind: 'prepare',
  status: 'waiting',
  createdAt: at(),
  updatedAt: at(),
});

// Stopped deployments prevent health probes and recovery from contacting Docker/the network.
// Traffic recording is independent of runtime status; a configured HTTP edge with no logs is quiet.
for (const [name, projectId, type] of [
  ['web', 'many-tabs', 'web'],
  ['api', 'many-tabs', 'web'],
  ['pantry', 'pantry', 'web'],
  ['unmeasured', 'app:unmeasured', 'web'],
] as const) {
  store.saveDeployment({
    name,
    username: owner,
    type,
    ...(name === 'unmeasured' ? {} : { port: 19000 }),
  });
  store
    .getSqlite()!
    .prepare(
      'INSERT INTO project_applications(application,owner,project_id,configuration_migrated) VALUES(?,?,?,1)',
    )
    .run(name, owner, projectId);
}
const { compileDeployYaml } = await import('../../../server/application-spec.ts');
const privateSpec = compileDeployYaml(`apiVersion: deploy.local/v1
kind: Application
metadata: {name: unmeasured}
components:
  private:
    image: example/private:fixture
    role: service
    interfaces:
      data: {port: 9000, protocol: tcp}
`);
store.saveDesiredApplicationSpec({
  deploymentName: 'unmeasured',
  digest: privateSpec.digest,
  apiVersion: 'deploy.local/v1',
  source: 'ui',
  manifestFormat: 'generated',
  normalizedSpec: privateSpec.canonicalJson,
  createdBy: owner,
});
store.activateDesiredApplicationSpec('unmeasured', privateSpec.digest);
const pantry = await resolveProject(owner, 'pantry');
putProjectSettings(owner, pantry, {
  values: [
    { key: 'NODE_ENV', value: 'production' },
    { key: 'STRAVA_CLIENT_ID', value: '48120' },
  ],
});
putProjectSecret(owner, pantry, 'DATABASE_URL', { value: 'fixture-only' });
putProjectSecret(owner, pantry, 'STRAVA_CLIENT_SECRET', { value: 'fixture-only' });
save('pull-request', owner, {
  id: 'pull-1',
  projectId: 'many-tabs',
  number: 1,
  title: 'Keep project tabs mounted',
  body: 'Evidence for stable project navigation.',
  status: 'open',
  author: owner,
  sourceBranch: 'proposal',
  targetBranch: 'main',
  taskIds: [],
  issueIds: [],
  revision: 1,
  createdAt: at(3600_000),
  updatedAt: at(),
});
save('issue', owner, {
  id: 'issue-2',
  projectId: 'many-tabs',
  number: 2,
  title: 'Project page display polish',
  body: '',
  status: 'open',
  author: owner,
  taskIds: [],
  revision: 1,
  createdAt: at(3600_000),
  updatedAt: at(),
});
function release(projectId: string, commit: string, apps: string[], index: number) {
  const id = `${projectId}-release-${index}`;
  const release = {
    id,
    projectId,
    source: { kind: 'cli', ref: 'main', commit, message: 'Project pages evidence' },
    startedBy: owner,
    apps: apps.map((appId) => ({ appId, to: commit })),
    migrations: [],
    state: index === 2 ? 'live' : 'superseded',
    steps: ['prepare', 'verify', 'activate', 'watch'].map((name) => ({
      name,
      state: 'done',
      startedAt: at(index * 86400_000 + 60000),
      endedAt: at(index * 86400_000),
    })),
  };
  save('v2-release', owner, { id, release });
  if (index === 2)
    save('v2-project-current', owner, {
      id: projectId,
      releaseId: id,
      releasedAt: at(index * 86400_000),
    });
  return id;
}
for (const index of [1, 2]) {
  release('many-tabs', manyCommit, ['web', 'api'], index);
  release('pantry', pantryCommit, ['pantry'], index);
}
for (let index = 5; index >= 1; index--) {
  const id = `run-${index}`;
  save('pipeline-run', owner, {
    id,
    projectId: 'many-tabs',
    commit: manyCommit,
    branch: 'main',
    trigger: 'push',
    title: 'Keep project tabs mounted',
    status: index === 3 ? 'failed' : 'succeeded',
    specification: { publish: ['packages/router'] },
    packages: {
      status: 'succeeded',
      items: [
        {
          path: 'packages/router',
          name: 'react-flight-router',
          version: '0.12.2',
          previousVersion: '0.12.1',
          status: 'published',
        },
      ],
    },
    deployment: { status: 'succeeded', releaseId: 'many-tabs-release-2' },
    createdAt: at(index * 3600_000),
    completedAt: at(index * 3600_000 - 192000),
    updatedAt: at(),
  });
  for (const [jobIndex, name] of ['typecheck', 'test', 'flight-router-e2e'].entries())
    save('job', owner, {
      id: `${id}-${name}`,
      pipelineId: id,
      projectId: 'many-tabs',
      name,
      command: `pnpm ${name}`,
      status: index === 3 && jobIndex === 1 ? 'failed' : 'succeeded',
      workerId: null,
      requirements: {},
      startedAt: at(index * 3600_000),
      finishedAt: at(index * 3600_000 - 41000),
      createdAt: at(index * 3600_000),
      updatedAt: at(),
      output: 'Fixture job finished.\n',
    });
}
// Additional records for the dashboard-wide first-render proof.
store.ensureCoordinatorNode();
const { createAgent } = await import('../../../server/v2/agents.ts');
const dashboardAgent = createAgent(owner, {
  name: 'Dashboard keeper',
  looksAfter: [
    {
      id: 'weekly',
      what: 'Review dashboard health',
      where: 'all-active',
      when: { every: 'week', day: 1, time: '08:00', timezone: 'America/New_York' },
      brings: 'message',
      confirmedAt: at(86400_000),
    },
  ],
});
save('agent-message', owner, {
  id: 'dashboard-reply',
  agentId: dashboardAgent.id,
  event: {
    id: 'dashboard-reply',
    kind: 'reply',
    at: at(3600_000),
    agent: dashboardAgent.id,
    paragraphs: ['The dashboard is ready for review.'],
  },
});
for (const [id, projectId] of [
  ['dashboard-task', 'many-tabs'],
  ['standalone-task', undefined],
])
  save('task', owner, {
    id,
    projectId,
    title: 'Load dashboard data on the server',
    status: 'completed',
    revision: 1,
    baseRevision: manyCommit,
    workerId: 'fixture-worker',
    agentId: dashboardAgent.id,
    agentItemId: 'weekly',
    createdAt: at(3600_000),
    updatedAt: at(60000),
  });
for (const [id, name] of [
  ['dashboard-package', 'dashboard-fixture'],
  ['dashboard-scoped', '@fixture/dashboard'],
]) {
  store
    .getSqlite()!
    .prepare(
      'INSERT INTO packages(id,ecosystem,name,project_id,created_by,created_at) VALUES(?,?,?,?,?,?)',
    )
    .run(id, 'npm', name, 'many-tabs', owner, at());
  store
    .getSqlite()!
    .prepare(
      'INSERT INTO package_versions(package_id,version,sha256,integrity,size,manifest,published_by,published_via,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      '1.0.0',
      '0'.repeat(64),
      'sha512-fixture',
      0,
      JSON.stringify({ name, version: '1.0.0' }),
      owner,
      'person',
      at(),
    );
}
const { loadSupportedCatalog } = await import('../../../server/catalog/index.ts');
const blueprint = loadSupportedCatalog()[0];
const dashboardPages = [
  '/dashboard',
  '/dashboard/live',
  '/dashboard/live/web',
  '/dashboard/inbox',
  '/dashboard/inbox?tab=answered',
  '/dashboard/computers',
  '/dashboard/computers/coordinator',
  '/dashboard/computers/models',
  '/dashboard/computers/add',
  ...['', '/changes', '/checks', '/design'].map((tab) => `/dashboard/tasks/dashboard-task${tab}`),
  '/dashboard/tasks/standalone-task',
  '/dashboard/projects/many-tabs/pulls',
  '/dashboard/projects/many-tabs/pulls/pull-1',
  '/dashboard/projects/many-tabs/releases',
  '/dashboard/projects/many-tabs/releases/many-tabs-release-2',
  '/dashboard/agents',
  '/dashboard/agents/new',
  `/dashboard/agents/${dashboardAgent.id}`,
  `/dashboard/agents/${dashboardAgent.id}/tune`,
  `/dashboard/agents/${dashboardAgent.id}/items/weekly/history`,
  '/dashboard/design',
  '/dashboard/design?project=many-tabs&view=canvas',
  '/dashboard/packages',
  '/dashboard/packages?tab=copies',
  '/dashboard/packages?tab=setup',
  '/dashboard/packages/npm/dashboard-fixture',
  '/dashboard/packages/npm/@fixture/dashboard',
  '/dashboard/settings',
  '/dashboard/settings/approvals',
  '/dashboard/settings/backups',
  '/dashboard/settings/account',
  '/dashboard/settings/devices',
  '/dashboard/start',
  '/dashboard/start/project',
  '/dashboard/start/apps',
  '/dashboard/discover',
  ...(blueprint ? [`/dashboard/discover/${encodeURIComponent(blueprint.id)}`] : []),
];

const pages = {
  discover: '/dashboard/discover',
  list: '/dashboard/projects',
  code: '/dashboard/projects/many-tabs/code',
  apps: '/dashboard/projects/many-tabs?tab=apps',
  logs: '/dashboard/projects/many-tabs/logs',
  pullDetail: '/dashboard/projects/many-tabs/pulls/pull-1',
  requests: '/dashboard/projects/pantry/requests',
  performance: '/dashboard/projects/pantry/performance',
  appRequests: '/dashboard/projects/many-tabs/apps/web/requests',
  appPerformance: '/dashboard/projects/many-tabs/apps/web/performance',
  many: '/dashboard/projects/many-tabs',
  pulls: '/dashboard/projects/many-tabs/pulls',
  issues: '/dashboard/projects/many-tabs/issues',
  pipelines: '/dashboard/projects/many-tabs/pipelines',
  releases: '/dashboard/projects/many-tabs/releases',
  multiSettings: '/dashboard/projects/many-tabs/settings',
  appSettings: '/dashboard/projects/many-tabs/apps/web/settings',
  quiet: '/dashboard/projects/pantry',
  singleSettings: '/dashboard/projects/pantry/settings',
  oldSettings: '/dashboard/projects/pantry/apps/pantry/settings',
  notMeasured: '/dashboard/projects/app%3Aunmeasured',
  noMemoryLimit: '/dashboard/projects/pantry/settings',
  preparing: '/dashboard/projects/preparing/code',
  small: '/dashboard/projects/small',
};
console.log(
  JSON.stringify(
    {
      username: owner,
      token: account.token,
      pages,
      dashboardPages,
      cookieSignIn: {
        method: 'POST',
        path: '/api/v2/auth/session',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': owner,
          'x-deploy-token': account.token,
        },
        body: {},
        note: 'POST with the browser context request client before page.goto; it retains the validated HttpOnly cookie. Keep localStorage credentials for existing live API calls.',
      },
    },
    null,
    2,
  ),
);
db.close();
store._resetDb();
