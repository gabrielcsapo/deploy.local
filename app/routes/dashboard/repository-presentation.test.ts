import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryLink, repositoryLanguage } from './repository-presentation.ts';
test('repository Markdown resolves encoded relative paths within the repository root', () => {
  assert.deepEqual(repositoryLink('../README.md#setup', 'docs/guide.md'), {
    path: 'README.md',
    fragment: 'setup',
  });
  assert.deepEqual(repositoryLink('./my%20file.ts', 'docs/README.md'), {
    path: 'docs/my file.ts',
    fragment: '',
  });
  assert.deepEqual(repositoryLink('/app/file.ts', 'docs/README.md'), {
    path: 'app/file.ts',
    fragment: '',
  });
  for (const path of [
    '../../outside',
    '%2e%2e/%2e%2e/outside',
    'https://example.com',
    '#setup',
    '//example.com',
    'bad%',
    'bad%00file',
    'bad%5cfile',
  ])
    assert.equal(repositoryLink(path, 'docs/README.md'), null, path);
});
test('source languages use explicit filename mappings', () => {
  assert.equal(repositoryLanguage('app/main.tsx'), 'typescript');
  assert.equal(repositoryLanguage('Dockerfile'), 'dockerfile');
  assert.equal(repositoryLanguage('unknown.blob'), 'text');
});
