import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComputerRoleRows } from './computer-role-rows.client.tsx';
import NodesClient from './nodes.client.tsx';
import type { ComputerRole } from '../../../server/computer-roles.ts';
import type { NodePermission } from './node-permissions.ts';

const permissions: NodePermission[] = [
  {
    id: 'screen',
    label: 'Capture',
    state: 'on',
    summary: 'Capture ready',
    step: { where: 'computer', label: 'To turn off', command: 'deploy desktop-helper stop' },
  },
  {
    id: 'input',
    label: 'Input',
    state: 'on',
    summary: 'Input allowed',
    step: {
      where: 'computer',
      label: 'To make view-only',
      command: 'deploy desktop-helper install',
    },
  },
  {
    id: 'unlocked',
    label: 'Lock',
    state: 'on',
    summary: 'Anyone at this computer can use it.',
    step: {
      where: 'computer',
      label: 'To restore the lock',
      command: 'deploy desktop-helper lock restore',
    },
  },
  {
    id: 'browser',
    label: 'Browser',
    state: 'on',
    summary: 'A headless browser. Each conversation asks you first.',
    step: { where: 'here', label: 'Project settings', action: 'project-settings' },
  },
];
const roles: Record<string, ComputerRole> = {
  deploy: { state: 'off', reason: 'This role is turned off on this computer.' },
  tasks: { state: 'ready', reason: 'A task worker and provider connection are available.' },
  computer: { state: 'ready', reason: 'Capture ready' },
  browser: { state: 'ready', reason: permissions[3].summary },
};

test('the computer list keeps enrollment behind its Connect link by default', () => {
  const html = renderToStaticMarkup(createElement(NodesClient));
  assert.match(html, /href="#computer-enrollment"/);
  assert.doesNotMatch(html, /<form|Computer name|Desktop roles|Create enrollment|role="dialog"/);
});
const render = (extra: Partial<Parameters<typeof ComputerRoleRows>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ComputerRoleRows, {
      computer: 'Desktop',
      roles,
      permissions,
      onToggle: () => {},
      copy: () => {},
      ...extra,
    }),
  );

test('roles group each state immediately beside its switch and omit redundant Off/Ready reasons', () => {
  const html = render();
  assert.equal(html.match(/role="switch"/g)?.length, 4);
  assert.match(
    html,
    /ds-role-state"><span[^>]*data-tone="healthy"[^>]*>.*?Ready<\/span><label class="ui-switch">/,
  );
  assert.doesNotMatch(
    html,
    /This role is turned off|provider connection are available|Permissions ·/,
  );
  assert.match(html, /Each conversation asks you first/);
  assert.doesNotMatch(html, /A headless browser/);
});

test('screen rows contain indented input and lock with all remote repair/reversal commands', () => {
  const html = render({ anchors: true });
  for (const id of ['screen', 'input', 'unlocked', 'browser'])
    assert.match(html, new RegExp(`id="permission-${id}"`));
  assert.match(html, /ds-role-subrows.*Allow click and type.*Screen lock/);
  for (const command of ['stop', 'install', 'lock restore'])
    assert.ok(html.includes(`Copy deploy desktop-helper ${command}`));
  assert.match(html, /Project settings/);
  assert.match(html, /Anyone at this computer can use it/);
});

test('local rows retain forward/reverse helper actions and browser install feedback without CLI chips', () => {
  const html = render({ localAction: () => {} });
  assert.match(html, /Stop screen capture…/);
  assert.match(html, /Make view-only…/);
  assert.match(html, /Restore lock…/);
  assert.doesNotMatch(html, /<code>|Copy deploy/);
  const installing = render({
    localAction: () => {},
    permissions: permissions.map((p) =>
      p.id === 'browser' ? { ...p, state: 'unavailable', summary: 'Chromium is missing.' } : p,
    ),
    roles: {
      ...roles,
      browser: {
        state: 'needs-setup',
        reason: 'Chromium is missing.',
        fix: 'deploy browser install',
      },
    },
    browserInstall: { busy: true, message: 'Downloading Chromium… 25%', error: 'Disk full' },
  });
  assert.match(installing, /Installing Chromium…/);
  assert.match(installing, /role="alert">Disk full/);
  assert.doesNotMatch(installing, /<code>/);
});

test('Paused and Needs setup keep their reason and fix; Off has no permission detail', () => {
  const paused: ComputerRole = {
    state: 'paused',
    reason: 'Agent control is paused on this computer.',
    fix: 'Resume from the tray.',
  };
  const html = render({
    roles: {
      ...roles,
      computer: paused,
      browser: paused,
      tasks: { state: 'needs-setup', reason: 'Sign in to a provider.', fix: 'Open Node setup.' },
    },
  });
  assert.equal(html.match(/>Paused<\/span>/g)?.length, 2);
  assert.equal(html.match(/<code>Resume from the tray\.<\/code>/g)?.length, 2);
  assert.match(html, /Sign in to a provider/);
  assert.match(html, /<code>Open Node setup\.<\/code>/);
  const off = render({ roles: { computer: { state: 'off', reason: 'Redundant off reason' } } });
  assert.doesNotMatch(off, /Allow click and type|Screen lock|<code>|Redundant/);
});
