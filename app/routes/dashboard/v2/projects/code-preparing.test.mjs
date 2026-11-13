import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, elements, uiStubs } from '../../../../../scripts/component-harness.mjs';
test('a preparing repository without refs keeps the existing repository setup error and Retry', async () => {
  const reason = 'Repository is not ready; inspect its setup operation';
  const h = await componentHarness('app/routes/dashboard/v2/projects/code.client.tsx', {
    '@/components/ui': uiStubs,
    'react-flight-router/client': { useSearchParams: () => [new URLSearchParams()] },
    'react-markdown': { default: 'Markdown' },
    'remark-gfm': { default: () => {} },
    'rehype-highlight': { default: () => {} },
    './data': {
      useBrowserOrigin: () => 'https://deploy.local',
      useData: (path) => ({
        data: path?.endsWith('/repository') ? { status: 'preparing' } : undefined,
        error: path?.includes('/tree?') ? reason : '',
        refresh() {},
      }),
    },
  });
  const tree = h.render(h.exports.ProjectCode, {
    overview: {
      project: { id: 'preparing', name: 'Preparing' },
      repository: { status: 'preparing' },
    },
  });
  assert.equal(elements(tree, 'Banner')[0].props.title, reason);
  assert.equal(
    elements(elements(tree, 'Banner')[0].props.action, 'Action')[0].props.children,
    'Retry',
  );
  h.dispose();
});
