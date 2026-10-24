import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardPathname,
  repositoryRoute,
  repositoryURL,
  workspacePath,
} from './repository-navigation';
test('repository URLs distinguish the library, repository and durable section links', () => {
  assert.deepEqual(repositoryRoute('/dashboard/repositories/'), {
    projectId: '',
    section: 'repository',
    valid: true,
  });
  for (const section of ['repository', 'issues', 'pulls', 'pipelines', 'deployment', 'settings']) {
    assert.deepEqual(repositoryRoute(repositoryURL('repo with spaces', section)), {
      projectId: 'repo with spaces',
      section,
      valid: true,
    });
  }
  assert.equal(repositoryRoute('/dashboard/settings'), null);
  for (const path of [
    '/dashboard/repositories/x/unknown',
    '/dashboard/repositories/x/settings/extra',
    '/dashboard/repositories/%XX',
    '/dashboard/repositories/a%2Fb',
  ])
    assert.equal(repositoryRoute(path)?.valid, false);
});

test('repository rows link to their short address; pages keep their own paths', () => {
  assert.equal(repositoryURL({ id: 'id-1', name: 'Home Gym' }), '/Home-Gym');
  assert.equal(repositoryURL({ id: 'id-1', name: 'Home Gym' }, 'pulls'), '/Home-Gym/pulls');
  // No unique address (reserved, or shared by older repositories): the id route.
  assert.equal(repositoryURL({ id: 'id-2', name: 'Docs' }), '/dashboard/repositories/id-2');
  assert.equal(
    repositoryURL({ id: 'id-3', name: 'a b', address: null }, 'settings'),
    '/dashboard/repositories/id-3/settings',
  );
  assert.deepEqual(repositoryRoute('/Home-Gym/'), {
    projectId: '',
    address: 'Home-Gym',
    section: 'repository',
    valid: true,
  });
  assert.equal(repositoryRoute('/Home-Gym/pipelines')?.section, 'pipelines');
  assert.equal(repositoryRoute('/Home-Gym/unknown')?.valid, false);
  for (const path of ['/', '/docs', '/docs/cli', '/discover', '/changelog', '/favicon.ico'])
    assert.equal(repositoryRoute(path), null, path);
  assert.equal(workspacePath('/Home-Gym'), true);
  assert.equal(workspacePath('/docs/cli'), false);
  assert.equal(dashboardPathname('/Home-Gym/pulls'), '/dashboard/repositories/Home-Gym/pulls');
  assert.equal(dashboardPathname('/dashboard/apps'), '/dashboard/apps');
});
