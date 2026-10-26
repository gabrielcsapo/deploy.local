import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTitle } from './task-title.ts';
test('titles use the first line and shorten at complete words without dangling numbers', () => {
  assert.equal(taskTitle('  A short title\nDetails'), 'A short title');
  assert.equal(
    taskTitle('Show elapsed time as HH:MM:SS in 24 hours', 35),
    'Show elapsed time as HH:MM:SS in…',
  );
  assert.equal(taskTitle('A task with 24 more things', 16), 'A task with…');
  assert.equal(taskTitle('Supercalifragilistic', 8), '…');
  assert.equal(taskTitle('hello world', 11), 'hello world');
  assert.equal(taskTitle('hello world again', 12), 'hello world…');
});

test('publish titles repair legacy truncation and preserve editorial titles', async () => {
  const { publishTitle } = await import('./task-title.ts');
  const prompt =
    'Show elapsed time as HH:MM:SS in 24 hour format with a clear label for every task';
  assert.equal(publishTitle(prompt.slice(0, 72), prompt), taskTitle(prompt));
  assert.equal(publishTitle('Show elapsed time as HH:MM:SS in 24', prompt), taskTitle(prompt));
  assert.equal(publishTitle(taskTitle(prompt), prompt), taskTitle(prompt));
  assert.equal(publishTitle('Improve elapsed time labels', prompt), 'Improve elapsed time labels');
  assert.equal(publishTitle('', prompt), taskTitle(prompt));
  assert.equal(publishTitle('A title'), 'A title');
});

test('change titles read as an imperative summary of the request', async () => {
  const { changeTitle } = await import('./task-title.ts');
  assert.equal(
    changeTitle('Make pull requests published from deploy.local tasks read well.'),
    'Make pull requests published from deploy.local tasks read well',
  );
  // Chat openers and politeness describe the conversation, not the change.
  assert.equal(changeTitle('Can you please fix the publish title?'), 'Fix the publish title?');
  assert.equal(changeTitle("Also, let's group the checks."), 'Group the checks');
  assert.equal(changeTitle('**Rename the checks column**'), 'Rename the checks column');
  assert.equal(changeTitle('- add a settings page'), 'Add a settings page');
  // A long request keeps its first whole sentence rather than being cut mid-thought.
  assert.equal(
    changeTitle(
      'Group the published checks by name. Early failures that were later fixed must not read as the result.',
    ),
    'Group the published checks by name',
  );
  assert.equal(
    changeTitle(
      'Group every published check run by its name and computer so that a retried check reads as one result',
    ),
    'Group every published check run by its name and computer so that a…',
  );
  // Filler with nothing behind it still produces the request's own words.
  assert.equal(changeTitle('Please.'), 'Please');
  assert.equal(changeTitle(''), '');
  // The opening request wins over a title cut from it; an editorial title is kept.
  assert.equal(
    changeTitle('Fix the limit…', 'Fix the limit on checkpoints'),
    'Fix the limit on checkpoints',
  );
  assert.equal(
    changeTitle('Checkpoint limits', 'Fix the limit on checkpoints'),
    'Checkpoint limits',
  );
});
