import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteHostName } from './default-branch.ts';

test('the dialog names well-known remote hosts and nothing else', () => {
  assert.equal(remoteHostName('git@github.com:gabriel/home-gym.git'), 'GitHub');
  assert.equal(remoteHostName('https://gitlab.com/team/app.git'), 'GitLab');
  assert.equal(remoteHostName('ssh://git@codeberg.org/me/app.git'), 'Codeberg');
  assert.equal(remoteHostName('git@git.example.com:me/app.git'), null);
  assert.equal(remoteHostName('/srv/repos/app.git'), null);
});
