import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryRoute, repositoryURL } from './repository-navigation';
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
