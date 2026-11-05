import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewProjectDialog } from './new-project.client.tsx';

// The dialog's contents are built even while it is closed, so the Projects page builds them on
// the server. Reading window there made React drop the page's server render and start again.
function render(open: boolean) {
  return renderToStaticMarkup(
    createElement(NewProjectDialog, { open, onClose() {}, onCreated() {} }),
  );
}

test('the closed new project dialog renders on the server, where there is no window', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(render(false), '');
});
