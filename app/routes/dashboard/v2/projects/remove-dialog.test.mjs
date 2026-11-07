import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, elements, uiStubs } from '../../../../../scripts/component-harness.mjs';
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
