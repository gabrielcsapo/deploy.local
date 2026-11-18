import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveLabel, cloneAddresses } from './clone.ts';

test('the Clone menu offers HTTPS, and SSH only when this server runs it', () => {
  const repository = { clonePath: '/forma.git', sshClonePath: '/forma.git', sshPort: 2222 };
  assert.deepEqual(cloneAddresses(repository, 'p1', 'https://deploy.local'), {
    https: 'https://deploy.local/forma.git',
    ssh: 'ssh://git@deploy.local:2222/forma.git',
  });
  assert.equal(
    cloneAddresses({ ...repository, sshPort: 22 }, 'p1', 'https://deploy.local:8443').ssh,
    'ssh://git@deploy.local/forma.git',
  );
  assert.equal(
    cloneAddresses({ ...repository, sshPort: null }, 'p1', 'https://deploy.local').ssh,
    null,
  );
  assert.equal(
    cloneAddresses({}, 'p1', 'https://deploy.local').https,
    'https://deploy.local/api/git/p1',
  );
});

test('Download ZIP names the branch or tag, or a short commit', () => {
  assert.equal(archiveLabel('main'), 'main');
  assert.equal(archiveLabel('refs/tags/v1.2'), 'v1.2');
  assert.equal(archiveLabel('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'), 'a1b2c3d');
});
