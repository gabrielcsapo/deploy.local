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

test('workspace checks show command, explicit result and source independently of pipelines', () => {
  const workspace = {
    id: 'workspace:1',
    source: 'workspace',
    sourceLabel: 'Ran in the task workspace on MacBook Pro',
    command: 'pnpm test',
    commit: head,
    status: 'succeeded',
    attempts: 3,
  };
  const html = render({
    runs: [
      ...runs,
      workspace,
      { ...workspace, id: 'workspace:2', command: 'pnpm typecheck', status: 'failed' },
    ],
    headCommit: head,
  });
  assert.match(html, /pnpm test · Passed · Ran in the task workspace on MacBook Pro/);
  assert.match(html, /pnpm typecheck · Failed/);
  assert.match(html, /2 earlier attempts/);
  assert.match(html, /Check aaaaaaa · succeeded/);
  const earlier = render({ runs: [{ ...workspace, commit: old }], headCommit: head });
  assert.match(earlier, /No checks ran on this version/);
  assert.match(earlier, /Earlier runs \(1\)/);
});

test('a piped run whose output did not say reports that, never a pass or a raw status', () => {
  const piped = {
    id: 'workspace:3',
    source: 'workspace',
    sourceLabel: 'Ran in the task workspace on MacBook Pro',
    command: 'pnpm test 2>&1 | tail -20',
    commit: head,
    status: 'unknown',
    piped: true,
  };
  const html = render({ runs: [piped], headCommit: head });
  assert.match(html, /tail -20 · Result unknown \(output piped\)/);
  assert.doesNotMatch(html, /Passed|Failed/);
  // The same row from before the head keeps its wording inside the collapsed group.
  assert.match(
    render({
      runs: [
        { ...piped, commit: old },
        { ...piped, id: 'workspace:4' },
      ],
      headCommit: head,
    }),
    /Earlier runs \(1\)[\s\S]*Result unknown \(output piped\)/,
  );
});
