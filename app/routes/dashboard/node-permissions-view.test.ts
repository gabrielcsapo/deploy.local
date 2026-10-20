import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodePermissions } from './node-permissions.client.tsx';
import { Toggle } from '../../components/Toggle.tsx';
import type { NodePermission } from './node-permissions.ts';

const permissions: NodePermission[] = [
  {
    id: 'screen',
    label: 'Screen capture',
    state: 'off',
    summary: 'Approve screen sharing.',
    step: { where: 'computer', label: 'Next step', command: 'deploy desktop-helper setup' },
  },
  {
    id: 'input',
    label: 'Input',
    state: 'on',
    summary: 'Input allowed.',
    step: {
      where: 'computer',
      label: 'To make view-only',
      command: 'deploy desktop-helper install',
    },
  },
  {
    id: 'browser',
    label: 'Task browser',
    state: 'unavailable',
    summary: 'Chromium isn’t installed for the task browser.',
    step: { where: 'computer', label: 'Install', command: 'deploy browser install' },
  },
];

test('local setup offers one primary, reverses input, hides command instructions and shows install failure', () => {
  const html = renderToStaticMarkup(
    createElement(NodePermissions, {
      computer: 'test computer',
      permissions,
      localAction: () => {},
      onRevoke: () => {},
      browserInstall: {
        busy: false,
        message: '',
        error: 'Not enough disk space to install Chromium.',
      },
    }),
  );
  assert.equal(html.match(/ui-button-primary/g)?.length, 1);
  assert.match(html, /Install Chromium \(about 650 MB\)/);
  assert.match(html, /Make view-only…/);
  assert.doesNotMatch(html, /Allow input|Next step|deploy desktop-helper/);
  assert.match(html, /role="alert">Not enough disk space/);
});

test('remote computers retain one copyable command chip and quiet reversal instructions', () => {
  const html = renderToStaticMarkup(
    createElement(NodePermissions, {
      computer: 'remote computer',
      permissions,
      onRevoke: () => {},
    }),
  );
  assert.doesNotMatch(html, /ui-button-primary/);
  assert.match(html, /data-quiet="true"/);
  assert.match(html, /Copy deploy browser install/);
  assert.match(html, /<code>deploy browser install<\/code>/);
});

test('installation disables the button and exposes progress accessibly', () => {
  const html = renderToStaticMarkup(
    createElement(NodePermissions, {
      computer: 'test computer',
      permissions,
      onRevoke: () => {},
      localAction: () => {},
      browserInstall: { busy: true, message: 'Downloading Chromium… 25%' },
    }),
  );
  assert.match(html, /disabled="" aria-busy="true"/);
  assert.match(html, /Installing Chromium…/);
  assert.match(html, /role="status">Downloading Chromium… 25%/);
  const checkbox = renderToStaticMarkup(
    createElement(Toggle, {
      checkbox: true,
      label: 'Start at login',
      enabled: true,
      onChange: () => {},
    }),
  );
  assert.match(checkbox, /<label/);
  assert.match(checkbox, /type="checkbox" role="switch"/);
  assert.match(checkbox, /aria-label="Start at login" checked=""/);
});

test('partial downloads stay busy even when the first executable appears, then discard stale progress', () => {
  const ready = [
    { id: 'browser', label: 'Task browser', state: 'on' as const, summary: 'A headless browser.' },
  ];
  const render = (busy: boolean) =>
    renderToStaticMarkup(
      createElement(NodePermissions, {
        computer: 'test computer',
        permissions: ready,
        onRevoke: () => {},
        localAction: () => {},
        browserInstall: { busy, message: 'Chromium installed. Checking task browser…' },
      }),
    );
  assert.match(render(true), /Installing Chromium…/);
  assert.equal(render(true).match(/ui-button-primary/g)?.length, 1);
  assert.doesNotMatch(render(false), /Checking task browser|Installing Chromium/);
  assert.match(render(false), /Ready/);
});
