import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspaceTask,
  workspaceState,
  rollbackProject,
  projectReleases,
  answerInbox,
} from '../bin/cli-contracts.mjs';
import { workspaceFixture } from './v2/workspace-contract-fixtures.ts';

test('checked CLI boundary preserves workspace and v2 paths, payloads and response envelopes', async () => {
  const calls: { path: string; options?: { method?: string; body?: string } }[] = [];
  const api = async (path: string, options?: { method?: string; body?: string }) => {
    calls.push({ path, options });
    return path === '/api/workspace/state' ? workspaceFixture.state : workspaceFixture.detail.task;
  };
  assert.equal(await workspaceState(api), workspaceFixture.state);
  assert.equal(
    await createWorkspaceTask(api, 'Build', 'mac', 'operation'),
    workspaceFixture.detail.task,
  );
  await projectReleases(api, 'a/b');
  await rollbackProject(api, 'a/b', 'old', 'current');
  await answerInbox(api, 'question:one', 'yes');
  assert.deepEqual(calls, [
    { path: '/api/workspace/state', options: undefined },
    {
      path: '/api/workspace/tasks',
      options: {
        method: 'POST',
        body: JSON.stringify({
          title: 'Build',
          prompt: 'Build',
          workerId: 'mac',
          operationId: 'operation',
        }),
      },
    },
    { path: '/api/v2/projects/a%2Fb/releases', options: undefined },
    {
      path: '/api/v2/projects/a%2Fb/rollback',
      options: { method: 'POST', body: JSON.stringify({ to: 'old', from: 'current' }) },
    },
    {
      path: '/api/v2/inbox/question%3Aone/answer',
      options: { method: 'POST', body: JSON.stringify({ actionId: 'yes', on: 'cli' }) },
    },
  ]);
});
