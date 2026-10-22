import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ApplicationList } from './application-list.client.tsx';
import { ListRow } from '../../components/ui/ListPage.tsx';
import { computerRoleSummary, repositorySecondary } from './list-summaries.ts';
import type { Computer } from '../../../server/computer-roles.ts';
import type { AppCardData } from '../../components/dashboard/AppCard.tsx';

const role = (state: 'ready' | 'off' | 'needs-setup' | 'paused') => ({ state, reason: state });
const computer: Pick<Computer, 'online' | 'roles'> = {
  online: true,
  roles: {
    deploy: role('ready'),
    tasks: role('ready'),
    computer: role('needs-setup'),
    browser: role('ready'),
    coordinator: role('ready'),
  },
};
test('computer summary counts only actual ready roles and names setup/paused roles', () => {
  assert.equal(computerRoleSummary(computer), '3 roles ready · Screen access needs setup');
  assert.equal(computerRoleSummary({ ...computer, online: false }), 'Offline');
  assert.equal(
    computerRoleSummary({ online: true, roles: { tasks: role('ready') } as Computer['roles'] }),
    '1 role ready',
  );
  assert.equal(
    computerRoleSummary({ ...computer, roles: { ...computer.roles, computer: role('ready') } }),
    'All roles ready',
  );
  assert.equal(
    computerRoleSummary({
      ...computer,
      roles: { ...computer.roles, deploy: role('off'), computer: role('paused') },
    }),
    '2 roles ready · Screen access paused',
  );
});

test('repository rows never expose local import paths and remote credentials', () => {
  for (const sourcePath of [
    '/home/user/repository-seeds/project.git',
    '/Users/owner/project',
    'file:///home/user/repo',
  ]) {
    const secondary = repositorySecondary({ sourcePath });
    const html = renderToStaticMarkup(
      createElement(ListRow, {
        icon: 'folder',
        title: 'Repository',
        secondary,
        to: '/dashboard/repositories/test',
      }),
    );
    assert.equal(secondary, 'Hosted on deploy.local');
    assert.doesNotMatch(html, /\/home\/|\/Users\/|file:\/\/|repository-seeds/);
  }
  assert.equal(
    repositorySecondary({ sourcePath: 'https://user:secret@git.example/repo.git' }),
    'Imported from git.example',
  );
  assert.equal(
    repositorySecondary({ sourcePath: 'git@git.example:repo.git' }),
    'Imported from git.example',
  );
  assert.equal(
    repositorySecondary({ description: 'Application source', sourcePath: '/tmp/repo' }),
    'Application source',
  );
});

test('application rows contain URL and exceptional status without metrics or default checkboxes', () => {
  const cards = [
    { name: 'test', severity: 'healthy', rps: 42, cpuPercent: 80 },
    { name: 'building', severity: 'building' },
  ] as AppCardData[];
  const html = renderToStaticMarkup(
    createElement(ApplicationList, { cards, onDelete() {}, onBulkRestart() {}, onBulkDelete() {} }),
  );
  assert.match(html, /https:\/\/test.local/);
  assert.match(html, /Building/);
  assert.doesNotMatch(html, /Running|Req\/s|req\/s|CPU|Memory|p95|5xx|<table|type="checkbox"/);
  assert.match(html, /popover="auto"[^>]*><button[^>]*>Delete application<\/button>/);
  assert.match(html, />Edit<\/button>/);
  const page = readFileSync(new URL('./apps.client.tsx', import.meta.url), 'utf8');
  assert.match(page, /<ConfirmDialog/);
  assert.match(page, /onBulkRestart={handleBulkRestart}/);
  assert.match(page, /onBulkDelete=/);
});
