import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fixture,
  node,
  values,
  legacyFiles,
  phoneFile,
} from '../../../scripts/mobile-web-cascade.mjs';

test('task pull review occupies one pane and keeps Back to task visible across widths and stylesheet order', () => {
  for (const files of [
    [...legacyFiles, phoneFile],
    [phoneFile, ...legacyFiles.toReversed()],
  ]) {
    for (const width of [375, 639, 640, 1280]) {
      const f = fixture('has-repository');
      f.repository.classes.add('task-pull-workspace');
      f.repository.children = f.repository.children.filter((child) => child !== f.repoNav);
      const layout = node('ph-layout has-detail', f.repoWork);
      const list = node('ph-list', layout);
      const detail = node('ph-detail', layout);
      const back = node('ph-back', detail, 'button');
      assert.equal(values(f.repository, width, files)['grid-template-columns'], 'minmax(0, 1fr)');
      assert.equal(values(f.repository, width, files)['grid-template-rows'], 'minmax(0, 1fr)');
      assert.equal(values(f.repoWork, width, files)['grid-row'], '1');
      assert.equal(values(layout, width, files)['grid-template-columns'], 'minmax(0, 1fr)');
      assert.equal(values(list, width, files).display, 'none');
      assert.equal(values(back, width, files).display, 'inline-flex');
    }
  }
});
