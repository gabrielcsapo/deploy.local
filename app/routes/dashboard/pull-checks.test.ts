import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PullChecks } from './pull-checks.client.tsx';

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const run = (id: string, commit: string, status: string, createdAt: string) => ({
  id,
  commit,
  status,
  createdAt,
});
const runs = [
  run('1', old, 'failed', '2026-10-19T10:00:00Z'),
  run('2', old, 'succeeded', '2026-10-19T10:30:00Z'),
  run('3', head, 'failed', '2026-10-19T11:00:00Z'),
  run('4', head, 'succeeded', '2026-10-19T11:30:00Z'),
];
const render = (props: Record<string, any>) =>
  renderToStaticMarkup(createElement(PullChecks, props as any));

test('the panel reports the head commit and collapses everything older', () => {
  const html = render({ runs, headCommit: head });
  assert.match(html, new RegExp(`Check ${head.slice(0, 7)} · succeeded`));
  assert.match(html, /1 earlier attempt/);
  assert.match(html, /Earlier runs \(2\)/);
  assert.doesNotMatch(html, /No checks ran on this version/);
});

test('a head with no runs of its own says so instead of showing a stale result', () => {
  const html = render({ runs: runs.slice(0, 2), headCommit: head });
  assert.match(html, /No checks ran on this version\./);
  // The earlier runs keep their results, inside the collapsed group, never as a check row.
  assert.match(html, /Earlier runs \(2\)/);
  assert.match(html, new RegExp(`${old.slice(0, 7)} · succeeded`));
  assert.doesNotMatch(html, /Check /);
  // Nothing recorded at all, and nothing to place a run against yet.
  assert.equal(render({ runs: [], headCommit: head }), '');
  assert.match(render({ runs }), /Placing 4 recorded check run/);
});
