import test from 'node:test';
import assert from 'node:assert/strict';
import { workSections } from './work.ts';
import type {
  WorkRow,
  WorkStage,
} from '../../../../../server/features/repositories/project-work.ts';

const row = (id: string, stage: WorkStage): WorkRow => ({
  id,
  title: id,
  stage,
  meta: [],
  at: '',
  link: { kind: 'task', id },
});

test('Stopped is the last section, after Found by agents, with its sub line', () => {
  const sections = workSections({
    rows: [
      row('a', 'needs-you'),
      row('b', 'running'),
      row('c', 'up-next'),
      row('d', 'found'),
      row('e', 'stopped'),
    ],
  });
  assert.deepEqual(
    sections.map((section) => section.title),
    ['Needs you', 'Running', 'Up next', 'Found by agents', 'Stopped'],
  );
  assert.equal(
    sections.at(-1)!.sub,
    'Not finished, not waiting on you. Open one to continue it or close it.',
  );
  assert.deepEqual(
    sections.at(-1)!.rows.map((item) => item.id),
    ['e'],
  );
});

test('a section with nothing in it is left out', () => {
  assert.deepEqual(
    workSections({ rows: [row('e', 'stopped')] }).map((section) => section.stage),
    ['stopped'],
  );
});
