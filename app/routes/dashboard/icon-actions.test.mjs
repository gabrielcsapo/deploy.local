import assert from 'node:assert/strict';
import test from 'node:test';
import { node, values, legacyFiles, phoneFile } from '../../../scripts/mobile-web-cascade.mjs';

const files = [
  ...legacyFiles,
  phoneFile,
  'app/routes/dashboard/task-tree.css',
  'app/routes/dashboard/attachments.css',
];
test('icon actions retain their quiet surface and token sizes across legacy workspace styles', () => {
  for (const order of [files, files.toReversed()]) {
    for (const width of [390, 1440]) {
      for (const [container, extra] of [
        ['pw-activity-header', ''],
        ['task-tree-project', 'task-tree-add'],
        ['pw-viewer-actions', ''],
        ['compact-top-actions', ''],
        ['pw-media-actions', ''],
        ['workspace-rail', ''],
      ]) {
        const shell = node('dashboard-shell', null);
        const root = node('project-workspace', shell, 'div', { 'data-phone': '' });
        const parent = node(container, root);
        const button = node(`ui-icon-button ${extra}`, parent, 'button', {
          'data-size': 'compact',
        });
        const glyph = node('pw-icon', button, 'svg');
        const style = values(button, width, order);
        const context = `${container}, ${width}px, ${order[0]}`;
        assert.equal(style.background, 'transparent', context);
        assert.equal(style.border, '0', context);
        assert.equal(style.padding, '0', context);
        assert.equal(style.width, 'var(--icon-target)', context);
        assert.equal(
          style['--icon-target'],
          width < 640 ? 'var(--ds-size-iconActionTouch)' : 'var(--ds-size-iconActionCompact)',
          context,
        );
        assert.equal(values(glyph, width, order).width, 'var(--icon-glyph)', context);
      }
    }
  }
});
