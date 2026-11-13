import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { orderUnlinkedApps, projectRuntime } from './presentation.ts';
import { NoRepository } from './repository-connect.client.tsx';
import type { LiveApp, LiveResponse, Project } from '../../../../../shared/v2/contracts.ts';
const app: LiveApp = {
  appId: 'pantry',
  name: 'pantry',
  kind: 'web',
  state: 'healthy',
  summary: 'GET / 200',
  address: 'https://pantry.deploy.local',
};
const project: Project = {
  id: 'app:pantry',
  name: 'pantry',
  apps: [{ id: 'pantry', name: 'pantry', kind: 'web' }],
};
function live(apps: LiveApp[], remote: LiveApp[] = []): LiveResponse {
  return {
    summary: { running: apps.length, failing: 0, warning: 0, checkedAt: '' },
    computers: [
      { id: 'coordinator', name: 'unused', roles: ['coordinator'], online: true, apps },
      { id: 'remote', name: 'imac', roles: ['run-apps'], online: true, apps: remote },
    ],
  };
}
test('project rows show the address and coordinator name supplied by the dashboard', () => {
  assert.deepEqual(projectRuntime(project, live([app]), 'My computer'), {
    kind: 'healthy',
    label: 'Healthy',
    where: 'pantry.deploy.local · My computer',
  });
  assert.deepEqual(projectRuntime({ ...project, apps: [] }, undefined, 'My computer'), {
    label: 'Not deployed',
  });
  assert.deepEqual(projectRuntime(project, undefined, 'My computer'), {
    label: 'Health unavailable',
  });
  assert.equal(
    projectRuntime(project, live([{ ...app, state: 'stopped' }]), 'My computer').where,
    'Stopped',
  );
});
test('multi-app projects aggregate Live health and distinct computers', () => {
  const worker: LiveApp = { ...app, appId: 'jobs', name: 'jobs', kind: 'worker', state: 'failing' };
  const multiple: Project = {
    ...project,
    apps: [...project.apps, { id: 'jobs', name: 'jobs', kind: 'worker' }],
  };
  assert.deepEqual(projectRuntime(multiple, live([app], [worker]), 'My computer'), {
    kind: 'failed',
    label: '1 failing',
    where: '2 apps · My computer and imac',
  });
  assert.equal(
    projectRuntime(multiple, live([app, worker]), 'My computer').where,
    '2 apps · My computer',
  );
  assert.equal(
    projectRuntime(
      project,
      live([{ ...app, state: 'warning', summary: 'High memory' }]),
      'My computer',
    ).label,
    'High memory',
  );
});
test('the picker sorts the exact matching name first without mutating its input', () => {
  const apps: Project['apps'] = [{ id: 'a', name: 'alpha', kind: 'web' }, ...project.apps];
  assert.deepEqual(
    orderUnlinkedApps(apps, 'pantry').map((row) => row.name),
    ['pantry', 'alpha'],
  );
  assert.equal(apps[0].name, 'alpha');
});
test('the repository row uses the approved board copy and renders without a browser', () => {
  const html = renderToStaticMarkup(createElement(NoRepository, { project }));
  assert.match(html, /Repository/);
  assert.match(html, /No repository/);
  assert.match(
    html,
    /pantry was shipped from a folder\. Add a repository to start tasks on it, review pull requests and release from merges\./,
  );
  assert.match(html, />Add a repository<\/button>/);
});
