import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-design-needs-'));
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
await import('../test-ports.ts');
const { get, save, list, now } = await import('../workspace/store.ts');
const { createProject, createTask } = await import('../workspace/test-repository.ts');
const { git } = await import('../workspace/service.ts');
const { askTools, recordToolAnswers } = await import('../workspace/tool-probes.ts');
const { designBuildBrief, designTool, landDesignApprovals, requestDesignBuild } =
  await import('./design.ts');

function fixture(width: number | null, meta = '', proposer = false) {
  const owner = randomUUID();
  const source = mkdtempSync(join(tmpdir(), 'design-needs-source-'));
  mkdirSync(join(source, 'design/boards'), { recursive: true });
  writeFileSync(
    join(source, 'design/boards/Screen.html'),
    `${meta}<p data-layer="copy">Screen</p>`,
  );
  writeFileSync(
    join(source, 'design/canvas.json'),
    JSON.stringify({
      boards: width ? { 'Screen.html': { x: 0, y: 0, w: width, h: 800 } } : {},
      order: ['Screen.html'],
      notes: {},
    }),
  );
  git(source, ['init', '--initial-branch=main']);
  git(source, ['add', '.']);
  git(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Design',
  ]);
  const commit = git(source, ['rev-parse', 'HEAD']);
  const project = createProject(owner, { name: 'Phone design', sourcePath: source });
  const task = proposer ? createTask(owner, { projectId: project.id, title: 'Proposer' }) : null;
  const id = randomUUID();
  const landing = { id, state: 'landed', commit };
  save('worker', owner, { id: 'local', name: 'Test computer', heartbeat: now() });
  save('design-review-landing', owner, landing);
  save('v2-inbox-native', owner, {
    id,
    item: {
      id,
      title: 'Approved screen',
      actions: [{ id: 'approve' }, { id: 'update' }],
      state: 'answered',
      from: { name: 'Owner' },
      answer: { actionId: 'approve', at: now() },
    },
    context: {
      source: 'design',
      projectId: project.id,
      commit,
      main: 'main',
      paths: ['design/boards/Screen.html'],
      ...(task ? { taskId: task.id } : {}),
    },
  });
  return { owner, project, landing, proposer: task };
}

test('requested design builds start at every board size and reuse their proposer', async () => {
  for (const proposer of [false, true]) {
    for (const [width, meta] of [
      [390, ''],
      [null, "<meta content='width=500 height=800' name='design-board'>"],
      [1440, ''],
    ] as const) {
      const f = fixture(width, meta, proposer);
      await landDesignApprovals();
      assert.equal(get('design-review-landing', f.owner, f.landing.id).build, undefined);
      const build = requestDesignBuild(
        f.owner,
        f.project.id,
        f.landing.id,
        proposer ? 'proposer' : 'new',
      );
      assert.equal(build.started, !proposer, JSON.stringify(build));
      const task = get('task', f.owner, build.taskId);
      assert.equal(task.needs, undefined);
      assert.equal(task.workerId, 'local');
      assert.notEqual(task.status, 'waiting');
      if (proposer) assert.equal(task.id, f.proposer?.id);
      await landDesignApprovals();
      assert.equal(list('task', f.owner).length, 1, 'repeated scans reuse the builder');
      assert.equal(list('tool-probe', f.owner).length, 0);
      await designTool({ owner: f.owner, taskId: task.id }, { action: 'built', state: 'matches' });
      assert.equal(get('design-review-built', f.owner, f.landing.id).state, 'matches');
    }
  }
});

test('the build brief asks the agent to declare its programs as its first step', () => {
  const brief = designBuildBrief({ title: 'Screen', commit: '12345678', main: 'main', paths: [] });
  assert.match(brief, /Before starting, use deploy_require_tools as your first step/);
});

test('matches requires this reporting computer to confirm every stated program; differs stays accepted', async () => {
  const f = fixture(390);
  await landDesignApprovals();
  const taskId = requestDesignBuild(f.owner, f.project.id, f.landing.id, 'new').taskId;
  const needs = ['custom-compiler', 'asset-tool'];
  save('task', f.owner, {
    ...get('task', f.owner, taskId),
    needs: { tools: needs },
    workerId: 'unconfirmed',
  });
  save('worker', f.owner, {
    id: 'unconfirmed',
    name: 'Unconfirmed',
    heartbeat: now(),
    capabilities: needs,
  });
  const scope = { owner: f.owner, taskId };
  await assert.rejects(
    () => designTool(scope, { action: 'built', state: 'matches' }),
    /has not confirmed all the programs/,
  );
  askTools(f.owner, 'unconfirmed', needs);
  recordToolAnswers(f.owner, 'unconfirmed', { 'custom-compiler': true });
  await assert.rejects(
    () => designTool(scope, { action: 'built', state: 'matches' }),
    /has not confirmed all the programs/,
  );
  recordToolAnswers(f.owner, 'unconfirmed', { 'asset-tool': false });
  await assert.rejects(
    () => designTool(scope, { action: 'built', state: 'matches' }),
    /has not confirmed all the programs/,
  );
  await designTool(scope, {
    action: 'built',
    state: 'differs',
    differences: 1,
    text: 'Comparison still needed',
  });
  assert.equal(get('design-review-built', f.owner, f.landing.id).state, 'differs');
  askTools(f.owner, 'confirmed', needs);
  recordToolAnswers(f.owner, 'confirmed', { 'custom-compiler': true, 'asset-tool': true });
  save('run', f.owner, { id: 'reporting-run', taskId, workerId: 'confirmed' });
  await designTool({ ...scope, runId: 'reporting-run' }, { action: 'built', state: 'matches' });
  assert.equal(get('design-review-built', f.owner, f.landing.id).state, 'matches');
});
