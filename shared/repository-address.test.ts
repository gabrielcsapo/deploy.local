import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectAtAddress,
  repositoryAddress,
  shortGitRequest,
  uniqueRepositoryAddress,
} from './repository-address.ts';

test('repository names become folder-safe short addresses unless a page owns them', () => {
  assert.equal(repositoryAddress('Home Gym'), 'Home-Gym');
  assert.equal(repositoryAddress('  lego_builder.v2 '), 'lego_builder.v2');
  assert.equal(repositoryAddress('Docs'), null);
  assert.equal(repositoryAddress('favicon.ico'), null);
  assert.equal(repositoryAddress('!!!'), 'repository');
});

test('Git smart-HTTP requests on a short address are recognized; pages are not', () => {
  assert.deepEqual(shortGitRequest('/home-gym.git/info/refs'), {
    repository: 'home-gym',
    transport: '/info/refs',
  });
  assert.deepEqual(shortGitRequest('/home-gym/git-upload-pack'), {
    repository: 'home-gym',
    transport: '/git-upload-pack',
  });
  assert.deepEqual(shortGitRequest('/home-gym.git'), { repository: 'home-gym', transport: '' });
  for (const path of [
    '/home-gym',
    '/home-gym/pulls',
    '/home-gym.git/pulls',
    '/docs/info/refs',
    '/dashboard/info/refs',
    '/api/workspace/git/x/info/refs',
    '/',
    '/%E0%A4%A',
  ])
    assert.equal(shortGitRequest(path), null, path);
});

test('an address resolves to one repository: current names before renamed-away ones', () => {
  const projects = [
    { id: 'a', name: 'Gym Log', previousAddresses: ['home-gym'] },
    { id: 'b', name: 'Lego Builder' },
  ];
  assert.equal(projectAtAddress(projects, 'HOME-GYM')?.id, 'a');
  assert.equal(projectAtAddress(projects, 'lego-builder')?.id, 'b');
  projects.push({ id: 'c', name: 'Home Gym' });
  assert.equal(projectAtAddress(projects, 'home-gym')?.id, 'c');
  // Two older repositories that share an address get neither, so links fall back to ids.
  const clash = [
    { id: 'x', name: 'a b' },
    { id: 'y', name: 'a-b' },
  ];
  assert.equal(projectAtAddress(clash, 'a-b'), null);
  assert.equal(uniqueRepositoryAddress(clash, clash[0]), null);
});
