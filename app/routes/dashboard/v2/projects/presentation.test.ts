import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  orderUnlinkedApps,
  projectCardFact,
  projectListSummary,
  projectRuntime,
  rankLiveProjects,
  repositoryRowFact,
  requestsToday,
  showLabel,
  sparkPoints,
} from './presentation.ts';
import { projectListOptions, projectListPath } from '../../../../../shared/v2/project-list.ts';
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

test('live projects that need you come first and otherwise keep the order they arrived in', () => {
  const runs = (name: string): Project => ({
    id: name,
    name,
    apps: [{ id: name, name, kind: 'web' }],
  });
  const state = live([
    { ...app, appId: 'calm', name: 'calm' },
    { ...app, appId: 'stopped', name: 'stopped', state: 'stopped' },
    { ...app, appId: 'broken', name: 'broken', state: 'failing' },
    { ...app, appId: 'quiet', name: 'quiet' },
  ]);
  assert.deepEqual(
    rankLiveProjects(['calm', 'stopped', 'broken', 'quiet'].map(runs), state, 'SER').map(
      (project) => project.name,
    ),
    ['broken', 'stopped', 'calm', 'quiet'],
  );
});

test('the list says what it holds, what is ticked and one fact per project', () => {
  const counts = { live: 7, repositories: 15, archived: 1 };
  assert.equal(projectListSummary(counts, 1), '7 live, 1 failing · 15 repositories');
  assert.equal(projectListSummary({ ...counts, repositories: 1 }, 0), '7 live · 1 repository');
  assert.equal(projectListSummary({ live: 0, repositories: 0, archived: 2 }, 0), '');
  assert.equal(showLabel(['live', 'repositories']), 'Live and repositories');
  assert.equal(showLabel(['archived', 'live']), 'Live and archived');
  assert.equal(showLabel(['archived']), 'Archived');
  assert.equal(showLabel(['live', 'repositories', 'archived']), 'All projects');
  const base: Project = { id: 'gym', name: 'gym', apps: [], stage: 'active' };
  assert.equal(projectCardFact({ ...base, openPulls: 1, stage: 'maintained' }), '1 PR open');
  assert.equal(projectCardFact({ ...base, stage: 'maintained' }, '3 days ago'), 'Maintained');
  assert.equal(projectCardFact({ ...base, id: 'app:gym' }), 'Shipped from a folder');
  assert.equal(projectCardFact(base, '2 hours ago'), 'Changed 2 hours ago');
  assert.equal(projectCardFact(base), '');
  assert.equal(
    repositoryRowFact({ ...base, openPulls: 2 }, '6 hours ago'),
    '2 PRs open · 6 hours ago',
  );
  assert.equal(repositoryRowFact(base, '4 days ago'), '4 days ago');
  assert.equal(repositoryRowFact(base), '');
});

test('a card counts requests since midnight and draws the last 24 hours', () => {
  const hour = 3_600_000;
  const midnight = 240 * hour;
  // Twenty-four hours ending 10 hours after midnight: 14 of them were yesterday.
  const traffic = { from: midnight - 14 * hour, hourly: new Array(24).fill(100) };
  assert.equal(requestsToday(traffic, midnight), '1,000 requests today');
  assert.equal(
    requestsToday({ from: midnight, hourly: [1, ...new Array(23).fill(0)] }, midnight),
    '1 request today',
  );
  assert.equal(
    requestsToday({ ...traffic, hourly: new Array(24).fill(0) }, midnight),
    'No requests today',
  );
  assert.equal(sparkPoints([0, 0, 0]), '0,36 55,36 110,36');
  assert.equal(sparkPoints([0, 5, 10]), '0,36 55,21 110,6');
});

test('the page and the server build the same list address', () => {
  assert.equal(projectListPath(), '/api/projects?view=list&show=live,repositories&limit=6');
  const path = projectListPath(['archived', 'live'], ' gym & co ', 26);
  assert.equal(path, '/api/projects?view=list&show=live,archived&limit=26&q=gym%20%26%20co');
  assert.deepEqual(projectListOptions(new URL(path, 'http://localhost').searchParams), {
    show: ['live', 'archived'],
    query: 'gym & co',
    limit: 26,
  });
  assert.deepEqual(projectListOptions(new URLSearchParams('view=list&show=nonsense')), {
    show: [],
    query: '',
    limit: 6,
  });
});
