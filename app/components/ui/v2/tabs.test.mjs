import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from '../../../../scripts/component-harness.mjs';
test('selected tab scrolls within its strip and overflow fades only while more tabs follow', async () => {
  let update;
  const nav = {
    scrollLeft: 0,
    scrollWidth: 600,
    clientWidth: 300,
    getBoundingClientRect: () => ({ left: 0, right: 300 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 400, right: 500 }) }),
    addEventListener: (_, callback) => {
      update = callback;
    },
    removeEventListener() {},
  };
  const h = await componentHarness(
    'app/components/ui/v2/Tabs.tsx',
    {
      'react-flight-router/client': { Link: 'a' },
      './shared': { stateProps: () => ({}) },
    },
    {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    },
  );
  const props = { items: [{ label: 'Pull requests', href: '/pulls', count: 1 }], value: '/pulls' };
  const render = () => h.render(h.exports.Tabs, props);
  render().props.ref.current = nav;
  h.effects();
  assert.equal(nav.scrollLeft, 232);
  assert.equal(render().props['data-more'], true);
  nav.scrollLeft = 300;
  update();
  assert.equal(render().props['data-more'], false);
  h.dispose();
});
