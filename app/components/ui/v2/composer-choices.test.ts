import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerModels } from '../../../../shared/v2/contracts';
import { chipLabel, effortLabel, modelGroups } from './composer-choices.ts';
import { menuPosition } from './composer-menu.ts';

test('a chip names up to two choices, then counts them', () => {
  assert.equal(chipLabel([], 'Any free computer', 'computers'), 'Any free computer');
  assert.equal(chipLabel(['SER'], 'Any free computer', 'computers'), 'SER');
  assert.equal(
    chipLabel(['deploy.local', 'tally'], 'No project', 'projects'),
    'deploy.local, tally',
  );
  assert.equal(chipLabel(['a', 'b', 'c'], 'No project', 'projects'), '3 projects');
});

test('effort levels read as words', () => {
  assert.deepEqual(['', 'low', 'xhigh', 'max', 'turbo'].map(effortLabel), [
    'Default',
    'Low',
    'Extra high',
    'Max',
    'Turbo',
  ]);
});

const models: ComputerModels = {
  defaults: {
    'writing-code': 'claude:opus',
    reviewing: 'claude:sonnet',
    'answering-questions': null,
  },
  choices: [
    { id: 'codex:gpt-6', name: 'GPT-6-Sol', provider: 'codex', model: 'gpt-6' },
    { id: 'claude:opus', name: 'Opus', provider: 'claude', model: 'opus' },
    { id: 'claude:sonnet', name: 'Sonnet', provider: 'claude', model: 'sonnet' },
    { id: 'claude:haiku', name: 'Haiku', provider: 'claude', model: 'haiku' },
    { id: 'codex:gpt-5', name: 'GPT-5.5', provider: 'codex', model: 'gpt-5' },
  ],
  providers: [{ id: 'codex', name: 'Codex', computers: [] }],
  local: [],
};

test('the model menu shows the defaults and this chat’s pick; More models holds the rest by provider', () => {
  const { main, more } = modelGroups(models, null);
  assert.deepEqual(
    main.map((choice) => choice.name),
    ['Opus', 'Sonnet'],
  );
  assert.deepEqual(
    more.map((group) => [group.name, group.choices.map((choice) => choice.name)]),
    [
      ['Codex', ['GPT-6-Sol', 'GPT-5.5']],
      ['Claude', ['Haiku']],
    ],
  );
  const picked = modelGroups(models, 'claude:haiku');
  assert.deepEqual(
    picked.main.map((choice) => choice.name),
    ['Opus', 'Sonnet', 'Haiku'],
  );
  assert.deepEqual(modelGroups(null, null), { main: [], more: [] });
});

const viewport = { left: 0, top: 0, width: 1440, height: 900 };
const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
});

test('a menu opens below its control, or above it at the foot of the window', () => {
  // A chip in the middle of the page: below, lined up with its left edge.
  assert.deepEqual(
    menuPosition(box(540, 534, 120, 28), { width: 256, height: 240 }, viewport, 'start'),
    {
      left: 540,
      top: 568,
      maxHeight: 332,
    },
  );
  // The model button at the foot of a task: above, lined up with its right edge.
  const model = menuPosition(box(920, 840, 50, 28), { width: 240, height: 270 }, viewport, 'end');
  assert.equal(model.left, 730);
  assert.equal(model.top, 840 - 6 - 270);
});

test('a submenu sits beside its row, and flips left when the window is narrow', () => {
  const row = box(736, 700, 228, 32);
  assert.equal(menuPosition(row, { width: 220, height: 200 }, viewport, 'side').left, 968);
  const narrow = { ...viewport, width: 700 };
  const small = box(364, 700, 228, 32);
  assert.equal(menuPosition(small, { width: 220, height: 200 }, narrow, 'side').left, 140);
  // Its foot is level with the row's.
  assert.equal(menuPosition(row, { width: 220, height: 200 }, viewport, 'side').top, 537);
});
