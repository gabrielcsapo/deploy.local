import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, elements, uiStubs } from '../../../../../scripts/component-harness.mjs';
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node && typeof node === 'object'
      ? text(node.props?.children)
      : String(node ?? '');
test('one-app settings use singular release and secret copy and omit per-app scoping', async () => {
  const h = await componentHarness('app/routes/dashboard/v2/projects/settings.client.tsx', {
    '@/components/ui': uiStubs,
    './data': {
      useData: () => ({
        data: { values: [{ key: 'NODE_ENV', value: 'production', type: 'string' }] },
      }),
    },
    'react-flight-router/client': { useSearchParams: () => [new URLSearchParams()] },
    '../data/hooks': { useCoordinatorName: () => 'My computer' },
    '../data/time': { formatTime: () => '' },
    './repository-settings.client': { RepositorySettings: 'RepositorySettings' },
    './repository-connect.client': { NoRepository: 'NoRepository' },
  });
  const tree = h.render(h.exports.ProjectConfiguration, {
    project: { id: 'pantry', name: 'pantry', apps: [{ id: 'pantry', name: 'pantry' }] },
    overview: { repository: {} },
  });
  assert.match(
    text(tree),
    /Secrets are encrypted on My computer, and agents never see their values/,
  );
  assert.match(text(tree), /A release covers the app and its migrations/);
  assert.doesNotMatch(text(tree), /all apps/);
  h.dispose();
});
test('one-app runtime settings have no handoff notice and an unset limit is No limit', async () => {
  const h = await componentHarness('app/routes/dashboard/v2/projects/app.client.tsx', {
    '@/components/ui': uiStubs,
    './data': { useData: () => ({ data: { app: { summary: 'Stopped' } } }) },
    '../data/hooks': { useCoordinatorName: () => 'My computer' },
    '../live/data': { useLive: () => ({}) },
    '../live/page.client': { AppDetail: 'AppDetail' },
    './repository-connect.client': { NoRepository: 'NoRepository' },
  });
  const project = { id: 'pantry', apps: [{ id: 'pantry', name: 'pantry' }] };
  const tree = h.render(h.exports.AppSettings, {
    project,
    app: project.apps[0],
    overview: { apps: [{ id: 'pantry' }], repository: {} },
  });
  assert.equal(elements(tree, 'Banner').length, 0);
  assert.equal(
    elements(tree, 'Setting').find((node) => node.props.label === 'Memory limit').props.description,
    'Current limit: No limit',
  );
  h.dispose();
});
