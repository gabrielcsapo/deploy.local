import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'deploy-product-ports-'));
process.env.DEPLOY_DATA_DIR = directory;
after(() => rmSync(directory, { recursive: true, force: true }));
const instructions = await import('./workspace/agent-instructions-port.ts');
const projects = await import('./workspace/repository-project-port.ts');
const preferences = await import('./workspace/collaboration-preferences-port.ts');
const merges = await import('./workspace/merge-permission-port.ts');
const designs = await import('./workspace/design-tool-port.ts');

for (const [name, require] of [
  ['AgentInstructionsSource', instructions.requireAgentInstructionsSource],
  ['RepositoryProjectCreator', projects.requireRepositoryProjectCreator],
  ['CollaborationPreferencesSource', preferences.requireCollaborationPreferencesSource],
  ['MergePermissionSource', merges.requireMergePermissionSource],
  ['WorkspaceDesignTool', designs.requireWorkspaceDesignTool],
] as const)
  test(`unwired ${name} names the port and process`, () => {
    assert.throws(() => require('test process'), {
      message: `${name} is not wired in test process`,
    });
  });

test('the five ports preserve their real providers and results', async () => {
  await import('./test-ports.ts');
  const { agentInstructions } = await import('./v2/agent-instructions.ts');
  const { createRepositoryProject } = await import('./v2/projects.ts');
  const { preferences: directPreferences, updatePreferences } = await import('./v2/auth-store.ts');
  const { isAllowed } = await import('./v2/releases.ts');
  const { designTool } = await import('./v2/design.ts');
  const { save } = await import('./workspace/store.ts');
  const owner = 'product-port-owner';
  save('agent', owner, {
    id: 'agent',
    name: 'Agent',
    job: 'Inspect the repository',
    computers: [],
  });
  const task = { agentId: 'agent', createdAt: '2026-01-02T00:00:00.000Z' };
  assert.equal(instructions.requireAgentInstructionsSource('test'), agentInstructions);
  assert.equal(
    instructions.requireAgentInstructionsSource('test')(owner, task),
    agentInstructions(owner, task),
  );
  const { registerUser } = await import('./store.ts');
  registerUser(owner, 'product-port-test-password');
  updatePreferences(owner, { name: 'Port Owner' });
  assert.equal(preferences.requireCollaborationPreferencesSource('test'), directPreferences);
  assert.deepEqual(
    preferences.requireCollaborationPreferencesSource('test')(owner),
    directPreferences(owner),
  );
  assert.equal(projects.requireRepositoryProjectCreator('test'), createRepositoryProject);
  const input = { operationId: 'port-project', name: 'Port project' };
  await projects.requireRepositoryProjectCreator('test')(owner, input, 'signature');
  const project = await projects.requireRepositoryProjectCreator('test')(owner, input, 'signature');
  assert.deepEqual(project, await createRepositoryProject(owner, input, 'signature'));
  const allowed = await merges.requireMergePermissionSource('test')();
  assert.equal(allowed, isAllowed);
  assert.equal(
    allowed(owner, 'agent', 'merge', project.id),
    isAllowed(owner, 'agent', 'merge', project.id),
  );
  const { createProject } = await import('./workspace/test-repository.ts');
  const readyProject = createProject(owner, { name: 'Design ports' });
  save('task', owner, { id: 'design-task', projectId: readyProject.id });
  const scope = { owner, taskId: 'design-task' };
  const args = { action: 'presence' };
  assert.deepEqual(
    await designs.requireWorkspaceDesignTool('test')(scope, args),
    await designTool(scope, args),
  );
});

function child(code: string) {
  const data = mkdtempSync(join(tmpdir(), 'deploy-port-child-'));
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, DEPLOY_DATA_DIR: data, DEPLOY_MDNS_ADDRESS: '127.0.0.1' },
      encoding: 'utf8',
      timeout: 30000,
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}
const trackModules = `
  import assert from 'node:assert/strict';
  import { registerHooks } from 'node:module';
  const loaded = new Set();
  registerHooks({ load(url, context, next) {
    const result = next(url, context);
    loaded.add(url);
    return result;
  }});
  const has = (path) => loaded.has(new URL(path, import.meta.url).href);
`;

for (const product of ['design', 'releases'])
  test(`${product} is absent after lazy wiring and loaded only on the first call`, () => {
    child(`${trackModules}
      const { wireWorkspaceLazyTools } = await import('./server/main/workspace-lazy-tools.ts');
      wireWorkspaceLazyTools();
      assert.equal(has('./server/v2/design.ts'), false);
      assert.equal(has('./server/v2/releases.ts'), false);
      ${
        product === 'design'
          ? `
        const { requireWorkspaceDesignTool } = await import('./server/workspace/design-tool-port.ts');
        await assert.rejects(requireWorkspaceDesignTool('child')({ owner: 'absent', taskId: 'absent' }, {}), /Not found/);
      `
          : `
        const { requireMergePermissionSource } = await import('./server/workspace/merge-permission-port.ts');
        const check = await requireMergePermissionSource('child')();
        assert.equal(check('owner', 'agent', 'merge', 'project'), false);
      `
      }
      assert.equal(has('./server/v2/${product}.ts'), true);
    `);
  });

const entries = [
  {
    entry: 'server/boot.ts',
    marker: '/** Serves the pages',
    wire: 'wireServerWorkspacePorts();',
    wired: [true, true, true, true],
    eager: [true, true],
  },
  {
    entry: 'server/workspace/repository-worker.ts',
    marker: '// Git storage service only.',
    wire: '',
    wired: [false, false, false, false],
    eager: [false, false],
  },
  {
    entry: 'server/workspace/pipeline-worker.ts',
    marker: "claimWorker('pipelines');",
    wire: '',
    wired: [false, false, false, false],
    eager: [false, false],
  },
  {
    entry: 'server/workspace/worker.ts',
    marker: 'wireAgentInstructionsSource();',
    wire: 'wireAgentInstructionsSource(); wireLocalWorkerTools(); wireLocalWorkerMedia();',
    wired: [true, false, true, true],
    eager: [false, true],
  },
  {
    entry: 'server/workspace/preview.ts',
    marker: 'wirePreviewWorkspaceTools();',
    wire: 'wirePreviewWorkspaceTools(); wireRepositoryProjectCreator();',
    wired: [true, true, true, true],
    eager: [false, false],
  },
];
for (const { entry, marker, wire, wired, eager } of entries)
  test(`${entry} composition wires exactly its callable ports, preserving lazy module loads`, () => {
    // Run the real static imports and wiring in a fresh process, stopping before the entry's
    // first executable work. No listener, lease, timer, recovery or worker tick is started.
    child(`${trackModules}
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (url === new URL(${JSON.stringify('./' + entry)}, import.meta.url).href) {
          const text = String(result.source);
          const end = text.indexOf(${JSON.stringify(marker)});
          assert.ok(end >= 0);
          return { ...result, source: text.slice(0, end) + ${JSON.stringify(wire)} };
        }
        return result;
      }});
      await import(${JSON.stringify('./' + entry)});
      const getters = [
        (await import('./server/workspace/agent-instructions-port.ts')).requireAgentInstructionsSource,
        (await import('./server/workspace/repository-project-port.ts')).requireRepositoryProjectCreator,
        (await import('./server/workspace/collaboration-preferences-port.ts')).requireCollaborationPreferencesSource,
        (await import('./server/workspace/design-tool-port.ts')).requireWorkspaceDesignTool,
        (await import('./server/workspace/merge-permission-port.ts')).requireMergePermissionSource,
      ];
      const expected = ${JSON.stringify([...wired, wired[3]])};
      getters.forEach((get, i) => {
        if (expected[i]) assert.equal(typeof get(${JSON.stringify(entry)}), 'function');
        else assert.throws(() => get(${JSON.stringify(entry)}), /is not wired in/);
      });
      assert.deepEqual([has('./server/v2/design.ts'), has('./server/v2/releases.ts')], ${JSON.stringify(eager)});
      if (expected[3]) {
        await assert.rejects(getters[3]('child')({ owner: 'absent', taskId: 'absent' }, {}), /Not found/);
        assert.equal(has('./server/v2/design.ts'), true);
        const check = await getters[4]('child')();
        assert.equal(typeof check, 'function');
        assert.equal(has('./server/v2/releases.ts'), true);
      }
    `);
  });
