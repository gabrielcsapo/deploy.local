import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceTitleBar, dashboardSection } from './workspace-title-bar.client';
import { DeploymentEvent, PullRequestEvent, PullRequestBar } from './transcript-events.client';
import { NewTaskPrompt } from './composer-context.client';
import tokens from '../../design-tokens.json';
const render = (component: any, props: any) =>
  renderToStaticMarkup(createElement(component, props));
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('every dashboard section shares a glyph, title, navigation toggle and command search', () => {
  for (const route of [
    'projects',
    'repositories',
    'apps',
    'nodes',
    'computers',
    'settings',
    'design-system',
    'catalog',
    'activity',
    'logs',
    'discover',
  ]) {
    const section = dashboardSection('/dashboard/' + route);
    const html = render(WorkspaceTitleBar, section);
    assert.ok(html.includes(section.title));
    assert.match(html, /workspace-title-bar/);
    assert.match(html, /Show sidebar/);
    assert.match(html, /Search commands/);
    assert.doesNotMatch(html, /Commands <kbd>|breadcrumb/);
  }
  for (const file of [
    'layout.client.tsx',
    'projects.client.tsx',
    'repository-library.client.tsx',
    'project-hub.client.tsx',
    'detail/layout.client.tsx',
  ])
    assert.match(source(file), /<WorkspaceTitleBar/);
});
test('item titles retain a quiet linked section prefix, and compact chrome uses the shared row', () => {
  const html = render(WorkspaceTitleBar, {
    title: 'habit-harbor',
    prefix: { title: 'Applications', href: '/dashboard/apps' },
    compact: true,
  });
  assert.match(html, /href="\/dashboard\/apps"/);
  assert.match(html, /workspace-title-prefix/);
  assert.match(html, /compact-top-bar phone-only/);
  assert.match(html, /data-single-row="true"/);
  assert.equal((html.match(/<header/g) || []).length, 1);
  // Phone navigation is the tab bar: without a back target the row leads with the title.
  assert.doesNotMatch(html, /Show sidebar/);
});
const pull = {
  id: 'p1',
  projectId: 'p',
  number: 1,
  title: 'Daily streaks',
  targetBranch: 'main',
  status: 'open',
};
test('open PR has a live bar and one linked Opened event; merged and closed have only their event', () => {
  assert.match(render(PullRequestBar, { pull }), /pw-pull-bar/);
  const opened = render(PullRequestEvent, { pull });
  assert.match(opened, /Opened #1 Daily streaks/);
  assert.match(opened, /pulls\?pull=p1/);
  for (const status of ['merged', 'closed']) {
    const record = { ...pull, status, mergedCommit: 'f77b014abcdef' };
    assert.equal(render(PullRequestBar, { pull: record }), '');
    const event = render(PullRequestEvent, { pull: record });
    assert.match(
      event,
      status === 'merged'
        ? /Merged #1 Daily streaks into main · f77b014/
        : /Closed #1 Daily streaks/,
    );
    assert.doesNotMatch(event, /button|pw-pull-bar/);
  }
});
test('deployment events retain URL and log links, hide running and expose failures', () => {
  const deployment = {
    application: 'habit-harbor',
    status: 'running',
    url: 'https://habit-harbor.local',
  };
  const html = render(DeploymentEvent, { deployment });
  assert.match(html, /Deployed habit-harbor/);
  assert.match(html, /href="https:\/\/habit-harbor.local"/);
  assert.match(html, /href="\/dashboard\/habit-harbor\/build"/);
  assert.doesNotMatch(html, /running|blockquote/);
  assert.match(
    render(DeploymentEvent, { deployment: { ...deployment, status: 'failed' } }),
    /· failed/,
  );
  assert.doesNotMatch(render(DeploymentEvent, { deployment: { status: 'failed' } }), /href=/);
});
test('one placeholder and a project-aware prompt across platforms', () => {
  const props = {
    projects: [{ id: 'p', name: 'Tally' }],
    project: 'p',
    computers: [],
    computer: '',
    chooseProject() {},
    chooseComputer() {},
    newRepository() {},
  };
  assert.match(render(NewTaskPrompt, props), /What should we build.*Tally/);
  assert.match(render(NewTaskPrompt, { ...props, project: '' }), /What should we build\?/);
  assert.doesNotMatch(render(NewTaskPrompt, { ...props, project: '' }), /<button/);
  for (const file of [
    'projects.client.tsx',
    '../../../native/Apple/Packages/DeployKit/Sources/DeployUI/NewConversationView.swift',
    '../../../native/Apple/Packages/DeployKit/Sources/DeployUI/WorkspaceView.swift',
  ]) {
    const value = source(file);
    assert.match(value, /Ask, build, or follow up…/);
    assert.doesNotMatch(
      value,
      /Describe what to build or change…|Ask deploy.local…|Describe the work/,
    );
  }
});
function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
test('user bubble normal ink meets AA in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    const values = [
      luminance(tokens.color[theme].text),
      luminance(tokens.color[theme].accentSoft),
    ].sort((a, b) => b - a);
    const contrast = (values[0]! + 0.05) / (values[1]! + 0.05);
    assert.ok(contrast >= 4.5, `${theme}: ${contrast}`);
  }
});
