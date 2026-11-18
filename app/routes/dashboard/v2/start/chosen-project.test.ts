import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  branchRef,
  chosenProject,
  newTaskIn,
  newTaskOnBranch,
  projectParameter,
} from './chosen-project.ts';

const projects = [
  { id: 'deploy-local', name: 'deploy.local' },
  { id: 'home-gym', name: 'home-gym' },
];

test('a project heading’s + opens the start page with that project chosen', () => {
  const link = new URL(newTaskIn('home-gym'), 'http://127.0.0.1');
  assert.equal(link.pathname, '/dashboard');
  const id = projectParameter(link.pathname, link.search);
  assert.equal(id, 'home-gym');
  assert.deepEqual(chosenProject(id, projects), { id: 'home-gym', name: 'home-gym' });
});

test('without the parameter, or for an unknown project, New task is unchanged', () => {
  assert.equal(projectParameter('/dashboard', ''), null);
  assert.equal(chosenProject(null, projects), null);
  assert.equal(chosenProject(projectParameter('/dashboard', '?project=removed'), projects), null);
  assert.equal(chosenProject('home-gym', undefined), null);
  // Only the start page reads it.
  assert.equal(projectParameter('/dashboard/tasks/abc', '?project=home-gym'), null);
});

test('the start page sends the chosen project with the first message, and only then', async () => {
  const { submitMessage } = await import('../markup/client.ts');
  const previous = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ taskId: 'new', runId: 'run' });
  }) as typeof fetch;
  try {
    const message = { text: 'Add a calmer header', attachments: [] };
    await submitMessage(message, undefined, undefined, 'home-gym');
    await submitMessage(message);
    assert.deepEqual(bodies, [{ ...message, projectId: 'home-gym' }, { ...message }]);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a pull request starts a task on its branch with the first message begun', async () => {
  const link = new URL(
    newTaskOnBranch('deploy-local', 'build/project-work', 'On build/project-work: '),
    'http://127.0.0.1',
  );
  assert.equal(projectParameter(link.pathname, link.search), 'deploy-local');
  assert.equal(link.searchParams.get('ask'), 'On build/project-work: ');
  assert.equal(branchRef(link.search), 'refs/heads/build/project-work');
  assert.equal(branchRef(new URL(newTaskIn('deploy-local'), 'http://127.0.0.1').search), undefined);
  const { submitMessage } = await import('../markup/client.ts');
  const previous = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ taskId: 'new', runId: 'run' });
  }) as typeof fetch;
  try {
    const message = { text: 'Merge main', attachments: [] };
    await submitMessage(message, undefined, undefined, 'deploy-local', 'refs/heads/b');
    // A ref means nothing without a project, so it is not sent alone.
    await submitMessage(message, undefined, undefined, undefined, 'refs/heads/b');
    assert.deepEqual(bodies, [
      { ...message, projectId: 'deploy-local', ref: 'refs/heads/b' },
      { ...message },
    ]);
  } finally {
    globalThis.fetch = previous;
  }
});
