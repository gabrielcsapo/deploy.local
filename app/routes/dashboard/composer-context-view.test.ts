import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkerUpdateNotice } from './worker-update.client.tsx';
import { ComposerControls } from './composer-controls.client.tsx';
import { ComposerContext, PhoneComposerContext } from './composer-context.client.tsx';

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

test('context tray precedes the prompt, existing tasks use labels, and repository creation preserves the draft', () => {
  const shell = readFileSync(new URL('./projects.client.tsx', import.meta.url), 'utf8');
  assert.match(shell, /!selected \? \(\s*<ComposerContext/);
  assert.match(shell, /pw-composer-context-tray/);
  assert.match(shell, /placeholder="Ask, build, or follow up…"/);
  assert.doesNotMatch(shell, /Describe what to build|Describe the work/);
  const toolbar = shell.slice(
    shell.indexOf('<div className="pw-composer-toolbar">'),
    shell.indexOf('{active && queueing && draft.trim()'),
  );
  assert.doesNotMatch(toolbar, /<ComposerContext /);
  assert.match(toolbar, /followUp=\{true\}/);
  assert.ok(toolbar.indexOf('<VoiceInput') < toolbar.lastIndexOf('<ComposerControls'));
  assert.match(
    shell,
    /else if \(repositoryFromComposer.current\) \{\s*setProject\(p.id\);\s*setRepositoryTaskScope\(null\);/,
  );
});

const modelProps: Parameters<typeof ComposerControls>[0] = {
  adapters: [
    { id: 'codex', name: 'Codex', available: true },
    { id: 'claude', name: 'Claude', available: false },
  ],
  adapter: 'codex',
  models: [],
  catalogs: [],
  model: '',
  efforts: ['low', 'high'],
  effort: '',
  disabled: false,
  chooseAdapter: () => {},
  chooseModel: () => {},
  chooseEffort: () => {},
};
const renderPhone = (extra: Partial<Parameters<typeof PhoneComposerContext>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PhoneComposerContext, {
      ...props,
      modelControls: createElement(ComposerControls, { ...modelProps, inline: true }),
      ...extra,
    }),
  );

test('phone has one combined, accessible context chip and a modal sheet with all three sections', () => {
  const html = renderPhone();
  assert.match(html, /class="pw-model-pill pw-phone-context-chip"/);
  assert.match(html, /SER · Tally/);
  assert.match(html, /aria-label="Computer SER, project Tally. Change"/);
  assert.match(html, /aria-haspopup="dialog" aria-expanded="false" aria-controls=/);
  assert.match(html, /<dialog[^>]*class="pw-phone-context-sheet"[^>]*aria-labelledby=/);
  for (const section of ['Computer', 'Project', 'Model'])
    assert.match(html, new RegExp(`<h3[^>]*>${section}</h3>`));
  assert.match(html, /pw-phone-sheet-handle/);
  assert.match(html, /ui-button-link[^>]*>Done/);
  assert.match(html, /New repository…/);
  assert.match(html, /Offline · The task worker is offline/);
  assert.match(html, /Needs setup · Sign in to a provider/);
  assert.doesNotMatch(html, /Role disabled|No role report|popover="auto"/);
  for (const platform of ['linux', 'darwin', 'win32'])
    assert.ok(html.includes(`aria-label="${platform}"`));
});

test('phone unset chip says No project visually and none to assistive technology', () => {
  const html = renderPhone({ project: '' });
  assert.match(html, /SER · No project/);
  assert.match(html, /aria-label="Computer SER, project none. Change"/);
});

test('follow-up phone composer offers only model settings and no computer or project chip', () => {
  const html = renderPhone({ followUp: true });
  assert.match(html, /aria-label="Model. Change"/);
  assert.match(html, /<h3[^>]*>Model<\/h3>/);
  assert.doesNotMatch(html, /<h3[^>]*>(Computer|Project)<\/h3>|SER ·|No project|New repository/);
  assert.match(html, /aria-label="Codex: Default"/);
  assert.match(html, /aria-label="Claude: Default"/);
  assert.match(html, /aria-label="Reasoning effort"/);
  assert.match(html, /Custom model for Codex…/);
  assert.match(
    renderToStaticMarkup(
      createElement(ComposerControls, { ...modelProps, inline: true, disabled: true }),
    ),
    /<fieldset[^>]*disabled=""/,
  );
});

test('selected outdated and unknown workers show a non-blocking attention warning in the context tray', () => {
  for (const state of ['outdated', 'unknown'] as const) {
    const html = render({
      computers: [
        {
          ...props.computers[0]!,
          update: { state, reason: 'Update this worker', missingTools: ['deploy_commit'] },
        },
      ],
    });
    assert.match(
      html,
      /data-tone="attention".*Older worker: agents can&#x27;t commit or deploy here/,
    );
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /disabled=""/);
  }
  for (const update of [
    undefined,
    { state: 'current' as const, reason: 'Current', missingTools: [] },
  ]) {
    assert.doesNotMatch(
      render({ computers: [{ ...props.computers[0]!, update }] }),
      /Older worker/,
    );
  }
  assert.doesNotMatch(
    render({
      computers: [
        props.computers[0]!,
        { ...props.computers[1]!, update: { state: 'outdated', reason: 'Old', missingTools: [] } },
      ],
    }),
    /Older worker/,
  );
});

test('computer update notices explain the reason and existing platform installation paths', () => {
  const update = {
    state: 'outdated' as const,
    reason: "Agents here can't use: deploy_commit.",
    missingTools: ['deploy_commit'],
  };
  const html = renderToStaticMarkup(
    createElement(WorkerUpdateNotice, { update, platform: 'linux' }),
  );
  assert.match(html, /Worker update available/);
  assert.match(html, /Update available/);
  assert.match(html, /deploy_commit/);
  assert.match(html, /Install the latest deploy.local worker on this computer/);
  assert.match(html, /AppImage in its existing/);
  const mac = renderToStaticMarkup(
    createElement(WorkerUpdateNotice, { update, platform: 'darwin' }),
  );
  assert.match(mac, /on this Mac/);
  assert.doesNotMatch(mac, /AppImage/);
  assert.equal(
    renderToStaticMarkup(
      createElement(WorkerUpdateNotice, {
        update: { ...update, state: 'current' },
        platform: 'linux',
      }),
    ),
    '',
  );
});
