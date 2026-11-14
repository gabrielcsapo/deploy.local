import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  componentHarness,
  elements,
  uiStubs,
  settle,
} from '../../../../../scripts/component-harness.mjs';
const project = { id: 'recipes-id', name: 'recipes', apps: [] };
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node && typeof node === 'object'
      ? text(node.props?.children)
      : String(node ?? '');
const hooks = {
  useCoordinatorName: () => 'Home computer',
  useResource: () => ({
    data: {
      computers: [
        {
          id: 'coordinator',
          name: 'unused',
          apps: [
            { appId: 'recipes', address: 'https://recipes.deploy.local' },
            { appId: 'pantry', address: 'https://pantry.deploy.local' },
          ],
        },
      ],
    },
  }),
};

test('Add an app lists eligible apps, marks the matching name and sends the selected app', async () => {
  const calls = [];
  let closed = 0,
    added = 0;
  const h = await componentHarness(
    'app/routes/dashboard/v2/projects/repository-connect.client.tsx',
    {
      '@/components/ui': uiStubs,
      '../data/hooks': hooks,
      './data': {
        useData: () => ({
          data: {
            apps: [
              { id: 'pantry', name: 'pantry' },
              { id: 'recipes', name: 'recipes' },
            ],
          },
        }),
        useBrowserHost: () => 'deploy.local',
        request: async (path, init) => calls.push({ path, ...init }),
      },
    },
  );
  const render = () =>
    h.render(h.exports.AddExistingAppDialog, {
      project,
      onClose: () => closed++,
      onAdded: () => added++,
    });
  const tree = render();
  const rows = elements(tree, 'Item');
  assert.deepEqual(
    rows.map((row) => row.props.title),
    ['recipes', 'pantry'],
  );
  assert.equal(
    rows[0].props.description,
    'recipes.deploy.local · on Home computer · same name as this project',
  );
  assert.equal(elements(tree, 'Dialog')[0].props.title, 'Add an app to recipes');
  elements(rows[0].props.end, 'Action')[0].props.onClick();
  await settle();
  assert.equal(calls[0].path, '/api/projects/recipes-id/apps');
  assert.deepEqual(JSON.parse(calls[0].body), { app: 'recipes' });
  assert.equal(closed, 1);
  assert.equal(added, 1);
});

test('Add repository uses the optional remote, keeps failure recoverable and navigates to the joined project', async () => {
  const calls = [],
    destinations = [];
  let fail = true;
  const h = await componentHarness(
    'app/routes/dashboard/v2/projects/repository-connect.client.tsx',
    {
      '@/components/ui': uiStubs,
      '../data/hooks': hooks,
      './data': {
        useData: () => ({}),
        useBrowserHost: () => 'deploy.local',
        request: async (path, init) => {
          calls.push({ path, ...init });
          if (fail) throw new Error('Try again');
          return { id: 'joined' };
        },
      },
    },
    { crypto: webcrypto, window: { location: { assign: (path) => destinations.push(path) } } },
  );
  const render = () =>
    h.render(h.exports.AddRepositoryDialog, {
      project: { ...project, id: 'app:recipes' },
      onClose() {},
    });
  let dialog = elements(render(), 'Dialog')[0];
  assert.equal(dialog.props.title, 'Add a repository to recipes');
  assert.match(text(dialog), /recipes keeps running as it is, and stays one project/);
  elements(dialog.props.actions, 'Action')[1].props.onClick();
  await settle();
  dialog = elements(render(), 'Dialog')[0];
  assert.equal(elements(dialog, 'Banner')[0].props.title, 'Try again');
  fail = false;
  elements(dialog.props.actions, 'Action')[1].props.onClick();
  await settle();
  assert.equal(calls[0].path, '/api/projects/app%3Arecipes/repository');
  assert.equal(JSON.parse(calls[0].body).sourcePath, '');
  assert.equal(JSON.parse(calls[0].body).operationId, JSON.parse(calls[1].body).operationId);
  assert.deepEqual(destinations, ['/dashboard/projects/joined']);
});

test('New project changes helper and action for an existing app and returns to ordinary creation for another name', async () => {
  const calls = [];
  const h = await componentHarness(
    'app/routes/dashboard/v2/projects/new-project.client.tsx',
    {
      '@/components/ui': uiStubs,
      '../data/hooks': hooks,
      './data': {
        useBrowserHost: () => 'deploy.local',
        useData: () => ({ data: { apps: [{ name: 'recipes' }] } }),
        request: async (path, init) => {
          calls.push({ path, ...init });
          return project;
        },
      },
    },
    { crypto: webcrypto },
  );
  const render = () =>
    h.render(h.exports.NewProjectDialog, { open: true, onClose() {}, onCreated() {} });
  elements(render(), 'Field')[0].props.onChange({ target: { value: 'recipes' } });
  let tree = render();
  assert.match(text(tree), /recipes is already an app here, with no repository/);
  assert.equal(
    elements(elements(tree, 'Dialog')[0].props.actions, 'Action')[1].props.children,
    'Add repository to recipes',
  );
  elements(tree, 'Field')[0].props.onChange({ target: { value: 'fresh' } });
  tree = render();
  assert.equal(
    elements(elements(tree, 'Dialog')[0].props.actions, 'Action')[1].props.children,
    'Create project',
  );
  elements(tree, 'Field')[0].props.onChange({ target: { value: 'recipes' } });
  tree = render();
  elements(elements(tree, 'Dialog')[0].props.actions, 'Action')[1].props.onClick();
  await settle();
  assert.equal(calls[0].path, '/api/projects');
  assert.equal(JSON.parse(calls[0].body).name, 'recipes');
});

test('empty repository push commands use its hosted address and the add-app line is conditional', async () => {
  let opened = 0;
  const h = await componentHarness('app/routes/dashboard/v2/projects/project-start.client.tsx', {
    '@/components/ui': uiStubs,
    './data': { useBrowserOrigin: () => 'https://deploy.local', request() {} },
    './code.client': { CopyButton: 'CopyButton' },
  });
  const props = {
    project,
    overview: { repository: { clonePath: '/recipes.git', defaultBranch: 'main' } },
  };
  let tree = h.render(h.exports.ProjectPushCode, props);
  assert.equal(
    elements(tree, 'pre')[0].props.children,
    'git remote add deploy https://deploy.local/recipes.git\ngit push deploy main',
  );
  assert.doesNotMatch(text(tree), /Already running it/);
  tree = h.render(h.exports.ProjectPushCode, { ...props, addApp: () => opened++ });
  assert.match(text(tree), /Already running it\? Add an app you shipped to this project\./);
  elements(tree, 'a')
    .find((node) => node.props.children === 'Add an app you shipped')
    .props.onClick({ preventDefault() {} });
  assert.equal(opened, 1);
});
