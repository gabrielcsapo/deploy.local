import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentHarness,
  elements,
  uiStubs,
  settle,
} from '../../../../../scripts/component-harness.mjs';
test('Remove project dialog Cancel uses quiet styling and closes the dialog', async () => {
  const h = await componentHarness('app/routes/dashboard/v2/projects/settings.client.tsx', {
    '@/components/ui': uiStubs,
    './data': { useData: () => ({ data: { values: [] } }) },
    'react-flight-router/client': { useSearchParams: () => [new URLSearchParams()] },
    '../data/time': { formatTime: () => '' },
    './routing': { projectSegment: (id) => id },
    './repository-settings.client': { RepositorySettings: 'RepositorySettings' },
  });
  const render = () =>
    h.render(h.exports.ProjectConfiguration, {
      project: { id: 'gym', name: 'Gym', apps: [] },
      overview: {},
    });
  elements(render(), 'Action')
    .find((node) => node.props.children === 'Remove project')
    .props.onClick();
  let dialog = elements(render(), 'Dialog')[0];
  assert.equal(dialog.props.open, true);
  const cancel = elements(dialog.props.actions, 'Action')[0];
  assert.equal(cancel.props.variant, 'quiet');
  cancel.props.onClick();
  assert.equal(elements(render(), 'Dialog')[0].props.open, false);
});

const cases = [
  {
    count: 'one app',
    names: ['home-gym'],
    dialog: 'This would stop home-gym and free its addresses.',
    row: 'Stops the app and frees its addresses.',
  },
  {
    count: 'two apps',
    names: ['home-gym', 'home-gym-sync'],
    dialog: 'This would stop home-gym and home-gym-sync and free their addresses.',
    row: 'Stops the apps and frees their addresses.',
  },
  {
    count: 'no apps',
    names: [],
    dialog: 'This project has no apps to stop or addresses to free.',
    row: 'Removes the project. There are no apps to stop or addresses to free.',
  },
];
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node && typeof node === 'object'
      ? text(node.props?.children)
      : String(node ?? '');
for (const entry of cases) {
  for (const surface of ['dialog', 'row']) {
    test(`Remove project ${surface} uses approved wording for ${entry.count}`, async () => {
      const h = await componentHarness('app/routes/dashboard/v2/projects/settings.client.tsx', {
        '@/components/ui': uiStubs,
        './data': { useData: () => ({ data: { values: [] } }) },
        'react-flight-router/client': { useSearchParams: () => [new URLSearchParams()] },
        '../data/time': { formatTime: () => '' },
        './routing': { projectSegment: (id) => id },
        './repository-settings.client': { RepositorySettings: 'RepositorySettings' },
      });
      const project = {
        id: 'gym',
        name: 'Gym',
        apps: entry.names.map((name) => ({ id: name, name })),
      };
      const render = () => h.render(h.exports.ProjectConfiguration, { project, overview: {} });
      if (surface === 'row') {
        const row = elements(render(), 'Setting').find((node) => node.props.label === 'Remove Gym');
        assert.equal(row.props.description, `${entry.row} Backups stay for 30 days.`);
      } else {
        elements(render(), 'Action')
          .find((node) => node.props.children === 'Remove project')
          .props.onClick();
        const dialog = elements(render(), 'Dialog')[0];
        assert.equal(text(elements(dialog.props.children, 'p')[0]), entry.dialog);
        assert.equal(
          text(elements(dialog.props.children, 'p')[1]),
          'Backups stay for 30 days. A running release must finish first.',
        );
        const confirm = elements(dialog.props.children, 'Field')[0];
        assert.equal(elements(dialog.props.actions, 'Action')[1].props.disabled, true);
        confirm.props.onChange({ target: { value: 'Gym' } });
        assert.equal(
          elements(elements(render(), 'Dialog')[0].props.actions, 'Action')[1].props.disabled,
          false,
        );
      }
    });
  }
}

test('Remove project uses actual names and existing list formatting for more than two apps', async () => {
  const h = await componentHarness('app/routes/dashboard/v2/projects/settings.client.tsx', {
    '@/components/ui': uiStubs,
    './data': { useData: () => ({ data: { values: [] } }) },
    'react-flight-router/client': { useSearchParams: () => [new URLSearchParams()] },
    '../data/time': { formatTime: () => '' },
    './routing': { projectSegment: (id) => id },
    './repository-settings.client': { RepositorySettings: 'RepositorySettings' },
  });
  const project = {
    id: 'recipes',
    name: 'Recipes',
    apps: ['recipes', 'recipes-sync', 'recipes-jobs'].map((name) => ({ id: name, name })),
  };
  const render = () => h.render(h.exports.ProjectConfiguration, { project, overview: {} });
  elements(render(), 'Action')
    .find((node) => node.props.children === 'Remove project')
    .props.onClick();
  assert.equal(
    text(elements(elements(render(), 'Dialog')[0].props.children, 'p')[0]),
    'This would stop recipes, recipes-sync, recipes-jobs and free their addresses.',
  );
});

test('Docker error leaves the dialog open, confirmation retained and removal available for retry', async () => {
  const message =
    "Docker isn't running on this computer, so nothing was removed. Start it, then press Remove project.";
  const requests = [];
  const h = await componentHarness('app/routes/dashboard/v2/projects/settings.client.tsx', {
    '@/components/ui': uiStubs,
    './data': {
      useData: () => ({ data: { values: [] } }),
      request: async (path, init) => {
        requests.push({ path, ...init });
        throw new Error(message);
      },
    },
    'react-flight-router/client': { useSearchParams: () => [new URLSearchParams()] },
    '../data/time': { formatTime: () => '' },
    './routing': { projectSegment: (id) => id },
    './repository-settings.client': { RepositorySettings: 'RepositorySettings' },
  });
  const render = () =>
    h.render(h.exports.ProjectConfiguration, {
      project: { id: 'gym', name: 'Gym', apps: [{ id: 'home-gym', name: 'home-gym' }] },
      overview: {},
    });
  elements(render(), 'Action')
    .find((node) => node.props.children === 'Remove project')
    .props.onClick();
  let dialog = elements(render(), 'Dialog')[0];
  elements(dialog.props.children, 'Field')[0].props.onChange({ target: { value: 'Gym' } });
  dialog = elements(render(), 'Dialog')[0];
  elements(dialog.props.actions, 'Action')[1].props.onClick();
  await settle();
  dialog = elements(render(), 'Dialog')[0];
  assert.equal(dialog.props.open, true);
  assert.equal(elements(dialog.props.children, 'Field')[0].props.value, 'Gym');
  assert.equal(elements(dialog.props.children, 'Banner')[0].props.title, message);
  const remove = elements(dialog.props.actions, 'Action')[1];
  assert.equal(remove.props.disabled, false);
  assert.equal(remove.props.loading, false);
  assert.equal(requests.length, 1);
  remove.props.onClick();
  await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].body), { confirm: 'Gym' });
});
