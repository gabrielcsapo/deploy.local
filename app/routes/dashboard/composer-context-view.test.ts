import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerContext } from './composer-context.client.tsx';

const props: Parameters<typeof ComposerContext>[0] = {
  projects: [{ id: 'tally', name: 'Tally' }],
  project: 'tally',
  computer: 'local',
  computers: [
    {
      id: 'local',
      name: 'SER',
      platform: 'linux',
      status: 'online',
      roles: {
        tasks: { state: 'ready', reason: 'A task worker and provider connection are available.' },
      },
    },
    {
      id: 'mac',
      name: 'MacBook',
      platform: 'darwin',
      status: 'offline',
      roles: { tasks: { state: 'needs-setup', reason: 'The task worker is offline.' } },
    },
    {
      id: 'pc',
      name: 'Desktop',
      platform: 'win32',
      status: 'online',
      roles: { tasks: { state: 'needs-setup', reason: 'Sign in to a provider on this computer.' } },
    },
    {
      id: 'off',
      name: 'Role disabled',
      status: 'online',
      roles: { tasks: { state: 'off', reason: 'Turned off.' } },
    },
    { id: 'unknown', name: 'No role report', status: 'online' },
  ],
  chooseProject: () => {},
  chooseComputer: () => {},
  newRepository: () => {},
};
const render = (extra: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(ComposerContext, { ...props, ...extra }));

test('project and computer use model pills with labeled, keyboard reachable popovers', () => {
  const html = render();
  assert.equal(html.match(/class="pw-model-pill"/g)?.length, 2);
  assert.match(html, /aria-label="Project: Tally"/);
  assert.match(html, /aria-label="Computer: SER"/);
  assert.equal(html.match(/aria-haspopup="dialog"/g)?.length, 2);
  assert.match(html, /popover="auto" role="dialog" aria-label="Choose project"/);
  assert.match(html, /popover="auto" role="dialog" aria-label="Choose computer"/);
  assert.doesNotMatch(html, /<select|tabindex="-1"/);
  assert.match(html, /aria-pressed="true"><span>Tally/);
});

test('No project is quieter and New repository follows the project choices as a text link', () => {
  const html = render({ project: '' });
  assert.match(html, /class="pw-model-pill pw-context-unset"[^>]*aria-label="Project: No project"/);
  assert.match(html, /Tally.*pw-context-create.*ui-button-link.*New repository…/);
  assert.doesNotMatch(html, /ui-button-primary|ui-button-secondary/);
});

test('only computers with Coding tasks enabled are listed; unavailable choices keep reasons and platform glyphs', () => {
  const html = render();
  assert.doesNotMatch(html, /Role disabled|No role report/);
  assert.match(html, /data-tone="healthy"/);
  assert.equal(html.match(/disabled=""/g)?.length, 2);
  assert.match(html, /Offline · The task worker is offline/);
  assert.match(html, /Needs setup · Sign in to a provider/);
  for (const platform of ['linux', 'darwin', 'win32'])
    assert.ok(html.includes(`aria-label="${platform}"`));
  assert.match(html, /data-tone="inactive"/);
  assert.match(html, /data-tone="attention"/);
});

test('empty computer menus explain availability and offline workers never claim readiness', () => {
  assert.match(render({ computers: [] }), /No computers with Coding tasks enabled/);
  const html = render({ computers: [{ ...props.computers[0]!, status: 'offline' }] });
  assert.match(html, /disabled=""/);
  assert.match(html, /<small>Offline<\/small>/);
  assert.doesNotMatch(html, /provider connection are available/);
});

test('existing tasks hide context chips, task start has no heading, and repository creation selects without replacing the draft', () => {
  const shell = readFileSync(new URL('./projects.client.tsx', import.meta.url), 'utf8');
  assert.match(shell, /!selected && \(\s*<ComposerContext/);
  assert.doesNotMatch(shell, /Describe the work|phone-composer-context|pw-new-context/);
  assert.match(shell, /Describe what to build or change…/);
  const toolbar = shell.slice(
    shell.indexOf('<div className="pw-composer-toolbar">'),
    shell.indexOf('{active && queueing && draft.trim()'),
  );
  assert.ok(toolbar.indexOf('<VoiceInput') < toolbar.indexOf('<ComposerContext'));
  assert.ok(toolbar.indexOf('<ComposerContext') < toolbar.indexOf('<ComposerControls'));
  assert.match(
    shell,
    /else if \(repositoryFromComposer.current\) \{\s*setProject\(p.id\);\s*setRepositoryTaskScope\(null\);/,
  );
});
