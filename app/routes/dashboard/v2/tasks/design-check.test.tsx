import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovedDesignCheck } from './design-check.client';
import { BuildComparison } from '../design/BuildComparison';
import { DesignBuildDecision } from '../inbox/DesignBuildDecision';
import type { TaskView } from './types';
import type { InboxItem } from '../../../../../shared/v2/contracts';
const board = { file: 'Header.html', title: 'Tally header', widths: [1440, 700], height: 192 };
const check = {
  reviewId: 'review',
  title: 'A calmer Tally header',
  approvedAt: '2026-11-09T14:14:00Z',
  commit: 'approved-commit',
  boards: [board],
  reviewHref: '/dashboard/inbox?item=review',
  state: 'waiting' as const,
};
const view = {
  task: { id: 'build' },
  agent: { name: 'Designer' },
  project: { id: 'tally' },
  screenshots: [],
  designCheck: check,
} as unknown as TaskView;

test('no approved design renders nothing; waiting and matching render the approved check copy', () => {
  assert.equal(
    renderToStaticMarkup(<ApprovedDesignCheck view={{ ...view, designCheck: undefined }} />),
    '',
  );
  const waiting = renderToStaticMarkup(<ApprovedDesignCheck view={view} />);
  assert.match(waiting, /Approved design/);
  assert.match(waiting, /Matches the approved design/);
  assert.match(waiting, /1 board at 1440 and 700 px/);
  assert.match(waiting, /Not reported yet/);
  assert.match(waiting, /dl-wait/);
  assert.doesNotMatch(waiting, /dl-attn/);
  assert.match(waiting, /Designer compares the running app/);
  const matching = renderToStaticMarkup(
    <ApprovedDesignCheck
      view={{ ...view, designCheck: { ...check, state: 'matches', captures: 2 } }}
    />,
  );
  assert.match(matching, /2 captures compared with the board · 1440 and 700 px/);
  assert.match(matching, /dl-ok/);
  assert.match(matching, /Designer compared the running app/);
  assert.match(matching, /Compare/);
});

test('comparison renders the immutable approved board at the reported width and omits an absent app frame', () => {
  const props = { projectId: 'tally', commit: 'approved-commit', board, width: 700 };
  const without = renderToStaticMarkup(<BuildComparison {...props} />);
  assert.match(without, /ref=approved-commit&amp;board=Header.html&amp;width=700/);
  assert.match(without, /Approved design/);
  assert.doesNotMatch(without, /The app|type="range"|dl-build-after/);
  const withCapture = renderToStaticMarkup(
    <BuildComparison {...props} captures={[{ image: '/capture-700', width: 700, height: 192 }]} />,
  );
  assert.match(withCapture, /src="\/capture-700"/);
  assert.match(withCapture, /The app/);
  assert.match(withCapture, /Drag to compare the design and the app/);
  assert.match(withCapture, /type="range"/);
});

test('a design difference has two answers and a task link, followed by the sent-back receipt', () => {
  const item: InboxItem = {
    id: 'design-build:1',
    kind: 'other',
    title: 'A calmer Tally header is built, with 1 difference',
    text: 'History wraps.',
    from: 'designer',
    taskId: 'build',
    projectId: 'tally',
    projectName: 'Tally',
    createdAt: '',
    state: 'waiting',
    actions: [
      { id: 'fix-app', label: 'Fix the app', primary: true },
      { id: 'keep-design', label: 'Keep it and update the design' },
    ],
    designCheck: {
      ...check,
      state: 'differs',
      projectId: 'tally',
      text: 'History wraps.',
      why: 'The count grows.',
      board: board.file,
      width: 700,
    },
  };
  const html = renderToStaticMarkup(
    <DesignBuildDecision item={item} name="Designer" pending={false} submit={() => {}} />,
  );
  assert.match(html, /Design check · Waiting on you/);
  assert.ok(html.indexOf('What differs') < html.indexOf('Approved design'));
  assert.ok(html.indexOf('Approved design') < html.indexOf('>Why<'));
  assert.equal((html.match(/>Fix the app<|>Keep it and update the design</g) ?? []).length, 2);
  assert.match(html, /href="\/dashboard\/tasks\/build"[^>]*>Open the task/);
  const answered = renderToStaticMarkup(
    <DesignBuildDecision
      item={{
        ...item,
        state: 'answered',
        answer: { actionId: 'fix-app', by: 'owner', on: 'web', at: '' },
      }}
      name="Designer"
      pending={false}
      submit={() => {}}
    />,
  );
  assert.match(answered, /dl-approval answered/);
  assert.match(answered, /Sent back · Designer is making the app match the design/);
  assert.doesNotMatch(answered, />Fix the app<|>Keep it and update the design</);
});
