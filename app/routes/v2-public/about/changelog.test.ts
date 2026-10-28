import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseChangelog } from './changelog.ts';
test('maps conventional sections, joins wrapped bullets, and orders dated releases newest first', () => {
  const releases = parseChangelog(
    `## 1.0.0 (2026-01-01)\n### Features\n- feat(app): add a new app\n  on your computers\n### Bug Fixes\n* fix: restart stopped deployments ([abcdef1](https://example.com/commit))\n### Chores\n- format files\n## [2.0.0](https://example.com/release) (2026-02-01)\n### Performance Improvements\n- faster logs`,
  );
  assert.deepEqual(
    releases.map((r) => r.version),
    ['2.0.0', '1.0.0'],
  );
  assert.equal(releases[1].date, '2026-01-01');
  assert.equal(releases[1].url, undefined);
  assert.deepEqual(
    releases[1].items.map((i) => [i.tag, i.text]),
    [
      ['New', 'Add a new app on your computers.'],
      ['Fixed', 'Restart stopped releases.'],
    ],
  );
  assert.equal(releases[1].items[1].reference?.url, 'https://example.com/commit');
});
test('handles integration notes and unsafe links without rendering markdown or HTML', () => {
  const [release] = parseChangelog(
    '## 1.0.0 (integration)\n\n- multi-node runtime;\n- keep [notes](javascript:alert) ([abcdef1](data:bad))',
  );
  assert.equal(release.date, 'integration');
  assert.equal(release.items[0].text, 'Multi-computer runtime.');
  assert.equal(release.items[1].reference, undefined);
  assert.equal(parseChangelog('## 1.0.0\n### Chores\n- format').length, 0);
});
test('the checked-in changelog includes the integration release and actual release notes', () => {
  const releases = parseChangelog(
    readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8'),
  );
  assert.equal(releases[0].version, '1.0.0');
  assert.ok(releases[0].items.length > 10);
  assert.ok(releases.some((r) => r.version === '3.0.2'));
});
