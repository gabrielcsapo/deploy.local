import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellMode, shellCommandText } from './shell-mode.ts';
import { terminalUnavailable } from './terminal-state.ts';
import { splitPreference, selectedSplitTab } from './task-split-state.ts';
test('shell mode only intercepts a leading ! and trims the command', () => {
  assert.equal(shellMode('! npm test'), true);
  assert.equal(shellCommandText('! npm test\n'), 'npm test');
  assert.equal(shellMode('!'), true);
  assert.equal(shellCommandText('!  '), '');
  for (const input of ['npm test!', ' ! npm test', '', 'Hello!']) {
    assert.equal(shellMode(input), false);
    assert.equal(shellCommandText(input), null);
  }
});
test('task terminal gates old workers, consent, offline and local veto', () => {
  const status = {
    name: 'Mac',
    enabled: true,
    supported: true,
    taskSupported: true,
    online: true,
    locallyDisabled: false,
    recent: [],
  };
  assert.equal(terminalUnavailable(status, true), '');
  assert.match(
    terminalUnavailable({ ...status, taskSupported: false }, true),
    /Update deploy.local on Mac/,
  );
  assert.match(terminalUnavailable({ ...status, enabled: false }, true), /disabled/);
  assert.match(terminalUnavailable({ ...status, online: false }, true), /offline/);
  assert.match(terminalUnavailable({ ...status, locallyDisabled: true }, true), /locally/);
  assert.equal(
    selectedSplitTab(splitPreference({ tabs: { task: 'terminal' } }), 'task'),
    'terminal',
  );
});

test('terminal recovery renders the consent action and ended session retry', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { TerminalRecovery } = await import('./terminal.client.tsx');
  const render = (disabled: boolean, ended: boolean) =>
    renderToStaticMarkup(
      createElement(TerminalRecovery, { disabled, ended, onEnable() {}, onRetry() {} }),
    );
  assert.match(render(true, true), /Enable terminal access/);
  assert.doesNotMatch(render(true, true), /Open a new session/);
  assert.match(render(false, true), /Open a new session/);
  assert.equal(render(false, false), '');
});

test('shell cards render escaped output, exit/duration, truncation and visibility controls', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ShellCommandCard } = await import('./shell-command.client.tsx');
  const html = renderToStaticMarkup(
    createElement(ShellCommandCard, {
      message: {
        id: 'command',
        shell: {
          command: 'npm test',
          computer: 'Mac',
          output: '<script>unsafe</script>',
          status: 'ended',
          code: 3,
          durationMs: 1200,
          reason: 'Shell exited',
          truncated: true,
          agentRunning: true,
          hidden: false,
        },
      },
      onChange() {},
    }),
  );
  assert.match(html, /Exit 3 · 1.2 seconds/);
  assert.match(html, /last 64 KB/);
  assert.match(html, /Hide from agent/);
  assert.match(html, /Agent is running/);
  assert.ok(!html.includes('<script>'));
});
