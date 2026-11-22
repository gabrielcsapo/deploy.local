import assert from 'node:assert/strict';
import test from 'node:test';
import { node, values } from '../../../scripts/mobile-web-cascade.mjs';
import { componentHarness, elements } from '../../../scripts/component-harness.mjs';
const css = ['app/components/ui/v2/components.css', 'app/routes/dashboard/v2-shell.css'];
test('shell hides sidebar and rail, and reveals menu at 820px and below', () => {
  for (const width of [1440, 900, 821, 820, 700, 390]) {
    const root = node('dl-app dl-rail-shell');
    const side = node('dl-side', root);
    const rail = node('dz-rail', root);
    const main = node('dl-main', root);
    const head = node('dl-head', main, 'header');
    const menu = node('dl-icon-btn dl-menu-btn', head, 'button');
    assert.equal(
      values(side, width, css).display,
      width <= 820 ? 'none' : 'flex',
      `${width}px sidebar`,
    );
    assert.equal(
      values(rail, width, css).display,
      width <= 820 ? 'none' : 'flex',
      `${width}px rail`,
    );
    assert.equal(
      values(menu, width, css).display,
      width <= 820 ? 'inline-flex' : 'none',
      `${width}px menu`,
    );
  }
});
test('compact Mac header reserves traffic lights, except in fullscreen', () => {
  for (const fullscreen of [false, true]) {
    const desktop = node(`deploy-desktop-mac${fullscreen ? ' deploy-desktop-fullscreen' : ''}`);
    const root = node('dl-app dl-rail-shell', desktop);
    const head = node('dl-head', node('dl-main', root), 'header');
    const menu = node('dl-icon-btn dl-menu-btn', head, 'button');
    assert.equal(values(head, 820, css)['padding-left'], fullscreen ? '8px' : '100px');
    assert.equal(values(menu, 820, css)['-webkit-app-region'], 'no-drag');
  }
});
test('compact Mac task header keeps its menu button clear of the traffic lights', () => {
  const taskCss = [...css, 'app/routes/dashboard/v2/tasks/style.css'];
  for (const fullscreen of [false, true]) {
    const desktop = node(`deploy-desktop-mac${fullscreen ? ' deploy-desktop-fullscreen' : ''}`);
    const main = node('dl-main', node('dl-app dl-rail-shell', desktop));
    const head = node('dl-task-head', node('dl-task-main', node('dl-task-layout', main)), 'header');
    const wrap = node('dl-task-wrap', head);
    assert.equal(values(wrap, 820, taskCss)['padding-left'], fullscreen ? undefined : '100px');
    assert.equal(values(wrap, 1440, taskCss)['padding-left'], undefined);
  }
});
async function shell() {
  const target = new EventTarget();
  const media = new EventTarget();
  media.matches = true;
  let desktopToggles = 0;
  class Element {
    focused = 0;
    focus() {
      this.focused++;
    }
  }
  const trigger = new Element();
  const h = await componentHarness(
    'app/routes/dashboard/v2-layout.client.tsx',
    {
      'react-flight-router/client': {
        useLocation: () => ({ pathname: '/dashboard/live' }),
        Outlet: 'Outlet',
      },
      '@/components/ui': { Head: 'Head', IconButton: 'IconButton' },
      '@/components/ui/v2/AgentAvatar': { AgentAvatar: 'AgentAvatar' },
      './v2/data/time': { formatTime: () => '' },
      './v2/data/hooks': {
        useResource: () => ({}),
        useInbox: () => ({ items: [] }),
        InboxProvider: 'InboxProvider',
        WorkspaceContext: { Provider: 'WorkspaceProvider' },
        AgentNamesProvider: 'AgentNamesProvider',
        CoordinatorNameProvider: 'CoordinatorNameProvider',
      },
      './v2/data/sidebar': { dayLabel: () => '', taskState: () => '' },
      './v2/design/Rail': { DesignRail: 'DesignRail' },
      './v2/data/sidebar-preference': {
        sidebarCollapsed: () => true,
        sidebarPreferenceKey: 'sidebar',
      },
      './v2/start/FirstTask': { FirstTask: 'FirstTask' },
      './v2/data/links': { useInAppLinks() {} },
      './v2/data/desktop-update': {
        useDesktopUpdate: () => ({ status: { phase: 'idle' } }),
        changeDesktopUpdateNavigation(state, action) {
          if (action === 'toggle-sidebar') {
            desktopToggles++;
            return { ...state, collapsed: !state.collapsed };
          }
          return state;
        },
      },
      './v2/DesktopUpdate': { DesktopUpdateRow: 'DesktopUpdateRow' },
    },
    {
      window: Object.assign(target, { matchMedia: () => media }),
      document: { activeElement: trigger },
      HTMLElement: Element,
    },
  );
  const layout = h.render(h.exports.V2Layout);
  const render = () => h.render(layout.props.children.type);
  let tree = render();
  const dialog = {
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
  };
  elements(tree, 'dialog')[0].props.ref.current = dialog;
  h.effects();
  render();
  h.effects();
  const flush = () => {
    tree = render();
    h.effects();
  };
  const shortcut = () => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { ctrlKey: true, key: '\\' });
    target.dispatchEvent(event);
    flush();
    assert.equal(event.defaultPrevented, true);
  };
  return {
    h,
    target,
    media,
    dialog,
    trigger,
    shortcut,
    flush,
    tree: () => tree,
    desktopToggles: () => desktopToggles,
  };
}
test('compact shortcut toggles the modal instead of the desktop preference; Escape and close return focus', async () => {
  const f = await shell();
  f.shortcut();
  assert.equal(f.dialog.open, true);
  assert.equal(f.desktopToggles(), 0);
  f.shortcut();
  assert.equal(f.dialog.open, false);
  f.target.dispatchEvent(new Event('deploy:v2-sidebar'));
  f.flush();
  assert.equal(f.dialog.open, true);
  let prevented = false;
  elements(f.tree(), 'dialog')[0].props.onCancel({
    preventDefault() {
      prevented = true;
    },
  });
  f.flush();
  assert.equal(prevented, true);
  assert.equal(f.dialog.open, false);
  assert.ok(f.trigger.focused > 0);
  f.shortcut();
  elements(f.tree(), 'IconButton')
    .find((item) => item.props.label === 'Close navigation')
    .props.onClick();
  f.flush();
  assert.equal(f.dialog.open, false);
  f.h.dispose();
});
test('growing past compact closes the drawer and restores desktop shortcut behavior', async () => {
  const f = await shell();
  f.shortcut();
  f.media.matches = false;
  f.media.dispatchEvent(new Event('change'));
  f.flush();
  assert.equal(f.dialog.open, false);
  f.shortcut();
  assert.equal(f.desktopToggles(), 1);
  f.h.dispose();
});
