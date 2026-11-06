import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('opening a task jumps to the latest message instead of animating from the top', () => {
  for (const file of ['./workspace.css', './conversation-chrome.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const rule of css.match(/\.pw-transcript\s*\{[^}]*\}/g) ?? [])
      assert.doesNotMatch(rule, /scroll-behavior:\s*smooth/, file);
  }
});
