import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, elements, uiStubs } from '../../../../../scripts/component-harness.mjs';
test('compact run selector opens the list and selecting a run closes it without losing the count', async () => {
  const runs = ['one', 'two'].map((id) => ({
    id,
    commit: '1234567890',
    status: 'succeeded',
    trigger: 'push',
  }));
  const h = await componentHarness('app/routes/dashboard/v2/projects/pipelines.client.tsx', {
    '@/components/ui': uiStubs,
    './data': {
      useData: (path) => ({
        data: path.endsWith('/pipelines')
          ? { runs }
          : { pipeline: runs.find((run) => path.endsWith(run.id)), jobs: [] },
        refresh() {},
      }),
    },
    '../data/time': { formatTime: () => 'Today' },
  });
  const render = () => h.render(h.exports.ProjectPipelines, { projectId: 'gym' });
  const selector = () => elements(render(), 'button').find((node) => node.props['aria-controls']);
  assert.equal(selector().props['aria-expanded'], false);
  selector().props.onClick();
  assert.equal(selector().props['aria-expanded'], true);
  const list = elements(render(), 'nav')[0];
  elements(list, 'button')[1].props.onClick();
  assert.equal(selector().props['aria-expanded'], false);
  assert.equal(elements(elements(render(), 'nav')[0], 'button')[1].props['aria-current'], 'true');
  assert.equal(
    elements(selector(), 'span').find(
      (node) => node.props.className === 'dl-meta' && node.props.children[1] === ' runs',
    ).props.children[0],
    2,
  );
  h.dispose();
});
